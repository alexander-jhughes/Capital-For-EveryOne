// Trains and evaluates the profile model. Used by scripts/profile/train.ts and by the tests.
import { PERSON_TYPES, type PersonType } from "./catalog";
import { FEATURE_NAMES, featureVector } from "./features";
import { predictProba, train, type SoftmaxModel, type TrainOptions } from "./softmax";
import { generateDataset, SYNTHETIC_GENERATOR_VERSION, type SyntheticPerson } from "./synthetic";

export const MODEL_VERSION = "profile-1.0.0";

export interface TrainConfig extends TrainOptions {
  seed: number;
  train: number;
  validation: number;
  test: number;
  /** The confident-share accuracy the threshold is chosen for, on validation data only. */
  targetAccuracy: number;
}

export const DEFAULT_CONFIG: TrainConfig = { seed: 20261108, train: 6000, validation: 1500, test: 1500, epochs: 1500, learningRate: 2, l2: 0.0005, targetAccuracy: 0.9 };

export interface Metrics {
  accuracy: number;
  macroF1: number;
  logLoss: number;
  /** Expected calibration error over 10 equal-width bins of top-class probability. */
  ece: number;
  perClass: Record<PersonType, { precision: number; recall: number; f1: number; support: number }>;
  /** At the chosen threshold: share of people given a type, and accuracy among them. */
  coverage: number;
  confidentAccuracy: number;
}

export interface ProfileModel extends SoftmaxModel {
  version: string;
  generatorVersion: number;
  /** Below this top-class probability the app shows no type and asks instead. */
  threshold: number;
  /** The temperature the weights were divided by (already applied), chosen on validation data. */
  temperature: number;
}

export interface TrainingReport {
  config: TrainConfig;
  train: Metrics;
  test: Metrics;
  baselines: { majority: Metrics; rules: Metrics };
}

const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

/** A hand-written rule baseline: the type whose signature needs or behaviours appear most. What the model must beat. */
export function ruleBaseline(p: SyntheticPerson["input"]): number[] {
  const has = (id: string) => (p.needs as string[]).includes(id);
  const score: Record<PersonType, number> = {
    building: +has("new_to_credit") + (p.usage.learn > 2 ? 1 : 0),
    steady: +p.payments.some((x) => x.kind === "statement") + (p.goalKinds.includes("save_up") ? 1 : 0),
    stretched: +has("money_tight") + +has("behind_bills") + ((p.utilisation ?? 0) >= 0.75 ? 1 : 0),
    life_change: +has("bereavement") + +has("caring") + +has("relationship") + +has("income_change"),
    clear_simple: +has("plain_words") + +has("step_by_step") + +has("reading") + +has("digital"),
    planner: (p.usage.whatIf > 2 ? 1 : 0) + (p.usage.detailed > 3 ? 1 : 0),
  };
  const best = Math.max(...Object.values(score));
  // Ties and all-zero rows spread evenly, so the rule gets no free calibration.
  const winners = PERSON_TYPES.filter((t) => score[t] === best);
  return PERSON_TYPES.map((t) => (winners.includes(t) ? 1 / winners.length : 0));
}

export function evaluate(probs: number[][], ys: number[], threshold = 0): Metrics {
  const k = PERSON_TYPES.length;
  const n = ys.length;
  const argmax = (p: number[]) => p.indexOf(Math.max(...p));
  const preds = probs.map(argmax);
  const correct = preds.filter((p, i) => p === ys[i]).length;
  const perClass = {} as Metrics["perClass"];
  let f1Sum = 0;
  for (let c = 0; c < k; c++) {
    const tp = preds.filter((p, i) => p === c && ys[i] === c).length;
    const fp = preds.filter((p, i) => p === c && ys[i] !== c).length;
    const fn = preds.filter((p, i) => p !== c && ys[i] === c).length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    f1Sum += f1;
    perClass[PERSON_TYPES[c]] = { precision: round(precision), recall: round(recall), f1: round(f1), support: tp + fn };
  }
  const logLoss = -probs.reduce((s, p, i) => s + Math.log(Math.max(1e-12, p[ys[i]])), 0) / n;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));
  probs.forEach((p, i) => {
    const conf = Math.max(...p);
    const b = bins[Math.min(9, Math.floor(conf * 10))];
    b.n++;
    b.conf += conf;
    b.hit += preds[i] === ys[i] ? 1 : 0;
  });
  const ece = bins.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.conf / b.n - b.hit / b.n) : 0), 0);
  const confident = probs.map((p, i) => ({ ok: preds[i] === ys[i], conf: Math.max(...p) })).filter((r) => r.conf >= threshold);
  return {
    accuracy: round(correct / n),
    macroF1: round(f1Sum / k),
    logLoss: round(logLoss),
    ece: round(ece),
    perClass,
    coverage: round(confident.length / n),
    confidentAccuracy: round(confident.length ? confident.filter((r) => r.ok).length / confident.length : 0),
  };
}

/** The lowest threshold whose confident-share accuracy on validation reaches the target. */
export function chooseThreshold(probs: number[][], ys: number[], target: number): number {
  for (let t = 0.3; t <= 0.95; t = round(t + 0.05, 2)) {
    const m = evaluate(probs, ys, t);
    if (m.confidentAccuracy >= target && m.coverage > 0) return t;
  }
  return 0.95;
}

const logLossOf = (model: SoftmaxModel, xs: number[][], ys: number[]) => -xs.reduce((s, x, i) => s + Math.log(Math.max(1e-12, predictProba(model, x)[ys[i]])), 0) / xs.length;

/** Divides every weight by T: the same ranking, softer or sharper probabilities. */
export const scaleModel = (m: SoftmaxModel, t: number): SoftmaxModel => ({
  ...m,
  weights: m.weights.map((w) => w.map((v) => round(v / t))),
  bias: m.bias.map((v) => round(v / t)),
});

/** Temperature scaling (Guo et al., 2017): the T in a small grid with the lowest validation log loss. */
export function chooseTemperature(model: SoftmaxModel, xs: number[][], ys: number[]): number {
  let best = { t: 1, loss: Infinity };
  for (let t = 0.5; t <= 2.0001; t = round(t + 0.05, 2)) {
    const loss = logLossOf(scaleModel(model, t), xs, ys);
    if (loss < best.loss) best = { t, loss };
  }
  return best.t;
}

export function trainModel(config: TrainConfig = DEFAULT_CONFIG): { model: ProfileModel; report: TrainingReport } {
  const all = generateDataset(config.train + config.validation + config.test, config.seed);
  const split = (from: number, to: number) => all.slice(from, to);
  const trainSet = split(0, config.train);
  const valSet = split(config.train, config.train + config.validation);
  const testSet = split(config.train + config.validation, all.length);
  const xy = (set: SyntheticPerson[]) => ({ xs: set.map((p) => featureVector(p.input)), ys: set.map((p) => PERSON_TYPES.indexOf(p.label)) });

  const tr = xy(trainSet);
  const soft = train(tr.xs, tr.ys, [...PERSON_TYPES], [...FEATURE_NAMES], config);
  const va = xy(valSet);
  const temperature = chooseTemperature(soft, va.xs, va.ys);
  const scaled = scaleModel(soft, temperature);
  const threshold = chooseThreshold(va.xs.map((x) => predictProba(scaled, x)), va.ys, config.targetAccuracy);
  const model: ProfileModel = { ...scaled, version: MODEL_VERSION, generatorVersion: SYNTHETIC_GENERATOR_VERSION, threshold, temperature };

  const te = xy(testSet);
  const counts = PERSON_TYPES.map((_, c) => tr.ys.filter((y) => y === c).length);
  const majority = counts.indexOf(Math.max(...counts));
  const report: TrainingReport = {
    config,
    train: evaluate(tr.xs.map((x) => predictProba(model, x)), tr.ys, threshold),
    test: evaluate(te.xs.map((x) => predictProba(model, x)), te.ys, threshold),
    baselines: {
      majority: evaluate(te.ys.map(() => PERSON_TYPES.map((_, c) => (c === majority ? 1 : 0))), te.ys),
      rules: evaluate(testSet.map((p) => ruleBaseline(p.input)), te.ys),
    },
  };
  return { model, report };
}
