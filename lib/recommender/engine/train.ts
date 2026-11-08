// Training: components on `train`, the stacker (calibration) and per-item thresholds on `validation`.
// Deterministic for a given seed and data: the same inputs give a byte-identical artifact.
import { ITEM_IDS, type ItemId } from "../catalog";
import type { RecommenderInput, TrainingExample } from "../types";
import { roundDeep } from "./artifact";
import { trainCollaborative } from "./collaborative";
import { trainContent } from "./content";
import { bySubject, prepareExamples, type PreparedExample, toDense } from "./data";
import { trainFactorization } from "./factorization";
import { FEATURE_COUNT, FEATURE_IDS } from "./features";
import { ALGORITHM, type Hyper, type ModelStats, type RecommenderModel, resolveHyper, type StackerParams, type TrainOptions } from "./model";
import { trainPopularity } from "./popularity";
import { componentProbabilities, computeRawEncoded, prepare, stackerInputs } from "./score";
import { SIMILARITY_WEIGHTS } from "./similarity";
import { chooseThresholds, crossFittedProbabilities, FALLBACK_STACKER, fitStacker, stackerMetrics, type StackerRow } from "./stacker";
import { rng } from "../random";

export type { TrainOptions } from "./model";

/** Probabilities per item, for benchmarking each component on its own. */
export type Scorer = (input: RecommenderInput) => Partial<Record<ItemId, number>>;

/** Validation needs at least this many examples to fit a stacker and thresholds; otherwise nothing is ever suggested. */
export const MIN_VALIDATION_EXAMPLES = 100;

const deriveSeed = (seed: number, salt: number) => (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) + salt) >>> 0;

function checkOptions(o: TrainOptions) {
  if (!o || typeof o.version !== "string" || o.version.length === 0) throw new Error("trainRecommender: options.version is required");
  if (typeof o.datasetVersion !== "string" || o.datasetVersion.length === 0) throw new Error("trainRecommender: options.datasetVersion is required");
  if (o.trainedOn !== "synthetic" && o.trainedOn !== "synthetic+real") throw new Error("trainRecommender: options.trainedOn must be synthetic or synthetic+real");
  if (!Number.isFinite(o.seed)) throw new Error("trainRecommender: options.seed must be a number");
}

/** Fits the four components on training examples and returns an artifact with a placeholder stacker. */
function fitComponents(data: PreparedExample[], hyper: Hyper, options: TrainOptions, stats: ModelStats): RecommenderModel {
  const popularity = trainPopularity(data, hyper.popularityPrior);
  const content = trainContent(data, hyper.contentL2, popularity.rate);
  const collaborative = trainCollaborative(
    data,
    popularity.rate,
    SIMILARITY_WEIGHTS,
    {
      clusters: Math.max(1, Math.round(hyper.clusters)),
      minClusterSize: Math.max(1, Math.round(hyper.minClusterSize)),
      minCellCount: hyper.minCellCount,
      priorStrength: hyper.clusterPrior,
      coMinCount: hyper.coMinCount,
      coPrior: hyper.coPrior,
      temperature: hyper.temperature,
      historyClip: hyper.historyClip,
      iterations: Math.max(1, Math.round(hyper.kmeansIterations)),
    },
    rng(deriveSeed(options.seed, 1)),
  );
  const factorization = trainFactorization(
    data,
    popularity.rate,
    {
      factors: Math.max(1, Math.min(64, Math.round(hyper.factors))),
      epochs: Math.max(1, Math.round(hyper.epochs)),
      learningRate: hyper.learningRate,
      l2: hyper.factorL2,
      patience: Math.max(1, Math.round(hyper.patience)),
      holdout: hyper.holdout,
      initScale: 0.05,
    },
    deriveSeed(options.seed, 2),
  );
  return {
    format: "cfe-recommender",
    formatVersion: 1,
    version: options.version,
    algorithm: ALGORITHM,
    trainedOn: options.trainedOn,
    datasetVersion: options.datasetVersion,
    featureIds: [...FEATURE_IDS],
    items: [...ITEM_IDS],
    hyper: { ...hyper },
    stats: { ...stats, clusters: collaborative.centroids.length },
    popularity,
    content,
    collaborative,
    factorization,
    stacker: FALLBACK_STACKER,
    thresholds: ITEM_IDS.map(() => null),
  };
}

const emptyStats = (train: PreparedExample[], validation: PreparedExample[]): ModelStats => ({
  trainExamples: train.length,
  trainSubjects: bySubject(train).size,
  validationExamples: validation.length,
  validationSubjects: bySubject(validation).size,
  clusters: 0,
  validationLogLoss: null,
  validationEce: null,
  itemsWithThreshold: 0,
});

/** Stacker inputs for each validation example, computed with the (rounded) component artifact. */
function stackerRows(model: RecommenderModel, examples: readonly PreparedExample[]): StackerRow[] {
  const p = prepare(model);
  const x = new Float64Array(FEATURE_COUNT);
  return examples.map((e) => {
    const raw = computeRawEncoded(p, toDense(e.x, x), e.history);
    return { inputs: stackerInputs(p, raw, e.item), item: e.item, y: e.y, w: e.w, subject: e.subject };
  });
}

export function trainRecommender(train: TrainingExample[], validation: TrainingExample[], options: TrainOptions): RecommenderModel {
  checkOptions(options);
  const hyper = resolveHyper(options);
  const trainData = prepareExamples(train);
  const validationData = prepareExamples(validation);
  const components = roundDeep(fitComponents(trainData, hyper, options, emptyStats(trainData, validationData)));

  let stacker: StackerParams = FALLBACK_STACKER;
  let thresholds: (number | null)[] = ITEM_IDS.map(() => null);
  let metrics: { logLoss: number; ece: number } | null = null;
  if (validationData.length >= MIN_VALIDATION_EXAMPLES) {
    const rows = stackerRows(components, validationData);
    const folds = Math.max(2, Math.round(hyper.folds));
    const oof = crossFittedProbabilities(rows, hyper.stackerL2, folds, deriveSeed(options.seed, 3));
    thresholds = chooseThresholds(oof, rows, { floor: hyper.thresholdFloor, minPrecision: hyper.minPrecision, minOffers: hyper.minOffers });
    metrics = stackerMetrics(oof, rows);
    stacker = fitStacker(rows, hyper.stackerL2);
  }
  return roundDeep({
    ...components,
    stats: {
      ...components.stats,
      validationLogLoss: metrics ? metrics.logLoss : null,
      validationEce: metrics ? metrics.ece : null,
      itemsWithThreshold: thresholds.filter((t) => t !== null).length,
    },
    stacker,
    thresholds,
  });
}

/** Each component trained on `train` alone (no stacker), as probability scorers over all items. */
export function trainComponentScorers(
  train: TrainingExample[],
  options: TrainOptions,
): { content: Scorer; collaborative: Scorer; factorization: Scorer; popularity: Scorer } {
  checkOptions(options);
  const hyper = resolveHyper(options);
  const data = prepareExamples(train);
  const model = roundDeep(fitComponents(data, hyper, options, emptyStats(data, [])));
  // Benchmarks usually call all four scorers on the same input: score it once.
  let lastInput: RecommenderInput | null = null;
  let last: ReturnType<typeof componentProbabilities> | null = null;
  const scores = (input: RecommenderInput) => {
    if (input !== lastInput || !last) {
      last = componentProbabilities(model, input);
      lastInput = input;
    }
    return last;
  };
  return {
    content: (input) => ({ ...scores(input).content }),
    collaborative: (input) => ({ ...scores(input).collaborative }),
    factorization: (input) => ({ ...scores(input).factorization }),
    popularity: (input) => ({ ...scores(input).popularity }),
  };
}
