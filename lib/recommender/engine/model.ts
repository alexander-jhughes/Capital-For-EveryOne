// The model artifact: the contract header plus the engine body. Aggregates only (see artifact.ts).
import type { ModelHeader } from "../types";
import type { CollaborativeParams } from "./collaborative";
import type { ContentParams } from "./content";
import type { FactorizationParams } from "./factorization";
import type { PopularityParams } from "./popularity";

export const ALGORITHM = "hybrid-2: logistic + cluster-cf + item-cf + factorisation, stacked and calibrated";

/** Inputs of the stacker, in order. Each is a logit except support (log1p of the effective number of people). */
export const STACKER_INPUTS = ["content", "collaborative", "factorization", "prior", "support"] as const;

export interface StackerParams {
  /** One slope per STACKER_INPUTS entry. */
  slopes: number[];
  /** Per item (catalog order). */
  intercepts: number[];
}

export interface ModelStats {
  trainExamples: number;
  trainSubjects: number;
  validationExamples: number;
  validationSubjects: number;
  clusters: number;
  /** Out-of-fold (cross-fitted) stacker metrics on the validation examples. Null without enough validation data. */
  validationLogLoss: number | null;
  validationEce: number | null;
  /** How many items have a decision threshold (the rest are never suggested). */
  itemsWithThreshold: number;
}

export type RecommenderModel = ModelHeader & {
  /** The hyper-parameters used (for the record; inference reads only the ones stored in the components). */
  hyper: Record<string, number>;
  stats: ModelStats;
  popularity: PopularityParams;
  content: ContentParams;
  collaborative: CollaborativeParams;
  factorization: FactorizationParams;
  stacker: StackerParams;
  /** Per item: the lowest calibrated probability at which it may be suggested, or null if it never may. */
  thresholds: (number | null)[];
};

export interface TrainOptions {
  seed: number;
  version: string;
  datasetVersion: string;
  trainedOn: "synthetic" | "synthetic+real";

  /** Content: L2 penalty of each per-item logistic regression. Default 4. */
  contentL2?: number;
  /** Popularity: Beta prior strength toward the overall keep rate. Default 20. */
  popularityPrior?: number;

  /** Collaborative: k for k-means++ (capped at subjects / minClusterSize). Default 48. */
  clusters?: number;
  /** Collaborative: clusters smaller than this are merged into their nearest neighbour. Default 25. */
  minClusterSize?: number;
  /** Collaborative: per-cluster item cells with fewer people than this are suppressed. Default 5. */
  minCellCount?: number;
  /** Collaborative: Beta prior strength toward the item's global rate. Default 10. */
  clusterPrior?: number;
  /** Collaborative: kernel temperature over relative similarity. Default 0.1. */
  temperature?: number;
  /** Collaborative: k-means iterations. Default 30. */
  kmeansIterations?: number;
  /** Item-to-item: pairs seen for fewer people than this are dropped. Default 25. */
  coMinCount?: number;
  /** Item-to-item: Beta prior strength. Default 20. */
  coPrior?: number;
  /** Item-to-item: largest total log-odds shift from a person's history. Default 1.5. */
  historyClip?: number;

  /** Factorisation: embedding size. Default 8. */
  factors?: number;
  /** Factorisation: maximum epochs. Default 40. */
  epochs?: number;
  /** Factorisation: Adagrad learning rate. Default 0.05. */
  learningRate?: number;
  /** Factorisation: L2 per update. Default 0.001. */
  factorL2?: number;
  /** Factorisation: epochs without improvement on the held-out subjects before stopping. Default 4. */
  patience?: number;
  /** Factorisation: share of training subjects held out for early stopping. Default 0.15. */
  holdout?: number;

  /** Stacker: L2 on slopes and per-item intercepts. Default 1. */
  stackerL2?: number;
  /** Thresholds: lowest allowed threshold. Default 0.55. */
  thresholdFloor?: number;
  /** Thresholds: required precision on validation. Default 0.75. */
  minPrecision?: number;
  /** Thresholds: required number of validation offers at or above the threshold. Default 20. */
  minOffers?: number;
  /** Cross-fitting folds used to pick thresholds and report validation metrics. Default 5. */
  folds?: number;
}

export type Hyper = Required<Omit<TrainOptions, "seed" | "version" | "datasetVersion" | "trainedOn">>;

export const DEFAULT_HYPER: Hyper = {
  contentL2: 4,
  popularityPrior: 20,
  clusters: 48,
  minClusterSize: 25,
  minCellCount: 5,
  clusterPrior: 10,
  temperature: 0.1,
  kmeansIterations: 30,
  coMinCount: 25,
  coPrior: 20,
  historyClip: 1.5,
  factors: 8,
  epochs: 40,
  learningRate: 0.05,
  factorL2: 0.001,
  patience: 4,
  holdout: 0.15,
  stackerL2: 1,
  thresholdFloor: 0.55,
  minPrecision: 0.75,
  minOffers: 20,
  folds: 5,
};

export function resolveHyper(options: TrainOptions): Hyper {
  const out = { ...DEFAULT_HYPER };
  for (const key of Object.keys(DEFAULT_HYPER) as (keyof Hyper)[]) {
    const v = options[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}
