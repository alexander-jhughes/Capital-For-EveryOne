// TEST HELPER ONLY (imported by *.test.ts, never by the engine). A tiny, deterministic latent-preference world with
// planted relationships, so tests can check that each component learns them from TrainingExamples alone.
// The simulator knows the truth; the engine only ever sees the examples it produces.
import { applyActions, DEFAULT_PREFS, type Preferences } from "../../preferences/schema";
import type { Mode } from "../../types";
import { CATALOG, type Dimension, isActive, ITEM_IDS, type ItemId, nonDefaultDimensions } from "../catalog";
import type { ProfileAnswers } from "../profile";
import { rng, sigmoid } from "../random";
import type { HistoryEntry, RecommenderInput, Signals, TrainingExample } from "../types";
import type { RecommenderModel, TrainOptions } from "./model";
import { trainRecommender } from "./train";

export interface Latent {
  /** Wants less on screen. */
  simple: number;
  voice: number;
  guide: number;
  /** Readability need: never asked, only visible through settings and signals. */
  read: number;
  visual: number;
  priority: "payments" | "spending" | "budget" | "transactions";
}

export interface FixtureOptions {
  subjects: number;
  seed: number;
  /** Offers per subject (sequential, with history). Default 6. */
  offers?: number;
  /** Probability of answering each question. Default 0.85. */
  answerRate?: number;
  /** Prefix for subject ids, so separate worlds never share ids. */
  prefix?: string;
}

export interface FixtureWorld {
  examples: TrainingExample[];
  people: { id: string; latent: Latent; first: RecommenderInput }[];
}

export const DAY = 24 * 60 * 60 * 1000;
export const T0 = Date.UTC(2026, 5, 1);

/** The planted truth: log-odds that a person with these latents keeps the item. */
export function trueLogit(item: ItemId, z: Latent): number {
  const is = (p: Latent["priority"]) => (z.priority === p ? 1 : 0);
  switch (item) {
    case "view.simple":
      return -0.2 + 2.0 * z.simple;
    case "view.detailed":
      return -0.6 - 2.0 * z.simple;
    case "density.calm":
      return -0.4 + 2.0 * z.simple;
    case "textSize.125":
      return -0.8 + 1.8 * z.read;
    case "textSize.150":
      return -1.5 + 1.8 * z.read;
    case "contrast.high":
      return -1.2 + 1.6 * z.read;
    case "spacing.roomy":
      return -0.6 + 0.9 * z.read + 0.9 * z.simple;
    case "motion.reduced":
      return -0.5 + 1.2 * z.simple;
    case "targets.large":
      return -1.0 + 1.4 * z.read;
    case "explanations.stepByStep":
      return -0.4 + 2.2 * z.guide;
    case "voiceFirst.on":
      return -0.8 + 2.4 * z.voice;
    case "homeFocus.bill":
      return -1.2 + 3.0 * is("payments");
    case "homeFocus.chart":
      return -1.0 + 1.2 * z.visual + 1.6 * is("spending");
    case "homeFocus.budget":
      return -1.0 + 0.8 * z.visual + 2.2 * is("budget");
    case "homeFocus.recent":
      return -1.2 + 2.4 * is("transactions") - 0.8 * z.simple;
    case "homeFocus.insights":
      return -0.6 + 1.4 * z.guide;
  }
}

const three = <T extends string>(v: number, hi: T, mid: T, lo: T, cut = 0.6): T => (v > cut ? hi : v < -cut ? lo : mid);

function poisson(r: () => number, mean: number): number {
  const l = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > l && k < 50);
  return k - 1;
}

/** Answers that reflect the latents (with noise and skips). */
export function answersFor(z: Latent, r: () => number, rate: number): ProfileAnswers {
  const n = () => (r() - 0.5) * 1.2;
  const a: Record<string, string> = {
    detailLevel: three(z.simple + n(), "keyFacts", "some", "everything"),
    screenComplexity: three(z.simple + n(), "minimal", "balanced", "everything", 0.5),
    inputMode: three(z.voice + n(), "voice", "either", "touch"),
    guidance: z.guide + n() > 0 ? "guided" : "independent",
    creditFamiliarity: three(z.guide + n(), "new", "some", "confident", 0.7),
    explanationFormat: three(z.visual + n(), "visual", "both", "written", 0.5),
    priority: z.priority,
    appConfidence: three(-z.guide + n(), "low", "medium", "high"),
    budgetingFamiliarity: three(n() * 2, "new", "some", "confident"),
    answerLength: z.simple + n() > 0 ? "short" : "detailed",
    screenReader: z.read > 1.8 && r() < 0.5 ? "yes" : "no",
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) if (r() < rate) out[k] = v;
  return out as ProfileAnswers;
}

const PRIORITIES: Latent["priority"][] = ["payments", "spending", "budget", "transactions"];

export function randomLatent(r: () => number): Latent {
  const g = () => {
    const u = Math.max(r(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  return { simple: g(), voice: g(), guide: g(), read: g(), visual: g(), priority: PRIORITIES[Math.floor(r() * 4)] };
}

function apply(item: ItemId, p: Preferences, view: Mode): { p: Preferences; view: Mode } {
  const c = CATALOG[item];
  return { p: applyActions(p, c.actions), view: c.mode ?? view };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Simulates people being offered one item at a time, with the outcome feeding into their next snapshot. */
export function fixtureWorld(o: FixtureOptions): FixtureWorld {
  const r = rng(o.seed);
  const offers = o.offers ?? 6;
  const rate = o.answerRate ?? 0.85;
  const prefix = o.prefix ?? `s${o.seed}-`;
  const examples: TrainingExample[] = [];
  const people: FixtureWorld["people"] = [];
  for (let s = 0; s < o.subjects; s++) {
    const z = randomLatent(r);
    const answers = answersFor(z, r, rate);
    let prefs: Preferences = { ...DEFAULT_PREFS, layout: { ...DEFAULT_PREFS.layout } };
    if (z.read > 0.8 && r() < 0.6) prefs = { ...prefs, textSize: 125 };
    if (z.read > 1.2 && r() < 0.5) prefs = { ...prefs, contrast: "high" };
    let view: Mode = z.simple + (r() - 0.5) > -0.3 ? "simple" : "complex";
    const explicit: Dimension[] = nonDefaultDimensions(prefs);
    if (r() < 0.2) explicit.push("view");
    const signals: Signals = {
      voiceSessions: poisson(r, Math.exp(z.voice - 0.5)),
      textLarger: poisson(r, Math.exp(z.read - 1)),
      lessOnScreen: poisson(r, Math.exp(z.simple - 1)),
      moreDetail: poisson(r, Math.exp(-z.simple - 1)),
    };
    const history: HistoryEntry[] = [];
    const id = `${prefix}${s}`;
    let first: RecommenderInput | null = null;
    for (let round = 0; round < offers; round++) {
      const eligible = ITEM_IDS.filter((item) => !isActive(item, prefs, view) && !explicit.includes(CATALOG[item].dimension) && !history.some((h) => h.item === item));
      if (eligible.length === 0) break;
      const item = eligible[Math.floor(r() * eligible.length)];
      const input: RecommenderInput = clone({ answers, preferences: prefs, view, explicit, signals, history });
      first ??= input;
      const label: 0 | 1 = r() < sigmoid(trueLogit(item, z)) ? 1 : 0;
      examples.push({ subject: id, input, item, label, weight: 1, source: "synthetic" });
      const at = T0 + (s % 50) * DAY + round * 3 * DAY;
      if (label === 1) {
        ({ p: prefs, view } = apply(item, prefs, view));
        history.push({ item, outcome: "accepted", at });
      } else history.push({ item, outcome: "rejected", at });
    }
    people.push({ id, latent: z, first: first ?? { answers, preferences: prefs, view, explicit, signals, history: [] } });
  }
  return { examples, people };
}

/** Default settings, no answers, no signals, no history: someone who has told Dial nothing. */
export const COLD_START: RecommenderInput = {
  answers: {},
  preferences: DEFAULT_PREFS,
  view: "simple",
  explicit: [],
  signals: {},
  history: [],
};

/** A clearly "less on screen, guided, voice" person who has answered everything and nothing else. */
export const MINIMAL_GUIDED_VOICE: RecommenderInput = {
  answers: {
    detailLevel: "keyFacts",
    screenComplexity: "minimal",
    inputMode: "voice",
    guidance: "guided",
    creditFamiliarity: "new",
    explanationFormat: "both",
    priority: "payments",
    appConfidence: "low",
    budgetingFamiliarity: "some",
    answerLength: "short",
    screenReader: "no",
  },
  preferences: DEFAULT_PREFS,
  view: "complex",
  explicit: [],
  signals: {},
  history: [],
};

// ---------------------------------------------------------------------------------------------------------------
// A trained fixture model, shared by the tests of one file (trained once per file, about half a second).
// ---------------------------------------------------------------------------------------------------------------

export const FIXTURE_OPTIONS: TrainOptions = { seed: 7, version: "hybrid-test+fixture", datasetVersion: "fixture-1", trainedOn: "synthetic" };

export interface FixtureSplits {
  train: TrainingExample[];
  validation: TrainingExample[];
  test: FixtureWorld;
}

let splits: FixtureSplits | null = null;
export function fixtureSplits(): FixtureSplits {
  splits ??= {
    train: fixtureWorld({ subjects: 1500, seed: 101, prefix: "train-" }).examples,
    validation: fixtureWorld({ subjects: 600, seed: 202, prefix: "val-" }).examples,
    test: fixtureWorld({ subjects: 600, seed: 303, prefix: "test-" }),
  };
  return splits;
}

let model: RecommenderModel | null = null;
export function fixtureModel(): RecommenderModel {
  if (!model) {
    const s = fixtureSplits();
    model = trainRecommender(s.train, s.validation, FIXTURE_OPTIONS);
  }
  return model;
}
