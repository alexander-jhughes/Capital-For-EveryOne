// Baselines the new recommender must beat. All are trained or defined without looking at validation or test data.
//
// - popularity: per-item label rate in the training examples (smoothed). Ignores the person entirely.
// - rules: the rules-based "Make it yours" (lib/preferences/recommend.ts, unchanged) driven by a documented,
//   BASELINE-ONLY mapping from profile answers (./rules.ts), with each item's training label rate inside and outside
//   the rules' suggestion as its probability.
// - v1 forest: the existing v1 system (lib/personalisation, unchanged): its own feature extraction and trained forest.
//   It sees what v1 could see (settings, view, signal counts), not the new profile answers or history, and it can
//   only score the 8 items it was built for.
// - random: a seeded, deterministic random score.
import { isValidModel, type ModelArtifact } from "../../personalisation/artifact";
import { explicitFingerprint, extractFeatures, type PersonalisationInput, type Signals as V1Signals } from "../../personalisation/features";
import { predictProba } from "../../personalisation/forest";
import { recommendPreferences } from "../../personalisation/infer";
import { INITIAL_STATE, type PersonalisationState } from "../../personalisation/state";
import type { TargetId } from "../../personalisation/targets";
import { conflicts, ITEM_IDS, type ItemId, MAX_BUNDLE_SIZE } from "../catalog";
import { rng } from "../random";
import { eligibleItems, mixSeed } from "../synthetic";
import type { RecommenderInput, TrainingExample } from "../types";
import type { Policy, Scorer } from "./benchmark";
import { rulesItems } from "./rules";

/** v1 target -> v2 catalogue item (from the workstream brief). */
export const V1_TARGET_TO_ITEM: Record<TargetId, ItemId> = {
  largerText: "textSize.125",
  calmLayout: "density.calm",
  visualSummary: "homeFocus.chart",
  stepByStep: "explanations.stepByStep",
  voiceFirst: "voiceFirst.on",
  reducedMotion: "motion.reduced",
  highContrast: "contrast.high",
  paymentsProminent: "homeFocus.bill",
};
const V1_TARGETS = Object.keys(V1_TARGET_TO_ITEM) as TargetId[];
const ITEM_TO_V1 = Object.fromEntries(V1_TARGETS.map((t) => [V1_TARGET_TO_ITEM[t], t])) as Partial<Record<ItemId, TargetId>>;

/** Smoothing strength (pseudo-examples) for the label-rate baselines. */
export const SMOOTHING = 20;

/** Caches per input object: inputs are shared by every item shown in the same round. */
function cached<T>(f: (input: RecommenderInput) => T): (input: RecommenderInput) => T {
  const cache = new WeakMap<RecommenderInput, T>();
  return (input) => {
    let v = cache.get(input);
    if (v === undefined) {
      v = f(input);
      cache.set(input, v);
    }
    return v;
  };
}

/** Per-item label rates, shrunk towards the overall rate. */
export function itemRates(train: readonly TrainingExample[]): Record<ItemId, number> {
  const n = Object.fromEntries(ITEM_IDS.map((id) => [id, 0])) as Record<ItemId, number>;
  const pos = { ...n };
  let all = 0;
  for (const e of train) {
    n[e.item] += e.weight;
    pos[e.item] += e.weight * e.label;
    all += e.weight * e.label;
  }
  const total = Object.values(n).reduce((s, v) => s + v, 0);
  const m = total > 0 ? all / total : 0.5;
  return Object.fromEntries(ITEM_IDS.map((id) => [id, (pos[id] + SMOOTHING * m) / (n[id] + SMOOTHING)])) as Record<ItemId, number>;
}

export function trainPopularity(train: readonly TrainingExample[]): Scorer {
  const rates = itemRates(train);
  return () => ({ ...rates });
}

/** Rules baseline: P(label | item, item in the rules' suggestion or not), estimated on training examples. */
export function trainRules(train: readonly TrainingExample[]): Scorer {
  const base = itemRates(train);
  const inRules = cached((input) => new Set(rulesItems(input.answers)));
  const acc = Object.fromEntries(ITEM_IDS.map((id) => [id, { in: [0, 0], out: [0, 0] }])) as Record<ItemId, { in: [number, number]; out: [number, number] }>;
  for (const e of train) {
    const c = inRules(e.input).has(e.item) ? acc[e.item].in : acc[e.item].out;
    c[0] += e.weight;
    c[1] += e.weight * e.label;
  }
  const rate = (c: [number, number], m: number) => (c[1] + SMOOTHING * m) / (c[0] + SMOOTHING);
  const rIn = Object.fromEntries(ITEM_IDS.map((id) => [id, rate(acc[id].in, base[id])])) as Record<ItemId, number>;
  const rOut = Object.fromEntries(ITEM_IDS.map((id) => [id, rate(acc[id].out, base[id])])) as Record<ItemId, number>;
  return (input) => {
    const set = inRules(input);
    return Object.fromEntries(ITEM_IDS.map((id) => [id, set.has(id) ? rIn[id] : rOut[id]])) as Record<ItemId, number>;
  };
}

/** The rules system as a policy: its items that are eligible, compatible and at most 4. No answers -> no suggestion. */
export const rulesPolicy: Policy = (input) => {
  const eligible = new Set(eligibleItems(input));
  const shown = new Set(input.history.filter((h) => h.outcome === "rejected" || h.outcome === "reverted").map((h) => h.item));
  const out: ItemId[] = [];
  for (const id of rulesItems(input.answers)) if (eligible.has(id) && !shown.has(id) && out.length < MAX_BUNDLE_SIZE && !out.some((o) => conflicts(o, id))) out.push(id);
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// v1 random forest
// ---------------------------------------------------------------------------------------------------------------

/** What v1 can see of a v2 input: settings, view and the six signal counts it knows. No answers, no history. */
export function v1View(input: RecommenderInput): { v1Input: PersonalisationInput; signals: V1Signals } {
  const s = input.signals;
  const signals: V1Signals = {
    textLarger: s.textLarger ?? 0,
    textSmaller: s.textSmaller ?? 0,
    voiceSessions: s.voiceSessions ?? 0,
    lessOnScreen: s.lessOnScreen ?? 0,
    moreDetail: s.moreDetail ?? 0,
    undoneChanges: s.undoneChanges ?? 0,
  };
  return { v1Input: { preferences: input.preferences, view: input.view, choices: null }, signals };
}

export function assertV1Model(model: unknown): ModelArtifact {
  if (!isValidModel(model)) throw new Error("Not a valid v1 model artifact (lib/personalisation/model.json)");
  return model;
}

/** v1 forest probabilities for the 8 items it knows. Other items get no score (v1 cannot suggest them). */
export function v1ForestScorer(model: ModelArtifact): Scorer {
  return cached((input) => {
    const { v1Input, signals } = v1View(input);
    const x = extractFeatures(v1Input, signals);
    const out: Partial<Record<ItemId, number>> = {};
    for (const t of V1_TARGETS) out[V1_TARGET_TO_ITEM[t]] = predictProba(model.targets[t].trees, x);
    return out;
  });
}

/**
 * The v1 system end to end (recommendPreferences: consent, thresholds, conflicts, overlaps, explainability), with its
 * "no thanks" memory rebuilt from the v2 history, restricted to items the v2 product policy allows.
 */
export function v1Policy(model: ModelArtifact): Policy {
  return (input) => {
    const { v1Input, signals } = v1View(input);
    const fingerprint = explicitFingerprint(extractFeatures(v1Input, signals));
    const rejected: PersonalisationState["rejected"] = {};
    for (const h of input.history) {
      const t = ITEM_TO_V1[h.item];
      if (t && (h.outcome === "rejected" || h.outcome === "reverted")) rejected[t] = { count: Math.min((rejected[t]?.count ?? 0) + 1, 2), fingerprint };
    }
    const state: PersonalisationState = { ...INITIAL_STATE, consent: "granted", signals, rejected };
    const res = recommendPreferences(v1Input, state, model);
    const eligible = new Set(eligibleItems(input));
    return res.preferences.map((p) => V1_TARGET_TO_ITEM[p.target]).filter((id) => eligible.has(id));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Deterministic: the same input always gets the same random scores. */
export function randomScorer(seed: number): Scorer {
  return cached((input) => {
    const r = rng(mixSeed(seed, hashString(JSON.stringify(input))));
    return Object.fromEntries(ITEM_IDS.map((id) => [id, r()])) as Record<ItemId, number>;
  });
}
