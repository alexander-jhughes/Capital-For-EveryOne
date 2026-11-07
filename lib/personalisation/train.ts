// Training and evaluation pipeline. Pure and deterministic: the same config always gives the same model.
// Run it with scripts/personalisation/train.ts, which writes model.json and the evaluation report.
import { MODEL_FORMAT, MODEL_FORMAT_VERSION, type ModelArtifact, type TargetModel } from "./artifact";
import { extractFeatures, FEATURE_IDS } from "./features";
import { type ForestOptions, predictProba, trainForest, type Tree } from "./forest";
import { binaryMetrics, type BinaryMetrics, recommendationMetrics } from "./metrics";
import { DEFAULT_SYNTHETIC, generateSynthetic, splitIndices, SYNTHETIC_GENERATOR_VERSION, type SyntheticOptions, type SyntheticPerson } from "./synthetic";
import { TARGET_IDS, type TargetId, targetStatus } from "./targets";

export interface TrainConfig {
  data: SyntheticOptions;
  forest: Omit<ForestOptions, "seed">;
  /** A target is only ever offered if, on validation data, at least this share of offers would be kept. */
  minKeepRate: number;
  /** ...and at least this many validation people would get the offer (so the rate isn't luck). */
  minOffered: number;
  /** No threshold below this, however good validation looks. */
  thresholdFloor: number;
}

export const DEFAULT_CONFIG: TrainConfig = {
  data: DEFAULT_SYNTHETIC,
  forest: { trees: 30, maxDepth: 5, minLeaf: 30, featuresPerSplit: 6, bootstrap: true },
  minKeepRate: 0.8,
  minOffered: 20,
  thresholdFloor: 0.6,
};

/** Model families compared in the report. The forest is the one shipped. */
const SINGLE_TREE: Omit<ForestOptions, "seed"> = { trees: 1, maxDepth: 8, minLeaf: 5, featuresPerSplit: 0, bootstrap: false };
const STUMP: Omit<ForestOptions, "seed"> = { trees: 1, maxDepth: 1, minLeaf: 5, featuresPerSplit: 0, bootstrap: false };

export interface Dataset {
  X: number[][];
  y: Record<TargetId, number[]>;
  /** Only people with the setting currently off can be offered it, so only they are used for that target. */
  eligible: Record<TargetId, boolean[]>;
}

export function buildDataset(people: SyntheticPerson[]): Dataset {
  const X = people.map((p) => extractFeatures(p.input, p.signals));
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
  return `rf-1.0.0+synthetic.g${SYNTHETIC_GENERATOR_VERSION}.s${cfg.data.seed}`;
}

export function trainModel(cfg: TrainConfig = DEFAULT_CONFIG): { model: ModelArtifact; report: TrainingReport } {
  const people = generateSynthetic(cfg.data);
  const data = buildDataset(people);
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

    const threshold = chooseThreshold(ys(validation), proba(forest, validation), cfg);
    const testY = ys(test);
    const forestTest = proba(forest, test);
    const at = threshold ?? 0.5;

    const testForest = binaryMetrics(testY, forestTest, at);
    const testSingle = binaryMetrics(testY, proba(single, test), 0.5);
    const trainForestM = binaryMetrics(ys(train), proba(forest, train), at);
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
    };
    targets[id] = { threshold, baseRate, trees: forest };
    nodes += forest.reduce((s, t) => s + t.f.length, 0);
  });

  const modelVersion = modelVersionFor(cfg);
  const model: ModelArtifact = {
    format: MODEL_FORMAT,
    formatVersion: MODEL_FORMAT_VERSION,
    modelVersion,
    trainedOn: "synthetic",
    generatorVersion: SYNTHETIC_GENERATOR_VERSION,
    seed: cfg.data.seed,
    features: FEATURE_IDS,
    targets,
  };
  return {
    model,
    report: {
      config: cfg,
      modelVersion,
      people: { train: split.train.length, validation: split.validation.length, test: split.test.length },
      features: FEATURE_IDS.length,
      nodes,
      targets: reports,
    },
  };
}
