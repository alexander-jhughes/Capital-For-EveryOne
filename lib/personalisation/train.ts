// Training and evaluation pipeline. Pure and deterministic: the same config always gives the same model.
// Run it with scripts/personalisation/train.ts, which writes model.json and the evaluation report.
import { FORMAT_FEATURES, MODEL_FORMAT, type ModelArtifact, type TargetModel } from "./artifact";
import { calibrate, fitIsotonic } from "./calibration";
import { extractFeatures } from "./features";
import { type ForestOptions, predictProba, trainForest, type Tree } from "./forest";
import { binaryMetrics, type BinaryMetrics, ece, recommendationMetrics } from "./metrics";
import { DEFAULT_SYNTHETIC, generateSynthetic, servedPopulation, splitIndices, type SyntheticOptions, type SyntheticPerson } from "./synthetic";
import { TARGET_IDS, type TargetId, targetStatus } from "./targets";

export interface TrainConfig {
  /**
   * 1: the shipped v1 pipeline (28 features, everyone in the sample, raw probabilities, model format 1).
   * 2: the v2 candidate (all features, only people the app can score, isotonic calibration on validation, format 2).
   */
  pipeline: 1 | 2;
  data: SyntheticOptions;
  forest: Omit<ForestOptions, "seed">;
  /** A target is only ever offered if, on validation data, at least this share of offers would be kept. */
  minKeepRate: number;
  /** ...and at least this many validation people would get the offer (so the rate isn't luck). */
  minOffered: number;
  /** No threshold below this, however good validation looks. */
  thresholdFloor: number;
}

/** Exactly reproduces the committed model.json (model v1). */
export const V1_CONFIG: TrainConfig = {
  pipeline: 1,
  data: { people: 20000, seed: 20261107, labelNoise: 0.05, version: 1 },
  forest: { trees: 30, maxDepth: 5, minLeaf: 30, featuresPerSplit: 6, bootstrap: true },
  minKeepRate: 0.8,
  minOffered: 20,
  thresholdFloor: 0.6,
};

/** The v2 candidate. It did not pass the retraining rule (docs/ml-personalisation/EVALUATION-v2.md), so it is not shipped. */
export const V2_CONFIG: TrainConfig = { ...V1_CONFIG, pipeline: 2, data: DEFAULT_SYNTHETIC };

/** What the training script trains and `--check` compares with model.json. Switch to V2_CONFIG only if v2 passes the rule. */
export const DEFAULT_CONFIG: TrainConfig = V1_CONFIG;

/** Model families compared in the report. The forest is the one shipped. */
const SINGLE_TREE: Omit<ForestOptions, "seed"> = { trees: 1, maxDepth: 8, minLeaf: 5, featuresPerSplit: 0, bootstrap: false };
const STUMP: Omit<ForestOptions, "seed"> = { trees: 1, maxDepth: 1, minLeaf: 5, featuresPerSplit: 0, bootstrap: false };

export interface Dataset {
  X: number[][];
  y: Record<TargetId, number[]>;
  /** Only people with the setting currently off can be offered it, so only they are used for that target. */
  eligible: Record<TargetId, boolean[]>;
}

export function buildDataset(people: SyntheticPerson[], featureCount?: number): Dataset {
  const X = people.map((p) => extractFeatures(p.input, p.signals).slice(0, featureCount));
  const y = Object.fromEntries(TARGET_IDS.map((id) => [id, people.map((p) => p.labels[id])])) as Dataset["y"];
  const eligible = Object.fromEntries(TARGET_IDS.map((id) => [id, people.map((p) => targetStatus(id, p.input.preferences) === "off")])) as Dataset["eligible"];
  return { X, y, eligible };
}

export interface TargetReport {
  eligible: { train: number; validation: number; test: number };
  baseRate: number;
  threshold: number | null;
  test: { majority: BinaryMetrics; stump: BinaryMetrics; singleTree: BinaryMetrics; forest: BinaryMetrics };
  train: { singleTree: BinaryMetrics; forest: BinaryMetrics };
  /** Train AUC minus test AUC. Large gaps mean memorising rather than learning. */
  overfitGap: { singleTree: number | null; forest: number | null };
  /** At the chosen threshold, on test people. */
  recommendations: { offered: number; coverage: number; keepRate: number | null } | null;
  /** Test expected calibration error of the forest's raw vote share and after the validation-fitted calibration. */
  ece: { raw: number | null; calibrated: number | null };
}

export interface TrainingReport {
  config: TrainConfig;
  modelVersion: string;
  people: { train: number; validation: number; test: number };
  features: number;
  nodes: number;
  targets: Record<TargetId, TargetReport>;
}

const THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const gap = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) * 1e4) / 1e4);

export function chooseThreshold(y: number[], p: number[], cfg: Pick<TrainConfig, "minKeepRate" | "minOffered" | "thresholdFloor">): number | null {
  for (const t of THRESHOLDS) {
    if (t < cfg.thresholdFloor) continue;
    const r = recommendationMetrics(y, p, t);
    if (r.offered >= cfg.minOffered && r.keepRate !== null && r.keepRate >= cfg.minKeepRate) return t;
  }
  return null;
}

export function modelVersionFor(cfg: TrainConfig) {
  return `rf-${cfg.pipeline}.0.0+synthetic.g${cfg.data.version ?? DEFAULT_SYNTHETIC.version ?? 2}.s${cfg.data.seed}`;
}

/**
 * Pipeline 2 trains only on the people the app can actually score (servedPopulation): consented, current schema, no
 * Make it yours ticks; pipeline 1 (v1) used everyone. `everyone` defaults to generator A from `cfg.data`; the evaluation
 * passes generator B to get a reference model (never shipped).
 */
export function trainModel(cfg: TrainConfig = DEFAULT_CONFIG, everyone: SyntheticPerson[] = generateSynthetic(cfg.data)): { model: ModelArtifact; report: TrainingReport } {
  const v2 = cfg.pipeline === 2;
  const features = FORMAT_FEATURES[cfg.pipeline];
  const people = v2 ? servedPopulation(everyone) : everyone;
  const data = buildDataset(people, features.length);
  const split = splitIndices(people.length, cfg.data.seed);
  const targets = {} as Record<TargetId, TargetModel>;
  const reports = {} as Record<TargetId, TargetReport>;
  let nodes = 0;

  TARGET_IDS.forEach((id, k) => {
    const rows = (part: number[]) => part.filter((i) => data.eligible[id][i]);
    const train = rows(split.train);
    const validation = rows(split.validation);
    const test = rows(split.test);
    const y = data.y[id];
    const ys = (part: number[]) => part.map((i) => y[i]);
    const proba = (trees: Tree[], part: number[]) => part.map((i) => predictProba(trees, data.X[i]));
    const seed = cfg.data.seed + 101 * (k + 1);

    const forest = trainForest(data.X, y, train, { ...cfg.forest, seed });
    const single = trainForest(data.X, y, train, { ...SINGLE_TREE, seed });
    const stump = trainForest(data.X, y, train, { ...STUMP, seed });
    const baseRate = Math.round((ys(train).reduce((s, v) => s + v, 0) / Math.max(train.length, 1)) * 1e4) / 1e4;

    // Calibration is fitted on validation only; thresholds are then chosen on calibrated validation probabilities.
    const calibration = v2 ? fitIsotonic(ys(validation), proba(forest, validation)) : null;
    const calibrated = (part: number[]) => proba(forest, part).map((p) => (calibration ? calibrate(calibration, p) : p));
    const threshold = chooseThreshold(ys(validation), calibrated(validation), cfg);
    const testY = ys(test);
    const forestRawTest = proba(forest, test);
    const forestTest = calibrated(test);
    const at = threshold ?? 0.5;

    const testForest = binaryMetrics(testY, forestTest, at);
    const testSingle = binaryMetrics(testY, proba(single, test), 0.5);
    const trainForestM = binaryMetrics(ys(train), calibrated(train), at);
    const trainSingle = binaryMetrics(ys(train), proba(single, train), 0.5);

    reports[id] = {
      eligible: { train: train.length, validation: validation.length, test: test.length },
      baseRate,
      threshold,
      test: {
        majority: binaryMetrics(testY, testY.map(() => baseRate), 0.5),
        stump: binaryMetrics(testY, proba(stump, test), 0.5),
        singleTree: testSingle,
        forest: testForest,
      },
      train: { singleTree: trainSingle, forest: trainForestM },
      overfitGap: { singleTree: gap(trainSingle.auc, testSingle.auc), forest: gap(trainForestM.auc, testForest.auc) },
      recommendations: threshold === null ? null : recommendationMetrics(testY, forestTest, threshold),
      ece: { raw: ece(testY, forestRawTest), calibrated: ece(testY, forestTest) },
    };
    targets[id] = calibration ? { threshold, baseRate, calibration, trees: forest } : { threshold, baseRate, trees: forest };
    nodes += forest.reduce((s, t) => s + t.f.length, 0);
  });

  const modelVersion = modelVersionFor(cfg);
  const model: ModelArtifact = {
    format: MODEL_FORMAT,
    formatVersion: cfg.pipeline,
    modelVersion,
    trainedOn: "synthetic",
    generatorVersion: cfg.data.version ?? DEFAULT_SYNTHETIC.version ?? 2,
    seed: cfg.data.seed,
    features,
    targets,
  };
  return {
    model,
    report: {
      config: cfg,
      modelVersion,
      people: { train: split.train.length, validation: split.validation.length, test: split.test.length },
      features: features.length,
      nodes,
      targets: reports,
    },
  };
}
