// SYNTHETIC WORLD for Dial personalisation v2. No real person's data is used anywhere in this file.
//
// Every relationship below (which hidden trait drives which answer, setting, signal and benefit) was WRITTEN BY US.
// A model that scores well on this world has recovered structure we put in. That shows the pipeline works and that
// the model can learn this kind of structure; it does NOT show that the model helps real people.
// Every formula is documented in docs/ml-personalisation/v2/SYNTHETIC-DATA.md.
//
// One synthetic person:
//   hidden traits (correlated through 3 latent factors)
//     -> observed "About you" answers (noisy, often skipped, sometimes inconsistent)
//     -> current settings, explicit dimensions, view, signal counts
//     -> a hidden true benefit (utility) for every catalogue item
//   then 1-4 suggestion rounds under a biased logging policy (rules / popularity / exploration):
//     shown items -> kept or turned down (status-quo, novelty, fatigue and position biases)
//                 -> kept items may be undone later, more often when they did not help
//                 -> optional "Did this make Dial easier to use?" rating
//                 -> labels exactly as in CONTRACT.md §8.
// The age band is research data for fairness evaluation only. It is derived downstream of the traits, so labels never
// depend on it, and it never appears in a RecommenderInput or TrainingExample (tested).
import { rulesItems } from "./evaluation/rules";
import { applyActions, DEFAULT_PREFS, type Preferences, sanitize, type UiAction } from "../preferences/schema";
import type { Mode } from "../types";
import { CATALOG, conflicts, DIMENSIONS, type Dimension, isActive, ITEM_IDS, type ItemId, MAX_BUNDLE_SIZE, nonDefaultDimensions } from "./catalog";
import { AGE_BANDS, type AgeBand, type ProfileAnswers, QUESTIONS, type QuestionId } from "./profile";
import { normal, rng, sigmoid, weightedIndex } from "./random";
import { type FeedbackOutcome, type HistoryEntry, type RecommenderInput, SIGNAL_CAP, SIGNAL_IDS, type SignalId, type Signals, type TrainingExample } from "./types";

export const SYNTHETIC_GENERATOR_VERSION = 2;

export interface WorldOptions {
  seed: number;
  people: number;
}
export const DEFAULT_WORLD: WorldOptions = { seed: 20261108, people: 20000 };

// ---------------------------------------------------------------------------------------------------------------
// Hidden traits
// ---------------------------------------------------------------------------------------------------------------

export const FACTORS = ["access", "experience", "appetite"] as const;
export type Factor = (typeof FACTORS)[number];

export const TRAITS = [
  "readingEffort", // how much effort reading small, dense text takes
  "busyTolerance", // tolerance for busy screens (high: likes everything at once; low: wants little on screen)
  "visual", // prefers charts and pictures over words
  "voice", // prefers talking over tapping
  "guidance", // wants to be guided step by step
  "confidence", // financial confidence
  "motionSensitivity", // finds animation distracting
  "tapPrecision", // taps small targets accurately (low: bigger buttons help)
  "focusPayments", // wants upcoming payments first
  "focusSpending", // wants to see where money goes
  "focusBudget", // wants to see progress against a budget
  "focusRecent", // wants recent transactions first
] as const;
export type Trait = (typeof TRAITS)[number];
export type Traits = Record<Trait, number>;

/**
 * trait = Σ loading·factor + sqrt(1 − Σ loading²)·noise, all standard normal, so each trait is N(0, 1) and
 * corr(trait a, trait b) = Σ_f loading_a,f · loading_b,f. Correlations come from shared factors, not one trait per item.
 */
export const TRAIT_LOADINGS: Record<Trait, Partial<Record<Factor, number>>> = {
  readingEffort: { access: 0.75 },
  busyTolerance: { appetite: 0.75, access: -0.25, experience: 0.2 },
  visual: { appetite: 0.3 },
  voice: { access: 0.4, experience: -0.2 },
  guidance: { experience: -0.6, access: 0.2 },
  confidence: { experience: 0.8 },
  motionSensitivity: { access: 0.5 },
  tapPrecision: { access: -0.6 },
  focusPayments: { experience: -0.3 },
  focusSpending: { appetite: 0.3 },
  focusBudget: { experience: 0.2 },
  focusRecent: { appetite: 0.4 },
};

// ---------------------------------------------------------------------------------------------------------------
// Parameters (every number used below; documented in SYNTHETIC-DATA.md)
// ---------------------------------------------------------------------------------------------------------------

export const PARAMS = {
  /** Share of people who answer no "About you" question at all (cold start). */
  answerNothing: 0.2,
  /** Of the people who answer, the share who stop partway, after 1 to 4 answers. */
  stopPartway: 0.15,
  /** Per-person skip probability for each question, uniform in this range. */
  skipRange: [0.25, 0.4] as const,
  /** Share of given preference answers replaced by a different option (inconsistent with the traits). */
  inconsistent: 0.1,
  /** Noise added to the trait before an answer is read off it. */
  answerNoise: 0.5,
  /** Idiosyncratic person-item benefit noise (fixed per person and item). */
  itemNoise: 0.35,
  /** keep logit = A·utility + B0 + novelty·0.5^roundsSeen − fatigue·rejectedRounds − position·rank + N(0, exposureNoise). */
  keep: { A: 1.6, B0: -0.35, novelty: 0.5, fatigue: 0.3, position: 0.15, exposureNoise: 0.6 },
  /** P(undo | kept) = sigmoid(revertSlope·utility + revertBias). */
  revert: { slope: -2.2, bias: -1.6, viaUndo: 0.65 },
  /** Share of answered rounds (≥ 1 item kept) that also get a satisfaction rating, and its cut points. */
  rating: { respond: 0.35, noise: 0.4, unhelpfulBelow: -0.2, helpfulAbove: 0.4 },
  /** P("Not now") = dismissBase + dismissFatigue·min(rejectedRounds, 4). */
  dismiss: { base: 0.1, fatigue: 0.05 },
  /** Logging policy mixture per round. */
  policy: { rules: 0.5, popularity: 0.3, uniform: 0.2 },
  /** Number of logged rounds: 1, 2, 3 or 4 with these weights. */
  rounds: [0.4, 0.3, 0.2, 0.1],
  /** Configuration size for the popularity and exploration policies: 1, 2 or 3 items. */
  configSize: [0.45, 0.35, 0.2],
  /** Days between rounds: daysMin + U[0, daysSpread). */
  daysMin: 7,
  daysSpread: 28,
  /** Age-band score = 0.06·readingEffort − 0.04·tapPrecision + sqrt(1 − var)·noise; cut at these N(0,1) quantiles. */
  age: { readingEffort: 0.06, tapPrecision: -0.04, cuts: [-1.175, -0.468, 0.202, 0.915] },
} as const;

/** Hand-set prior used by the popularity logging policy (how often an item is offered, not how good it is). */
export const POPULARITY_PRIOR: Record<ItemId, number> = {
  "view.simple": 2,
  "view.detailed": 1.5,
  "density.calm": 3,
  "textSize.125": 3,
  "textSize.150": 0.5,
  "contrast.high": 1.5,
  "spacing.roomy": 1.5,
  "motion.reduced": 1,
  "targets.large": 1.5,
  "explanations.stepByStep": 2,
  "voiceFirst.on": 1,
  "homeFocus.bill": 3,
  "homeFocus.chart": 2,
  "homeFocus.budget": 1.5,
  "homeFocus.recent": 1,
  "homeFocus.insights": 1,
};

/** Base time for synthetic timestamps: 2026-01-05T00:00:00Z. */
export const SYNTHETIC_EPOCH = Date.UTC(2026, 0, 5);
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

export type LoggingPolicy = "rules" | "popularity" | "uniform";

export interface HiddenState {
  traits: Traits;
  screenReader: boolean;
  /** Idiosyncratic benefit per item, fixed for the person. */
  itemNoise: Record<ItemId, number>;
  /** Multiplier on signal rates (how much the person uses the app). */
  activity: number;
  /** How likely the person is to change settings themselves (0..1). */
  engagement: number;
}

export interface SyntheticRound {
  at: number;
  policy: LoggingPolicy;
  items: ItemId[];
  outcome: FeedbackOutcome;
  /** "Did this make Dial easier to use?", if answered. */
  rating: -1 | 0 | 1 | null;
}

export interface SyntheticPerson {
  index: number;
  /** Opaque, unique within this world only. */
  subject: string;
  hidden: HiddenState;
  /** Research data: FAIRNESS EVALUATION ONLY. Never part of any RecommenderInput or TrainingExample. */
  research: { ageBand: AgeBand };
  answers: ProfileAnswers;
  /** Questions whose given answer was deliberately made inconsistent with the traits. */
  inconsistent: QuestionId[];
  rounds: SyntheticRound[];
  /** Range of this person's examples in `World.logged` / `World.examples`. */
  examples: { start: number; end: number };
  /** The snapshot used for oracle evaluation: the context at the start of round `round` (round = rounds.length: after all). */
  evaluation: { input: RecommenderInput; round: number; now: number };
}

/** One logged label plus the hidden truth behind it (for evaluation only; models only ever see `example`). */
export interface LoggedExample {
  example: TrainingExample;
  person: number;
  round: number;
  /** Rank of the item in the shown configuration (0 = first). */
  position: number;
  at: number;
  policy: LoggingPolicy;
  /** What happened to this item: turned down at the offer, kept, or kept and later undone. */
  outcome: "rejected" | "kept" | "reverted";
  ratedUnhelpful: boolean;
  utility: number;
  /** Noise-free keep probability at that exposure (includes position bias). */
  keepProbability: number;
}

export interface World {
  generatorVersion: number;
  options: WorldOptions;
  people: SyntheticPerson[];
  /** Same order as `examples`; `logged[i].example === examples[i]`. */
  logged: LoggedExample[];
  examples: TrainingExample[];
  /** Rounds answered "Not now" (no examples). */
  dismissedRounds: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** 32-bit hash of two integers (so person i has the same stream whatever the world size). */
export function mixSeed(a: number, b: number): number {
  let h = Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b >>> 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const softplus = (x: number) => (x > 30 ? x : Math.log1p(Math.exp(x)));

function poisson(r: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let prod = r();
  while (prod > limit && k < 50) {
    k++;
    prod *= r();
  }
  return k;
}

const ordinal = <V extends string>(z: number, low: number, high: number, values: readonly [V, V, V]): V => (z < low ? values[0] : z > high ? values[2] : values[1]);

// ---------------------------------------------------------------------------------------------------------------
// Ground truth: benefit and keep probability. Pure functions of the hidden state and the visible context.
// ---------------------------------------------------------------------------------------------------------------

/** Linear part of each item's true benefit (before the person-item noise). Can be negative: the change would hurt. */
export function baseUtility(item: ItemId, t: Traits, screenReader: boolean, view: Mode): number {
  const sr = screenReader ? 1 : 0;
  switch (item) {
    case "view.simple":
      return 0.25 - 0.8 * t.busyTolerance - 0.25 * t.confidence + 0.2 * t.guidance + 0.3 * sr;
    case "view.detailed":
      return -0.35 + 0.9 * t.busyTolerance + 0.3 * t.confidence - 0.2 * t.guidance;
    case "density.calm": {
      const u = -0.15 - 0.8 * t.busyTolerance + 0.2 * t.guidance + 0.4 * sr;
      // Simple view already shows only three sections, so a calm home screen changes little there.
      return view === "simple" ? 0.4 * u : u;
    }
    case "textSize.125":
      return -0.45 + 0.85 * t.readingEffort - 0.15 * sr;
    case "textSize.150":
      return -1.3 + 0.85 * t.readingEffort;
    case "contrast.high":
      return -0.6 + 0.65 * t.readingEffort;
    case "spacing.roomy":
      return -0.4 + 0.35 * t.readingEffort - 0.35 * t.busyTolerance - 0.25 * t.tapPrecision;
    case "motion.reduced":
      return -0.5 + 0.85 * t.motionSensitivity;
    case "targets.large":
      return -0.45 - 0.8 * t.tapPrecision + 0.15 * t.readingEffort;
    case "explanations.stepByStep":
      return -0.3 + 0.75 * t.guidance - 0.3 * t.confidence;
    case "voiceFirst.on":
      return -0.7 + 0.9 * t.voice + 0.6 * sr;
    case "homeFocus.bill":
      return -0.2 + 0.7 * t.focusPayments - 0.15 * t.confidence;
    case "homeFocus.chart":
      return -0.45 + 0.5 * t.visual + 0.45 * t.focusSpending - 0.6 * sr;
    case "homeFocus.budget":
      return -0.35 + 0.65 * t.focusBudget + 0.2 * t.visual;
    case "homeFocus.recent":
      return -0.45 + 0.6 * t.focusRecent + 0.25 * t.busyTolerance;
    case "homeFocus.insights":
      return -0.4 + 0.4 * t.guidance + 0.35 * t.focusSpending - 0.2 * t.confidence;
  }
}

/** The hidden true usability benefit of an item for this person in this context. */
export function trueUtility(person: Pick<SyntheticPerson, "hidden">, item: ItemId, input: Pick<RecommenderInput, "view">): number {
  const h = person.hidden;
  return baseUtility(item, h.traits, h.screenReader, input.view) + h.itemNoise[item];
}

/** Rounds seen so far and rounds in which everything shown was turned down, read from the visible history. */
export function historyStats(history: readonly HistoryEntry[]): { roundsSeen: number; rejectedRounds: number } {
  const byRound = new Map<number, HistoryEntry[]>();
  for (const e of history) {
    const list = byRound.get(e.at);
    if (list) list.push(e);
    else byRound.set(e.at, [e]);
  }
  let rejectedRounds = 0;
  for (const list of byRound.values()) if (list.every((e) => e.outcome === "rejected")) rejectedRounds++;
  return { roundsSeen: byRound.size, rejectedRounds };
}

/** Keep logit without the per-exposure noise. */
export function keepLogit(utility: number, input: Pick<RecommenderInput, "history">, position = 0): number {
  const k = PARAMS.keep;
  const { roundsSeen, rejectedRounds } = historyStats(input.history);
  return k.A * utility + k.B0 + k.novelty * 0.5 ** roundsSeen - k.fatigue * rejectedRounds - k.position * position;
}

/**
 * Noise-free probability that the person keeps the item if shown (first in the suggestion by default).
 * The per-exposure noise is symmetric around zero, so "probability > 0.5" means the same with or without it.
 */
export function trueKeepProbability(person: Pick<SyntheticPerson, "hidden">, item: ItemId, input: RecommenderInput, position = 0): number {
  return sigmoid(keepLogit(trueUtility(person, item, input), input, position));
}

/** Product policy: never suggest an item already in effect, on a dimension set explicitly, or against an explicit conflicting setting. */
export function eligibleItems(input: Pick<RecommenderInput, "preferences" | "view" | "explicit">): ItemId[] {
  const explicit = new Set(input.explicit);
  return ITEM_IDS.filter((id) => {
    if (isActive(id, input.preferences, input.view) || explicit.has(CATALOG[id].dimension)) return false;
    // "Never suggested alongside an explicit setting on the other side" of a listed conflict.
    return !ITEM_IDS.some((other) => other !== id && CATALOG[other].dimension !== CATALOG[id].dimension && conflicts(id, other) && explicit.has(CATALOG[other].dimension) && isActive(other, input.preferences, input.view));
  });
}

export interface OracleItem {
  item: ItemId;
  utility: number;
  keepProbability: number;
  /** Relevant: the person would probably keep it (p > 0.5) and it actually helps (utility > 0). */
  relevant: boolean;
  /** Graded relevance for NDCG: max(0, utility). */
  gain: number;
}

/** Full-information truth for every eligible item in this context. Evaluation only. */
export function oracleTruth(person: Pick<SyntheticPerson, "hidden">, input: RecommenderInput): OracleItem[] {
  return eligibleItems(input).map((item) => {
    const utility = trueUtility(person, item, input);
    const keepProbability = sigmoid(keepLogit(utility, input));
    return { item, utility, keepProbability, relevant: keepProbability > 0.5 && utility > 0, gain: Math.max(0, utility) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Person generation
// ---------------------------------------------------------------------------------------------------------------

function drawTraits(r: () => number): Traits {
  const f: Record<Factor, number> = { access: normal(r), experience: normal(r), appetite: normal(r) };
  const t = {} as Traits;
  for (const trait of TRAITS) {
    const loads = TRAIT_LOADINGS[trait];
    let v = 0;
    let shared = 0;
    for (const factor of FACTORS) {
      const l = loads[factor] ?? 0;
      v += l * f[factor];
      shared += l * l;
    }
    t[trait] = v + Math.sqrt(1 - shared) * normal(r);
  }
  return t;
}

export function ageBandFor(t: Traits, noise: number): AgeBand {
  const a = PARAMS.age;
  // Var(a·RE + b·TP) with corr(RE, TP) = 0.75·(−0.6) = −0.45.
  const shared = a.readingEffort ** 2 + a.tapPrecision ** 2 + 2 * a.readingEffort * a.tapPrecision * -0.45;
  const z = a.readingEffort * t.readingEffort + a.tapPrecision * t.tapPrecision + Math.sqrt(1 - shared) * noise;
  const band = a.cuts.findIndex((c) => z < c);
  return AGE_BANDS[band === -1 ? AGE_BANDS.length - 1 : band];
}

type AnswerValue = string;

/** The answer a person's traits point to (before skipping and inconsistency). */
function truthfulAnswer(id: QuestionId, t: Traits, sr: boolean, r: () => number): AnswerValue {
  const n = () => PARAMS.answerNoise * normal(r);
  switch (id) {
    case "creditFamiliarity":
      return ordinal(t.confidence + n(), -0.6, 0.6, ["new", "some", "confident"]);
    case "budgetingFamiliarity":
      return ordinal(0.7 * t.confidence + 0.4 * t.focusBudget + n(), -0.6, 0.6, ["new", "some", "confident"]);
    case "appConfidence":
      return ordinal(0.6 * t.confidence - 0.4 * t.readingEffort + n(), -0.6, 0.6, ["low", "medium", "high"]);
    case "detailLevel":
      return ordinal(t.busyTolerance + n(), -0.5, 0.6, ["keyFacts", "some", "everything"]);
    case "inputMode":
      return ordinal(t.voice + n(), -0.2, 0.9, ["touch", "either", "voice"]);
    case "explanationFormat":
      return ordinal(t.visual + n(), -0.5, 0.5, ["written", "both", "visual"]);
    case "answerLength":
      return 0.7 * t.busyTolerance + 0.3 * t.confidence + n() > 0.3 ? "detailed" : "short";
    case "guidance":
      return t.guidance + n() > 0.2 ? "guided" : "independent";
    case "screenComplexity":
      return ordinal(t.busyTolerance + n(), -0.5, 0.7, ["minimal", "balanced", "everything"]);
    case "priority": {
      const scores = [t.focusPayments + n(), t.focusSpending + n(), t.focusBudget + n(), t.focusRecent + n()];
      return (["payments", "spending", "budget", "transactions"] as const)[scores.indexOf(Math.max(...scores))];
    }
    case "screenReader":
      return sr ? "yes" : "no";
    default:
      // QuestionId is typed as string by the profile module, so the compiler cannot prove this switch is exhaustive.
      throw new Error(`No synthetic answer model for question ${id}`);
  }
}

function drawAnswers(t: Traits, sr: boolean, r: () => number): { answers: ProfileAnswers; inconsistent: QuestionId[] } {
  const out: Record<string, string> = {};
  const inconsistent: QuestionId[] = [];
  if (r() < PARAMS.answerNothing) return { answers: {}, inconsistent };
  const [lo, hi] = PARAMS.skipRange;
  const skip = lo + (hi - lo) * r();
  const stopAfter = r() < PARAMS.stopPartway ? 1 + Math.floor(r() * 4) : Infinity;
  for (const q of QUESTIONS) {
    // Draw everything for every question so skipping does not shift the random stream.
    const truthful = truthfulAnswer(q.id, t, sr, r);
    const skipped = r() < skip;
    const flip = r() < PARAMS.inconsistent && q.id !== "screenReader"; // a factual question: answered truthfully
    const alt = q.options.map((o) => o.value as string).filter((v) => v !== truthful);
    const altPick = alt[Math.floor(r() * alt.length)];
    if (skipped || Object.keys(out).length >= stopAfter) continue;
    out[q.id] = flip ? altPick : truthful;
    if (flip) inconsistent.push(q.id);
  }
  return { answers: out as ProfileAnswers, inconsistent };
}

interface SimState {
  preferences: Preferences;
  view: Mode;
  explicit: Set<Dimension>;
  signals: Record<SignalId, number>;
  history: HistoryEntry[];
}

function signalRates(h: HiddenState): Record<SignalId, number> {
  const t = h.traits;
  const a = h.activity;
  return {
    textLarger: 0.5 * a * softplus(1.5 * (t.readingEffort - 0.8)),
    textSmaller: 0.05 + 0.3 * a * softplus(1.5 * (-t.readingEffort - 1.0)),
    lessOnScreen: 0.5 * a * softplus(1.5 * (-t.busyTolerance - 0.6)),
    moreDetail: 0.5 * a * softplus(1.5 * (t.busyTolerance - 0.6)),
    moreVisual: 0.5 * a * softplus(1.5 * (t.visual + 0.4 * t.focusSpending - 0.8)),
    voiceSessions: 0.05 + 1.2 * a * softplus(1.5 * (t.voice - 0.4)),
    shorterAnswers: 0.3 * a * softplus(1.5 * (-t.busyTolerance - 0.5)) * (t.voice > 0 ? 1 : 0.2),
    undoneChanges: 0.08 * a,
  };
}

function addSignals(r: () => number, s: Record<SignalId, number>, rates: Record<SignalId, number>, scale: number) {
  for (const id of SIGNAL_IDS) s[id] = Math.min(SIGNAL_CAP, s[id] + poisson(r, rates[id] * scale));
}

/** Settings the person changed themselves before any suggestion. */
function initialState(h: HiddenState, r: () => number): SimState {
  const t = h.traits;
  const adopt = (need: number) => r() < h.engagement * sigmoid(2.5 * (need - 1.0));
  const actions: UiAction[] = [];
  if (adopt(t.readingEffort)) actions.push({ type: "textSize", value: t.readingEffort < 1.6 ? 125 : t.readingEffort < 2.2 ? 150 : 200 });
  if (adopt(0.8 * t.readingEffort)) actions.push({ type: "contrast", value: "high" });
  if (adopt(0.5 * t.readingEffort - 0.4 * t.busyTolerance)) actions.push({ type: "spacing", value: "roomy" });
  if (adopt(t.motionSensitivity)) actions.push({ type: "motion", value: "reduced" });
  if (adopt(-t.tapPrecision)) actions.push({ type: "targets", value: "large" });
  if (adopt(t.guidance)) actions.push({ type: "explanations", value: "stepByStep" });
  if (adopt(t.voice)) actions.push({ type: "voiceFirst", value: true });
  if (adopt(-t.busyTolerance)) actions.push({ type: "density", value: "calm" });
  if (adopt(-t.busyTolerance - 0.3)) actions.push({ type: "hide", widget: r() < 0.5 ? "recent" : "chart" });
  const focus: [number, ItemId][] = [
    [t.focusPayments, "homeFocus.bill"],
    [t.focusSpending, "homeFocus.chart"],
    [t.focusBudget, "homeFocus.budget"],
    [t.focusRecent, "homeFocus.recent"],
  ];
  const [topNeed, topItem] = focus.reduce((best, f) => (f[0] > best[0] ? f : best));
  if (adopt(topNeed)) actions.push(...CATALOG[topItem].actions);
  // Theme and onboarding are unrelated to any trait on purpose (irrelevant inputs).
  const theme = r();
  actions.push({ type: "theme", value: theme < 0.22 ? "dark" : theme < 0.32 ? "light" : "system" });
  const onboarding = r();
  actions.push({ type: "onboarding", value: onboarding < 0.3 ? "done" : onboarding < 0.45 ? "skipped" : "unset" });
  const preferences = sanitize(applyActions(DEFAULT_PREFS, actions));

  const simple = r() < sigmoid(-1.2 * t.busyTolerance - 0.5 * t.confidence + 0.5 * t.guidance - 0.6);
  const view: Mode = simple ? "simple" : "complex";
  const explicit = new Set<Dimension>(nonDefaultDimensions(preferences));
  for (const d of DIMENSIONS) if (d !== "view" && !explicit.has(d) && r() < 0.08 * h.engagement) explicit.add(d);
  if (r() < (simple ? 0.6 : 0.1)) explicit.add("view");

  const signals = Object.fromEntries(SIGNAL_IDS.map((id) => [id, 0])) as Record<SignalId, number>;
  addSignals(r, signals, signalRates(h), 2);
  return { preferences, view, explicit, signals, history: [] };
}

function snapshot(answers: ProfileAnswers, s: SimState): RecommenderInput {
  const signals: Signals = {};
  for (const id of SIGNAL_IDS) if (s.signals[id] > 0) signals[id] = s.signals[id];
  return {
    answers,
    preferences: s.preferences,
    view: s.view,
    explicit: DIMENSIONS.filter((d) => s.explicit.has(d)),
    signals,
    history: s.history.slice(),
  };
}

/** Items the logging policy may show: eligible, and not turned down or undone before. */
function showable(input: RecommenderInput): ItemId[] {
  const suppressed = new Set(input.history.filter((e) => e.outcome === "rejected" || e.outcome === "reverted").map((e) => e.item));
  return eligibleItems(input).filter((id) => !suppressed.has(id));
}

function pickConfiguration(r: () => number, candidates: ItemId[], weights: (id: ItemId) => number, size: number): ItemId[] {
  const out: ItemId[] = [];
  let pool = candidates.slice();
  while (out.length < size && pool.length > 0) {
    const i = weightedIndex(r, pool.map(weights));
    const pick = pool[i];
    out.push(pick);
    pool = pool.filter((id) => id !== pick && !conflicts(id, pick));
  }
  return out;
}

function chooseShown(r: () => number, input: RecommenderInput): { policy: LoggingPolicy; items: ItemId[] } {
  const candidates = showable(input);
  const p = PARAMS.policy;
  const roll = r();
  const size = 1 + weightedIndex(r, PARAMS.configSize);
  let policy: LoggingPolicy = roll < p.rules ? "rules" : roll < p.rules + p.popularity ? "popularity" : "uniform";
  if (policy === "rules") {
    const out: ItemId[] = [];
    for (const id of rulesItems(input.answers)) if (candidates.includes(id) && out.length < MAX_BUNDLE_SIZE && !out.some((o) => conflicts(o, id))) out.push(id);
    if (out.length > 0) return { policy, items: out };
    policy = "popularity"; // the rules have nothing to say (no relevant answers): fall back, as the product would
  }
  if (policy === "popularity") return { policy, items: pickConfiguration(r, candidates, (id) => POPULARITY_PRIOR[id], size) };
  return { policy, items: pickConfiguration(r, candidates, () => 1, size) };
}

function makePerson(seed: number, index: number, logged: LoggedExample[], examples: TrainingExample[]): { person: SyntheticPerson; dismissed: number } {
  const r = rng(mixSeed(seed, index));
  const traits = drawTraits(r);
  const screenReader = r() < sigmoid(-4 + 1.3 * traits.readingEffort);
  const itemNoise = Object.fromEntries(ITEM_IDS.map((id) => [id, PARAMS.itemNoise * normal(r)])) as Record<ItemId, number>;
  const hidden: HiddenState = { traits, screenReader, itemNoise, activity: Math.exp(0.5 * normal(r)), engagement: r() ** 1.5 };
  const research = { ageBand: ageBandFor(traits, normal(r)) };
  const { answers, inconsistent } = drawAnswers(traits, screenReader, r);
  const state = initialState(hidden, r);
  const rates = signalRates(hidden);
  const subject = `syn-${index}`;
  const start = logged.length;
  const plannedRounds = 1 + weightedIndex(r, PARAMS.rounds);
  const rounds: SyntheticRound[] = [];
  const snapshots: { input: RecommenderInput; now: number }[] = [];
  let at = SYNTHETIC_EPOCH + Math.floor(r() * 300) * DAY;
  let dismissed = 0;
  const k = PARAMS.keep;

  for (let round = 0; round < plannedRounds; round++) {
    const input = snapshot(answers, state);
    const { policy, items } = chooseShown(r, input);
    if (items.length === 0) break; // nothing left to suggest
    snapshots.push({ input, now: at });
    const { rejectedRounds } = historyStats(input.history);

    if (r() < PARAMS.dismiss.base + PARAMS.dismiss.fatigue * Math.min(rejectedRounds, 4)) {
      dismissed++;
      for (const item of items) state.history.push({ item, outcome: "dismissed", at });
      rounds.push({ at, policy, items, outcome: "dismissed", rating: null });
    } else {
      const decisions = items.map((item, position) => {
        const utility = trueUtility({ hidden }, item, input);
        const logit = keepLogit(utility, input, position);
        const kept = r() < sigmoid(logit + k.exposureNoise * normal(r));
        const reverted = kept && r() < sigmoid(PARAMS.revert.slope * utility + PARAMS.revert.bias);
        const viaUndo = r() < PARAMS.revert.viaUndo;
        return { item, position, utility, keepProbability: sigmoid(logit), kept, reverted, viaUndo };
      });
      const kept = decisions.filter((d) => d.kept);
      let rating: -1 | 0 | 1 | null = null;
      const respond = r() < PARAMS.rating.respond;
      const ratingNoise = PARAMS.rating.noise * normal(r);
      if (kept.length > 0 && respond) {
        const m = kept.reduce((s, d) => s + d.utility, 0) / kept.length + ratingNoise;
        rating = m < PARAMS.rating.unhelpfulBelow ? -1 : m > PARAMS.rating.helpfulAbove ? 1 : 0;
      }
      for (const d of decisions) {
        // CONTRACT.md §8: kept, not undone and not rated unhelpful -> 1; turned down, undone or rated unhelpful -> 0.
        const label: 0 | 1 = d.kept && !d.reverted && rating !== -1 ? 1 : 0;
        const example: TrainingExample = { subject, input, item: d.item, label, weight: 1, source: "synthetic" };
        examples.push(example);
        logged.push({
          example,
          person: index,
          round,
          position: d.position,
          at,
          policy,
          outcome: !d.kept ? "rejected" : d.reverted ? "reverted" : "kept",
          ratedUnhelpful: d.kept && rating === -1,
          utility: d.utility,
          keepProbability: d.keepProbability,
        });
        // Update the person's settings and visible history.
        const dim = CATALOG[d.item].dimension;
        if (!d.kept) state.history.push({ item: d.item, outcome: "rejected", at });
        else if (d.reverted) {
          state.history.push({ item: d.item, outcome: "reverted", at });
          if (d.viaUndo) state.signals.undoneChanges = Math.min(SIGNAL_CAP, state.signals.undoneChanges + 1);
          else state.explicit.add(dim); // changed back in Settings: now set by the person
        } else {
          state.history.push({ item: d.item, outcome: "accepted", at });
          state.preferences = sanitize(applyActions(state.preferences, CATALOG[d.item].actions));
          if (CATALOG[d.item].mode) state.view = CATALOG[d.item].mode!;
          state.explicit.add(dim);
        }
      }
      for (const d of nonDefaultDimensions(state.preferences)) state.explicit.add(d);
      rounds.push({ at, policy, items, outcome: kept.length === 0 ? "rejected" : kept.length === items.length ? "accepted" : "modified", rating });
    }
    const gap = PARAMS.daysMin + Math.floor(r() * PARAMS.daysSpread);
    at += gap * DAY;
    addSignals(r, state.signals, rates, gap / 14);
  }
  snapshots.push({ input: snapshot(answers, state), now: at });
  const evalRound = Math.floor(r() * snapshots.length);
  const person: SyntheticPerson = {
    index,
    subject,
    hidden,
    research,
    answers,
    inconsistent,
    rounds,
    examples: { start, end: logged.length },
    evaluation: { input: snapshots[evalRound].input, round: evalRound, now: snapshots[evalRound].now },
  };
  return { person, dismissed };
}

/** Generates the whole synthetic world. Deterministic: the same options always give the same world. */
export function generateWorld(options: WorldOptions = DEFAULT_WORLD): World {
  const people: SyntheticPerson[] = [];
  const logged: LoggedExample[] = [];
  const examples: TrainingExample[] = [];
  let dismissedRounds = 0;
  for (let i = 0; i < options.people; i++) {
    const { person, dismissed } = makePerson(options.seed, i, logged, examples);
    people.push(person);
    dismissedRounds += dismissed;
  }
  return { generatorVersion: SYNTHETIC_GENERATOR_VERSION, options: { ...options }, people, logged, examples, dismissedRounds };
}

// ---------------------------------------------------------------------------------------------------------------
// Splits (by person: nobody is in two splits)
// ---------------------------------------------------------------------------------------------------------------

export interface PersonSplit {
  train: number[];
  validation: number[];
  test: number[];
}

/** Seeded shuffle of person indices, then 60/20/20 (by default). Each person is in exactly one part. */
export function splitPeople(count: number, seed: number, fractions = { train: 0.6, validation: 0.2 }): PersonSplit {
  const r = rng(mixSeed(seed, 0x5eed));
  const idx = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const a = Math.round(count * fractions.train);
  const b = a + Math.round(count * fractions.validation);
  const sort = (xs: number[]) => xs.sort((x, y) => x - y);
  return { train: sort(idx.slice(0, a)), validation: sort(idx.slice(a, b)), test: sort(idx.slice(b)) };
}

/** Logged examples (with hidden truth) of these people, in person order. */
export function loggedFor(world: World, people: readonly number[]): LoggedExample[] {
  const out: LoggedExample[] = [];
  for (const i of people) {
    const { start, end } = world.people[i].examples;
    for (let k = start; k < end; k++) out.push(world.logged[k]);
  }
  return out;
}

/** Training examples of these people (what a model may see). */
export const examplesFor = (world: World, people: readonly number[]): TrainingExample[] => loggedFor(world, people).map((l) => l.example);

/**
 * The "warm" variant: people whose evaluation snapshot comes after at least one earlier round, and examples whose
 * input already carries this person's own history.
 */
export const warmPeople = (world: World, people: readonly number[]): number[] => people.filter((i) => world.people[i].evaluation.input.history.length > 0);
export const isWarm = (e: TrainingExample) => e.input.history.length > 0;
