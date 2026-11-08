// Scoring: the learned part. Every component scores every item; the stacker combines them into one calibrated
// probability. No eligibility, policy or thresholds here (see recommend.ts).
import { ITEM_IDS } from "../catalog";
import type { HistoryEntry, RecommenderInput } from "../types";
import { isValidRecommenderModel } from "./artifact";
import { prepareCollaborative, type PreparedCollaborative, scoreCollaborative } from "./collaborative";
import { ITEM_COUNT } from "./data";
import { encodeNormalised, FEATURE_COUNT, type NormalisedInput, normaliseInput } from "./features";
import { prepareFactorization, type PreparedFactorization, scoreFactorization } from "./factorization";
import { clamp, LOGIT_CLIP, safeLogit, sigmoid } from "./math";
import { type RecommenderModel, STACKER_INPUTS, type StackerParams } from "./model";

export interface PreparedModel {
  contentW: Float64Array;
  contentB: Float64Array;
  collaborative: PreparedCollaborative;
  factorization: PreparedFactorization;
  prior: number[];
  priorLogit: Float64Array;
  stacker: StackerParams;
}

const preparedCache = new WeakMap<object, PreparedModel>();
const validCache = new WeakSet<object>();

/** True if the model passed the full structural check (cached per model object). */
export function isUsableModel(m: unknown): m is RecommenderModel {
  if (typeof m !== "object" || m === null) return false;
  if (validCache.has(m)) return true;
  if (!isValidRecommenderModel(m)) return false;
  validCache.add(m);
  return true;
}

/** Derived, fast structures for one model object, built once (models are treated as immutable). */
export function prepare(model: RecommenderModel): PreparedModel {
  const hit = preparedCache.get(model);
  if (hit) return hit;
  const p: PreparedModel = {
    contentW: Float64Array.from(model.content.weights.flat()),
    contentB: Float64Array.from(model.content.intercept),
    collaborative: prepareCollaborative(model.collaborative),
    factorization: prepareFactorization(model.factorization),
    prior: model.popularity.rate,
    priorLogit: Float64Array.from(model.popularity.rate.map(safeLogit)),
    stacker: model.stacker,
  };
  preparedCache.set(model, p);
  return p;
}

/** Raw component outputs for every item (catalog order). Logits are clipped to ±LOGIT_CLIP. */
export interface RawScores {
  x: Float64Array;
  content: Float64Array;
  collaborative: Float64Array;
  support: Float64Array;
  factorization: Float64Array;
  probability: Float64Array;
}

export function computeRaw(p: PreparedModel, n: NormalisedInput): RawScores {
  return computeRawEncoded(p, encodeNormalised(n, new Float64Array(FEATURE_COUNT)) as Float64Array, n.history);
}

/** As computeRaw, from an already encoded input and the person's history. */
export function computeRawEncoded(p: PreparedModel, x: Float64Array, history: readonly HistoryEntry[]): RawScores {
  const content = new Float64Array(ITEM_COUNT);
  const nz: number[] = [];
  for (let f = 0; f < FEATURE_COUNT; f++) if (x[f] !== 0) nz.push(f);
  for (let i = 0; i < ITEM_COUNT; i++) {
    let z = p.contentB[i];
    const base = i * FEATURE_COUNT;
    for (const f of nz) z += p.contentW[base + f] * x[f];
    content[i] = clamp(z, -LOGIT_CLIP, LOGIT_CLIP);
  }
  const collaborative = new Float64Array(ITEM_COUNT);
  const support = new Float64Array(ITEM_COUNT);
  scoreCollaborative(p.collaborative, x, history, p.prior, collaborative, support);
  const factorization = new Float64Array(ITEM_COUNT);
  scoreFactorization(p.factorization, x, factorization);
  for (let i = 0; i < ITEM_COUNT; i++) factorization[i] = clamp(factorization[i], -LOGIT_CLIP, LOGIT_CLIP);
  const raw: RawScores = { x, content, collaborative, support, factorization, probability: new Float64Array(ITEM_COUNT) };
  for (let i = 0; i < ITEM_COUNT; i++) raw.probability[i] = sigmoid(stackerLogit(p.stacker, stackerInputs(p, raw, i), i));
  return raw;
}

/** The stacker's inputs for one item, in STACKER_INPUTS order. */
export function stackerInputs(p: PreparedModel, raw: Omit<RawScores, "probability">, i: number): number[] {
  return [raw.content[i], safeLogit(raw.collaborative[i]), raw.factorization[i], p.priorLogit[i], Math.log1p(raw.support[i])];
}

export function stackerLogit(s: StackerParams, inputs: readonly number[], item: number): number {
  let z = s.intercepts[item];
  for (let k = 0; k < STACKER_INPUTS.length; k++) z += s.slopes[k] * inputs[k];
  return z;
}

/** Component probabilities for one input, without the stacker (for benchmarking components on their own). */
export function componentProbabilities(model: RecommenderModel, input: RecommenderInput) {
  const p = prepare(model);
  const raw = computeRaw(p, normaliseInput(input));
  const pick = (f: (i: number) => number) => Object.fromEntries(ITEM_IDS.map((id, i) => [id, f(i)]));
  return {
    content: pick((i) => sigmoid(raw.content[i])),
    collaborative: pick((i) => raw.collaborative[i]),
    factorization: pick((i) => sigmoid(raw.factorization[i])),
    popularity: pick((i) => p.prior[i]),
    hybrid: pick((i) => raw.probability[i]),
  };
}
