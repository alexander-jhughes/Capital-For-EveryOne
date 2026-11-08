// Dial personalisation v2: the hybrid recommendation engine (WS2 + WS3). Public API, as in
// docs/ml-personalisation/v2/CONTRACT.md §7. Pure TypeScript, no I/O, deterministic for a given seed; runs in
// Node and in the browser.
//
//   encode (features.ts) ─► content (logistic) ─┐
//                         ─► collaborative ─────┤
//                         ─► factorisation ─────┼─► stacker (calibrated, fitted on validation) ─► policy + bundle
//                         ─► popularity ────────┘                                                 (recommend.ts)
export type { RecommenderModel, TrainOptions } from "./model";
export { DEFAULT_HYPER, STACKER_INPUTS } from "./model";
export { isValidRecommenderModel, artifactBytes } from "./artifact";
export { recommend, scoreItems, evidenceLevel, POLICY } from "./recommend";
export { trainRecommender, trainComponentScorers, MIN_VALIDATION_EXAMPLES, type Scorer } from "./train";
export { FEATURE_IDS, FEATURES, encode } from "./features";
export { weightedCosine, SIMILARITY_WEIGHTS } from "./similarity";
