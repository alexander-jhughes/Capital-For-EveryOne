// Background inference: explicit settings + consented action counts in, at most a few suggestions out.
// Pure and synchronous (well under a millisecond). Never throws, never applies anything, never calls a server.
// The frontend shows a suggestion as a Dial offer and previews it only if the person says yes.
import { isValidModel, type ModelArtifact } from "./artifact";
import { explicitFingerprint, extractFeatures, featureIndex, FEATURES, hasInformativeFeatures, type PersonalisationInput } from "./features";
import { contributions, predictProba } from "./forest";
import { INITIAL_STATE, isPaused, type PersonalisationState, REJECTION_LIMIT, sanitizeState } from "./state";
import { type LayoutStyle, type SuggestedAction, TARGET_IDS, type TargetId, TARGETS, targetStatus } from "./targets";

export interface PreferenceRecommendation {
  target: TargetId;
  /** Short name, e.g. "Larger text". */
  title: string;
  /** Dial's question for this one suggestion. */
  offer: string;
  /** Allowlisted `UiAction`-shaped changes, ready for PreferencesProvider.startPreview(). */
  actions: SuggestedAction[];
  /** Model probability that the person keeps this setting, 0-1, rounded to 2 decimals. Passed the target's threshold before rounding. */
  confidence: number;
  /** Plain-English reasons, each about something the person explicitly did. Never empty. */
  reasons: string[];
}

export type WithheldReason =
  | "already_on"
  | "not_supported"
  /** The model was not reliable enough for this setting in evaluation, so it is never suggested. */
  | "not_reliable"
  | "low_confidence"
  | "conflicting_signals"
  | "previously_rejected"
  | "recently_ignored"
  /** Nothing the person did explains it, so we don't suggest it. */
  | "no_explanation"
  | "invalid_output"
  /** Another suggestion that changes the same part of the screen was more confident. */
  | "overlaps_other"
  /** A different suggestion was already shown this visit, or the person already answered one (controller.forVisit). */
  | "one_per_visit";

export type PersonalisationStatus =
  | "ok"
  | "no_recommendation"
  /** The person hasn't been asked yet: offer the opt-in, never predict. */
  | "needs_consent"
  | "disabled"
  /** The person said "No thanks" BACKOFF_AFTER times in a row: nothing is suggested until they change a setting themselves. */
  | "paused"
  /** Nothing chosen beyond the defaults: nothing to learn from. */
  | "insufficient_data"
  /** Model missing, invalid or failed: the app carries on exactly as without it. */
  | "unavailable";

export interface PersonalisationResult {
  status: PersonalisationStatus;
  /** The overall style the suggestions point to, matching "Make it yours" style ids, or null. */
  recommendedLayout: LayoutStyle | null;
  /** Suggestions, most confident first. Empty unless status is "ok". */
  preferences: PreferenceRecommendation[];
  /** Highest suggestion confidence, or null. */
  confidence: number | null;
  /** Reasons for the top suggestion. */
  reasons: string[];
  /** One question Dial can ask for the whole set, e.g. "Would you like me to make your dashboard easier to read?". */
  offer: string | null;
  /** Everything not suggested and why: for tests, debugging and a "why not?" panel. */
  withheld: { target: TargetId; reason: WithheldReason }[];
  /** Pass back to recordOutcome() when the person answers. */
  fingerprint: string | null;
  modelVersion: string | null;
  /** Always "synthetic" for now, so the UI can say so. */
  trainedOn: "synthetic" | null;
}

export interface InferenceOptions {
  /** Most suggestions returned at once. Default 3. */
  maxSuggestions?: number;
  /** Extra confidence floor on top of each target's trained threshold. Default 0.6. */
  minConfidence?: number;
}

/** Contributions smaller than this are noise, not a reason. */
const MIN_REASON_CONTRIBUTION = 0.01;
const MAX_REASONS = 3;

/** Pairs of explicit signals that point in opposite directions, and the suggestions they make unsafe. */
const CONFLICTS: { when: (x: number[]) => boolean; affects: TargetId[] }[] = [
  { when: (x) => x[featureIndex("choice_lessInfo")] === 1 && x[featureIndex("choice_moreDetail")] === 1, affects: ["calmLayout", "visualSummary"] },
  { when: (x) => x[featureIndex("sig_lessOnScreen")] >= 2 && x[featureIndex("sig_moreDetail")] >= 2, affects: ["calmLayout", "visualSummary"] },
  { when: (x) => x[featureIndex("sig_textLarger")] >= 2 && x[featureIndex("sig_textSmaller")] >= 2, affects: ["largerText"] },
];

/** Suggestions that change the same part of the screen: only the more confident one is offered. */
const OVERLAPS: [TargetId, TargetId][] = [["calmLayout", "visualSummary"]];

/** Models already checked by isValidModel(), so the full structural check runs once per loaded model, not per call. */
const validated = new WeakSet<object>();
const usable = (m: ModelArtifact | null | undefined): m is ModelArtifact => {
  if (!m || typeof m !== "object") return false;
  if (validated.has(m)) return true;
  if (!isValidModel(m)) return false;
  validated.add(m);
  return true;
};

const empty = (status: PersonalisationStatus, model: ModelArtifact | null = null): PersonalisationResult => ({
  status,
  recommendedLayout: null,
  preferences: [],
  confidence: null,
  reasons: [],
  offer: null,
  withheld: [],
  fingerprint: null,
  modelVersion: model?.modelVersion ?? null,
  trainedOn: model ? "synthetic" : null,
});

function explain(target: TargetId, model: ModelArtifact, x: number[]): string[] {
  const { byFeature } = contributions(model.targets[target].trees, x);
  return byFeature
    .map((c, i) => ({ c, text: c > MIN_REASON_CONTRIBUTION ? FEATURES[i].describe(x[i]) : null }))
    .filter((r): r is { c: number; text: string } => r.text !== null)
    .sort((a, b) => b.c - a.c)
    .slice(0, MAX_REASONS)
    .map((r) => r.text);
}

function combinedOffer(recs: PreferenceRecommendation[]): string | null {
  if (recs.length === 0) return null;
  if (recs.length === 1) return recs[0].offer;
  if (recs.every((r) => TARGETS[r.target].readability)) return "Would you like me to make your dashboard easier to read?";
  return `I have ${recs.length} ideas that might make Dial easier for you. Would you like to hear them?`;
}

/**
 * Predicts which presentation settings the person may like, from what they explicitly chose.
 * Returns no suggestion when it isn't confident, when it can't explain why, or when the person said no before.
 */
export function recommendPreferences(
  input: PersonalisationInput,
  stateInput: PersonalisationState | null | undefined,
  model: ModelArtifact | null | undefined,
  options: InferenceOptions = {},
): PersonalisationResult {
  try {
    const state = sanitizeState(stateInput ?? INITIAL_STATE);
    if (state.consent === "unset") return empty("needs_consent");
    if (state.consent !== "granted") return empty("disabled");
    if (!usable(model)) return empty("unavailable");
    if (isPaused(state)) return empty("paused", model);

    const prefs = input?.preferences;
    if (typeof prefs !== "object" || prefs === null) return empty("insufficient_data", model);
    const x = extractFeatures(input, state.signals);
    if (!hasInformativeFeatures(x)) return empty("insufficient_data", model);

    const fingerprint = explicitFingerprint(x);
    const conflicted = new Set(CONFLICTS.filter((c) => c.when(x)).flatMap((c) => c.affects));
    const floor = options.minConfidence ?? 0.6;
    const withheld: PersonalisationResult["withheld"] = [];
    let candidates: PreferenceRecommendation[] = [];

    for (const target of TARGET_IDS) {
      const hold = (reason: WithheldReason) => withheld.push({ target, reason });
      const status = targetStatus(target, prefs);
      if (status === "on") hold("already_on");
      else if (status === "unsupported") hold("not_supported");
      else if (model.targets[target].threshold === null) hold("not_reliable");
      else if ((state.rejected[target]?.count ?? 0) >= REJECTION_LIMIT || state.rejected[target]?.fingerprint === fingerprint) hold("previously_rejected");
      else if (state.ignored[target] === fingerprint) hold("recently_ignored");
      else if (conflicted.has(target)) hold("conflicting_signals");
      else {
        const p = predictProba(model.targets[target].trees, x);
        if (!Number.isFinite(p) || p < 0 || p > 1) hold("invalid_output");
        else if (p < Math.max(model.targets[target].threshold!, floor)) hold("low_confidence");
        else {
          const reasons = explain(target, model, x);
          if (reasons.length === 0) hold("no_explanation");
          else {
            const def = TARGETS[target];
            candidates.push({ target, title: def.title, offer: def.offer, actions: def.actions.map((x) => ({ ...x })), confidence: Math.round(p * 100) / 100, reasons });
          }
        }
      }
    }

    for (const [a, b] of OVERLAPS) {
      const ra = candidates.find((c) => c.target === a);
      const rb = candidates.find((c) => c.target === b);
      if (ra && rb) {
        const loser = ra.confidence >= rb.confidence ? rb : ra;
        candidates = candidates.filter((c) => c !== loser);
        withheld.push({ target: loser.target, reason: "overlaps_other" });
      }
    }

    const preferences = candidates.sort((a, b) => b.confidence - a.confidence).slice(0, Math.max(1, options.maxSuggestions ?? 3));
    const layoutRec = preferences.find((r) => TARGETS[r.target].layout);
    return {
      status: preferences.length ? "ok" : "no_recommendation",
      recommendedLayout: layoutRec ? TARGETS[layoutRec.target].layout! : null,
      preferences,
      confidence: preferences[0]?.confidence ?? null,
      reasons: preferences[0]?.reasons ?? [],
      offer: combinedOffer(preferences),
      withheld,
      fingerprint,
      modelVersion: model.modelVersion,
      trainedOn: "synthetic",
    };
  } catch {
    return empty("unavailable");
  }
}
