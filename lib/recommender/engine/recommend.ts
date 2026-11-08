// The policy layer. Product rules, deliberately separate from the learned scores (score.ts):
//   eligibility    never an item on a dimension the person set themselves, never one already in effect, never one
//                  that contradicts an explicit setting
//   feedback       an item turned down or undone in the last 90 days, or twice ever, is not offered again;
//                  "Not now" pauses an item for 7 days; after 3+ turn-downs in 30 days with nothing kept
//                  ("fatigue") only very confident suggestions (p ≥ 0.85) are made
//   thresholds     per-item thresholds chosen on validation data; an item without one is never suggested
//   evidence       how many similar people stand behind a score; too few and it is withheld
// Every item that is not suggested is listed with its reason.
import { CATALOG, conflicts as conflictsWith, isActive, ITEM_IDS, type ItemId, nonDefaultDimensions } from "../catalog";
import type { EvidenceLevel, HistoryEntry, ItemScore, Reason, RecommendationResult, RecommenderInput, RecommendOptions, Warning, WithheldReason } from "../types";
import { type Candidate, chooseConfigurations, contradicts, toConfiguration } from "./bundle";
import { configurationExplanation, itemReasons, NO_SUGGESTION_TEXT } from "./explain";
import { type NormalisedInput, normaliseInput } from "./features";
import { roundTo, sigmoid } from "./math";
import type { RecommenderModel } from "./model";
import { computeRaw, isUsableModel, prepare, type PreparedModel, type RawScores } from "./score";

const DAY = 24 * 60 * 60 * 1000;

export const POLICY = {
  rejectionWindowDays: 90,
  maxRejections: 2,
  dismissCooldownDays: 7,
  fatigueWindowDays: 30,
  fatigueRejections: 3,
  fatigueFloor: 0.85,
  evidence: { strong: 150, moderate: 50, limited: 15 },
  fewAnswers: 3,
  lowConfidence: 0.7,
} as const;

export function evidenceLevel(support: number): EvidenceLevel {
  const e = POLICY.evidence;
  return support >= e.strong ? "strong" : support >= e.moderate ? "moderate" : support >= e.limited ? "limited" : "insufficient";
}

/** Items in effect now. Without a known view, the view items count as not in effect. */
function activeItems(n: NormalisedInput): ItemId[] {
  return ITEM_IDS.filter((id) => (CATALOG[id].dimension === "view" ? n.view !== null && isActive(id, n.preferences, n.view) : isActive(id, n.preferences, "simple")));
}

const isNegative = (h: HistoryEntry) => h.outcome === "rejected" || h.outcome === "reverted";

/** 3+ turn-downs in the last 30 days and nothing kept in that time. */
export function isFatigued(history: readonly HistoryEntry[], now: number): boolean {
  const recent = history.filter((h) => now - h.at < POLICY.fatigueWindowDays * DAY);
  return recent.filter(isNegative).length >= POLICY.fatigueRejections && !recent.some((h) => h.outcome === "accepted");
}

/** The hard policy reason an item can't be suggested at all, or null if it is eligible. */
function policyReason(id: ItemId, n: NormalisedInput, active: readonly ItemId[], explicitDims: ReadonlySet<string>, now: number): WithheldReason | null {
  const dim = CATALOG[id].dimension;
  if (n.explicit.has(dim)) return "explicit";
  if (active.includes(id)) return "already_on";
  // A non-default value was set on purpose (by the person, or a suggestion they kept): it counts as explicit.
  if (explicitDims.has(dim)) return "explicit";
  for (const a of active) {
    const other = CATALOG[a].dimension;
    if (other !== dim && explicitDims.has(other) && conflictsWith(id, a)) return "conflict";
  }
  const own = n.history.filter((h) => h.item === id);
  const negatives = own.filter(isNegative);
  if (negatives.length >= POLICY.maxRejections || negatives.some((h) => now - h.at < POLICY.rejectionWindowDays * DAY)) return "rejected";
  if (own.some((h) => h.outcome === "dismissed" && now - h.at < POLICY.dismissCooldownDays * DAY)) return "cooldown";
  return null;
}

function itemScore(model: RecommenderModel, p: PreparedModel, raw: RawScores, i: number): ItemScore {
  const support = raw.support[i];
  return {
    item: ITEM_IDS[i],
    probability: roundTo(raw.probability[i], 4),
    evidence: evidenceLevel(support),
    support: roundTo(support, 1),
    components: {
      content: roundTo(sigmoid(raw.content[i]), 4),
      collaborative: roundTo(raw.collaborative[i], 4),
      factorization: roundTo(sigmoid(raw.factorization[i]), 4),
      prior: roundTo(p.prior[i], 4),
    },
    reasons: itemReasons(model, p, raw, i),
  };
}

const byProbability = (a: ItemScore, b: ItemScore) => b.probability - a.probability || ITEM_IDS.indexOf(a.item) - ITEM_IDS.indexOf(b.item);

/** Calibrated scores for all items, best first, without any eligibility filtering. Throws on an invalid model. */
export function scoreItems(model: RecommenderModel, input: RecommenderInput): ItemScore[] {
  if (!isUsableModel(model)) throw new Error("scoreItems: invalid recommender model");
  const p = prepare(model);
  const raw = computeRaw(p, normaliseInput(input));
  return ITEM_IDS.map((_, i) => itemScore(model, p, raw, i)).sort(byProbability);
}

const WARNING_TEXT: Record<Warning["code"], string> = {
  synthetic_only: "Dial learned this from made-up practice data, not from real people yet.",
  few_answers: "You've answered fewer than 3 questions in About you, so suggestions are less personal.",
  limited_evidence: "Only limited evidence stands behind this suggestion.",
  low_confidence: "Dial isn't very sure about this one.",
  fatigue: "You've turned down several suggestions recently, so Dial will only suggest something it's very sure about.",
  model_unavailable: "Suggestions aren't available right now.",
};
const warning = (code: Warning["code"]): Warning => ({ code, text: WARNING_TEXT[code] });

function unavailable(model: RecommenderModel | null): RecommendationResult {
  return {
    status: "unavailable",
    modelVersion: model?.version ?? null,
    trainedOn: model?.trainedOn ?? null,
    configuration: null,
    alternatives: [],
    scores: [],
    explanation: { summary: NO_SUGGESTION_TEXT.unavailable, reasons: [] },
    warnings: [warning("model_unavailable")],
    withheld: [],
  };
}

/** One recommendation: a configuration (or none), alternatives, scores, explanation, warnings and what was withheld. */
export function recommend(model: RecommenderModel, input: RecommenderInput, options: RecommendOptions = {}): RecommendationResult {
  if (!isUsableModel(model)) return unavailable(null);
  try {
    const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
    const wanted = typeof options.alternatives === "number" && Number.isFinite(options.alternatives) ? Math.max(0, Math.min(5, Math.floor(options.alternatives))) : 2;
    const n = normaliseInput(input);
    const p = prepare(model);
    const raw = computeRaw(p, n);
    const active = activeItems(n);
    const explicitDims = new Set<string>([...n.explicit, ...nonDefaultDimensions(n.preferences)]);
    const fatigue = isFatigued(n.history, now);

    const withheld: RecommendationResult["withheld"] = [];
    const eligible: ItemScore[] = [];
    const candidates: Candidate[] = [];
    const reasons = new Map<ItemId, Reason[]>();
    ITEM_IDS.forEach((id, i) => {
      const hard = policyReason(id, n, active, explicitDims, now);
      if (hard) {
        withheld.push({ item: id, reason: hard });
        return;
      }
      const s = itemScore(model, p, raw, i);
      eligible.push(s);
      reasons.set(id, s.reasons);
      const threshold = model.thresholds[i];
      if (threshold === null) withheld.push({ item: id, reason: "below_threshold" });
      else if (s.evidence === "insufficient") withheld.push({ item: id, reason: "insufficient_evidence" });
      else if (s.probability < (fatigue ? Math.max(threshold, POLICY.fatigueFloor) : threshold)) withheld.push({ item: id, reason: "below_threshold" });
      else candidates.push({ item: id, probability: s.probability, threshold, evidence: s.evidence });
    });

    const { best, alternatives } = chooseConfigurations(candidates, active, wanted);
    // Above threshold but not part of the chosen configuration because it contradicts it, or can't be combined
    // with what is in effect now.
    for (const c of candidates) {
      if (best?.items.includes(c.item)) continue;
      if (!best || contradicts(c.item, best.items, active)) withheld.push({ item: c.item, reason: "conflict" });
    }

    const byItem = new Map(candidates.map((c) => [c.item, c]));
    const configuration = best ? toConfiguration(best, byItem) : null;
    const status: RecommendationResult["status"] = configuration
      ? "ok"
      : eligible.length > 0 && eligible.every((s) => s.evidence === "insufficient")
        ? "insufficient_data"
        : "no_recommendation";

    const warnings: Warning[] = [];
    if (model.trainedOn === "synthetic") warnings.push(warning("synthetic_only"));
    if (n.answered < POLICY.fewAnswers) warnings.push(warning("few_answers"));
    if (configuration?.evidence === "limited") warnings.push(warning("limited_evidence"));
    if (configuration && configuration.confidence < POLICY.lowConfidence) warnings.push(warning("low_confidence"));
    if (fatigue) warnings.push(warning("fatigue"));

    const explanation = configuration
      ? configurationExplanation(model, configuration.title, configuration.items, reasons)
      : { summary: NO_SUGGESTION_TEXT[status as "insufficient_data" | "no_recommendation"], reasons: [] };

    return {
      status,
      modelVersion: model.version,
      trainedOn: model.trainedOn,
      configuration,
      alternatives: alternatives.map((a) => toConfiguration(a, byItem)),
      scores: eligible.sort(byProbability),
      explanation,
      warnings,
      withheld: withheld.sort((a, b) => ITEM_IDS.indexOf(a.item) - ITEM_IDS.indexOf(b.item)),
    };
  } catch {
    return unavailable(model);
  }
}
