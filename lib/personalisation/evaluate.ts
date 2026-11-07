// Evaluation harness (docs/ml-personalisation/EVALUATION-v2.md). Measures a trained model the way the app
// actually uses it, not only the way it was trained. Pure and deterministic; run by
// `scripts/personalisation/train.ts --evaluate` and covered by evaluate.test.ts. SYNTHETIC data only.
//
// What it measures, per target:
//   1. ranking and calibration: AUC, Brier, expected calibration error (10 bins) and the reliability table;
//   2. robustness: the same model on generator B, a differently designed population it never saw;
//   3. coverage: who actually gets a suggestion through the full inference pipeline (all gates, one card);
//   4. repetition: a person over several visits who says "No thanks" or "Not now";
//   5. cross-mode: suggestion rates in Simple vs Detailed view and with talking-first on.
import { applyActions, type Preferences, sanitize, type UiAction } from "../preferences/schema";
import type { ModelArtifact } from "./artifact";
import { onPrefsEvent, reconcile } from "./controller";
import { extractFeatures, type PersonalisationInput } from "./features";
import { predictProba, rng } from "./forest";
import { recommendPreferences } from "./infer";
import { binaryMetrics, ece, recommendationMetrics, reliability, type ReliabilityBin } from "./metrics";
import { INITIAL_STATE, type PersonalisationState, recordOutcome } from "./state";
import { DEFAULT_SYNTHETIC, type SyntheticOptions, type SyntheticPerson } from "./synthetic";
import { DEFAULT_SYNTHETIC_B } from "./synthetic-b";
import { TARGET_IDS, type TargetId, targetStatus } from "./targets";

/** Fresh evaluation samples. Seeds differ from training, so none of these people were trained on. */
export const EVAL_SAMPLES: { a: SyntheticOptions; b: SyntheticOptions; bReferenceTrain: SyntheticOptions } = {
  a: { ...DEFAULT_SYNTHETIC, seed: 7001 },
  b: { ...DEFAULT_SYNTHETIC_B, seed: 7002 },
  bReferenceTrain: { ...DEFAULT_SYNTHETIC_B, seed: 7003 },
};

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const share = (num: number, den: number) => (den ? r4(num / den) : 0);

/**
 * The people the app can actually score, as PersonalisationProvider sees them: they consented (so they have counts),
 * their settings went through the cookie's sanitize() (current schema, defaults filled in), and Make it yours ticks
 * are not passed (the provider sends choices: null). People on the older schema don't exist in this app.
 */
export function servedPopulation(people: SyntheticPerson[]): SyntheticPerson[] {
  return people
    .filter((p) => p.signals !== null && typeof p.input.preferences?.voiceFirst === "boolean")
    .map((p) => ({ ...p, input: { preferences: sanitize(p.input.preferences), view: p.input.view, choices: null } }));
}

const grantedState = (p: SyntheticPerson): PersonalisationState => ({ ...INITIAL_STATE, consent: "granted", signals: { ...(p.signals ?? {}) } });

/** The probability the model reports for a target. */
export const probability = (model: ModelArtifact, id: TargetId, x: number[]) => predictProba(model.targets[id].trees, x);

export interface TargetScore {
  /** People with the setting off (the only ones who can be offered it). */
  eligible: number;
  baseRate: number | null;
  auc: number | null;
  brier: number | null;
  ece: number | null;
  reliability: ReliabilityBin[];
  /** The model's own threshold (null: never offered). Offers use max(threshold, floor). */
  threshold: number | null;
  offered: number;
  coverage: number;
  keepRate: number | null;
}

/** Ranking, calibration and keep rate at the model's threshold, per target, on eligible people. */
export function scoreTargets(model: ModelArtifact, people: SyntheticPerson[], floor = 0.6): Record<TargetId, TargetScore> {
  const X = people.map((p) => extractFeatures(p.input, p.signals));
  const out = {} as Record<TargetId, TargetScore>;
  for (const id of TARGET_IDS) {
    const rows = people.map((p, i) => (targetStatus(id, p.input.preferences) === "off" ? i : -1)).filter((i) => i >= 0);
    const y: number[] = rows.map((i) => people[i].labels[id]);
    const p = rows.map((i) => probability(model, id, X[i]));
    const threshold = model.targets[id].threshold;
    const m = binaryMetrics(y, p, 0.5);
    const rec = threshold === null ? { offered: 0, coverage: 0, keepRate: null } : recommendationMetrics(y, p, Math.max(threshold, floor));
    out[id] = {
      eligible: rows.length,
      baseRate: rows.length ? share(y.reduce((s, v) => s + v, 0), rows.length) : null,
      auc: m.auc,
      brier: rows.length ? m.brier : null,
      ece: ece(y, p),
      reliability: reliability(y, p),
      threshold,
      ...rec,
    };
  }
  return out;
}

export interface PipelineStats {
  people: number;
  /** Share of people for whom the Home card would show a suggestion. */
  anySuggestion: number;
  byTarget: Record<TargetId, { eligible: number; shown: number; rate: number; keptWhenShown: number | null }>;
}

/** Runs the real recommendPreferences() exactly as the provider does (one suggestion at a time) for each person. */
export function pipelineStats(model: ModelArtifact, people: SyntheticPerson[], mapInput: (i: PersonalisationInput) => PersonalisationInput = (i) => i): PipelineStats {
  const byTarget = Object.fromEntries(TARGET_IDS.map((id) => [id, { eligible: 0, shown: 0, kept: 0 }])) as Record<TargetId, { eligible: number; shown: number; kept: number }>;
  let any = 0;
  for (const p of people) {
    const input = mapInput(p.input);
    for (const id of TARGET_IDS) if (targetStatus(id, input.preferences) === "off") byTarget[id].eligible++;
    const top = recommendPreferences(input, grantedState(p), model, { maxSuggestions: 1 }).preferences[0];
    if (!top) continue;
    any++;
    byTarget[top.target].shown++;
    byTarget[top.target].kept += p.labels[top.target];
  }
  return {
    people: people.length,
    anySuggestion: share(any, people.length),
    byTarget: Object.fromEntries(
      TARGET_IDS.map((id) => {
        const t = byTarget[id];
        return [id, { eligible: t.eligible, shown: t.shown, rate: share(t.shown, t.eligible), keptWhenShown: t.shown ? share(t.kept, t.shown) : null }];
      }),
    ) as PipelineStats["byTarget"],
  };
}

export interface CrossModeStats {
  simple: PipelineStats;
  detailed: PipelineStats;
  /** The same Simple-view people, scored as if they had switched to Detailed (and vice versa): how much the view alone decides. */
  simpleSwitchedToDetailed: PipelineStats;
  detailedSwitchedToSimple: PipelineStats;
  talkingFirstOn: PipelineStats;
}

export function crossModeStats(model: ModelArtifact, people: SyntheticPerson[]): CrossModeStats {
  const simple = people.filter((p) => p.input.view === "simple");
  const detailed = people.filter((p) => p.input.view === "complex");
  return {
    simple: pipelineStats(model, simple),
    detailed: pipelineStats(model, detailed),
    simpleSwitchedToDetailed: pipelineStats(model, simple, (i) => ({ ...i, view: "complex" })),
    detailedSwitchedToSimple: pipelineStats(model, detailed, (i) => ({ ...i, view: "simple" })),
    talkingFirstOn: pipelineStats(model, people.filter((p) => p.input.preferences?.voiceFirst === true)),
  };
}

/** How a simulated person answers each suggestion. */
export type AnswerPolicy = "noThanks" | "notNow" | "labels";

export interface RepetitionStats {
  policy: AnswerPolicy;
  /** People offered something on their first visit (the only ones repetition can affect). */
  people: number;
  visits: number;
  /** Mean number of suggestions shown to a person over all visits. */
  shownPerPerson: number;
  /** Share of people who were shown 2+ different suggestions within one visit. */
  multiplePerVisit: number;
  maxPerVisit: number;
  /** Share of people shown a suggestion again after saying No thanks or Not now to that same suggestion. */
  sameAgain: number;
  /** Share of people shown any suggestion after 2 No thanks in a row, before they changed a setting themselves. */
  afterTwoNoes: number;
}

export interface RepetitionOptions {
  policy: AnswerPolicy;
  visits?: number;
  /** Chance, between visits, that the person changes one of their own settings (here: light/dark theme). */
  settingChangeRate?: number;
  seed?: number;
}

const MAX_PER_VISIT = 10;

/**
 * Simulates each person over several visits, re-evaluating after every answer exactly as the provider does
 * (an answer changes the ML state, which triggers a new evaluation and possibly the next suggestion).
 */
export function simulateRepetition(model: ModelArtifact, people: SyntheticPerson[], opts: RepetitionOptions): RepetitionStats {
  const visits = opts.visits ?? 6;
  const rand = rng(opts.seed ?? 1);
  const evaluate = (prefs: Preferences, view: PersonalisationInput["view"], state: PersonalisationState) => {
    const input: PersonalisationInput = { preferences: prefs, view, choices: null };
    const next = reconcile(state, input);
    return { state: next, top: recommendPreferences(input, next, model, { maxSuggestions: 1 }) };
  };

  let population = 0;
  let shown = 0;
  let multiple = 0;
  let maxPerVisit = 0;
  let sameAgain = 0;
  let afterTwoNoes = 0;
  for (const p of people) {
    let prefs = sanitize(p.input.preferences);
    let state = grantedState(p);
    if (evaluate(prefs, p.input.view, state).top.status !== "ok") continue;
    population++;
    const dismissed = new Set<TargetId>();
    let noStreak = 0;
    let flags = { multiple: false, same: false, afterTwo: false };
    for (let v = 0; v < visits; v++) {
      let inVisit = 0;
      for (let k = 0; k < MAX_PER_VISIT; k++) {
        const e = evaluate(prefs, p.input.view, state);
        state = e.state;
        const rec = e.top.preferences[0];
        if (e.top.status !== "ok" || !rec) break;
        inVisit++;
        shown++;
        if (dismissed.has(rec.target)) flags.same = true;
        if (noStreak >= 2) flags.afterTwo = true;
        const answer = opts.policy === "labels" ? (p.labels[rec.target] === 1 ? "accepted" : rand() < 0.5 ? "rejected" : "ignored") : opts.policy === "noThanks" ? "rejected" : "ignored";
        if (answer === "accepted") {
          const before = prefs;
          prefs = applyActions(prefs, rec.actions as UiAction[]);
          state = onPrefsEvent(state, { kind: "kept", actions: rec.actions as UiAction[], before, after: prefs, source: "ml" });
          noStreak = 0;
        } else {
          dismissed.add(rec.target);
          if (answer === "rejected") noStreak++;
        }
        state = recordOutcome(state, rec.target, answer, e.top.fingerprint!);
      }
      if (inVisit >= 2) flags.multiple = true;
      maxPerVisit = Math.max(maxPerVisit, inVisit);
      if (rand() < (opts.settingChangeRate ?? 0.3)) {
        const before = prefs;
        const actions: UiAction[] = [{ type: "theme", value: prefs.theme === "dark" ? "system" : "dark" }];
        prefs = applyActions(prefs, actions);
        state = onPrefsEvent(state, { kind: "kept", actions, before, after: prefs, source: "settings" });
        noStreak = 0;
      }
    }
    multiple += +flags.multiple;
    sameAgain += +flags.same;
    afterTwoNoes += +flags.afterTwo;
    flags = { multiple: false, same: false, afterTwo: false };
  }
  return {
    policy: opts.policy,
    people: population,
    visits,
    shownPerPerson: share(shown, population),
    multiplePerVisit: share(multiple, population),
    maxPerVisit,
    sameAgain: share(sameAgain, population),
    afterTwoNoes: share(afterTwoNoes, population),
  };
}

export interface EvaluationReport {
  modelVersion: string;
  people: { a: number; aServed: number; b: number; bServed: number };
  /** Generator A, everyone (incl. never-consented, older schema, Make it yours ticks): how v1's own report measured it. */
  aAsReported: Record<TargetId, TargetScore>;
  /** Generator A, only the people the app can score, as the app scores them. */
  a: Record<TargetId, TargetScore>;
  /** Generator B (never trained on), people the app can score. */
  b: Record<TargetId, TargetScore>;
  pipelineA: PipelineStats;
  pipelineB: PipelineStats;
  crossModeA: CrossModeStats;
  crossModeB: CrossModeStats;
  repetition: RepetitionStats[];
}

/** Everything in EVALUATION-v2.md for one model. `a` and `b` are fresh evaluation samples, never trained on. */
export function evaluateModel(model: ModelArtifact, a: SyntheticPerson[], b: SyntheticPerson[]): EvaluationReport {
  const aServed = servedPopulation(a);
  const bServed = servedPopulation(b);
  return {
    modelVersion: model.modelVersion,
    people: { a: a.length, aServed: aServed.length, b: b.length, bServed: bServed.length },
    aAsReported: scoreTargets(model, a),
    a: scoreTargets(model, aServed),
    b: scoreTargets(model, bServed),
    pipelineA: pipelineStats(model, aServed),
    pipelineB: pipelineStats(model, bServed),
    crossModeA: crossModeStats(model, aServed),
    crossModeB: crossModeStats(model, bServed),
    repetition: (["noThanks", "notNow", "labels"] as const).map((policy) => simulateRepetition(model, aServed, { policy })),
  };
}
