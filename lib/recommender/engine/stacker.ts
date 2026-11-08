// Component 5: the hybrid stacker and calibration, fitted on the validation examples (never on the training
// examples the components were fitted on), so its output is a calibrated probability.
//   logit P(keep) = a_item + Σ_k s_k · input_k,  inputs = [logit content, logit collaborative, logit factorisation,
//                                                         logit prior, log1p(support)]
// Per-item decision thresholds are chosen on cross-fitted (out-of-fold) stacker predictions, so the precision a
// threshold promises was measured on examples the stacker had not seen.
import { rng, shuffle } from "../random";
import { ITEM_COUNT } from "./data";
import { fitLogistic, type LogisticRow } from "./logistic";
import { expectedCalibrationError, logLoss, sigmoid } from "./math";
import { STACKER_INPUTS, type StackerParams } from "./model";

export interface StackerRow {
  inputs: number[];
  item: number;
  y: 0 | 1;
  w: number;
  subject: string;
}

const K = STACKER_INPUTS.length;

/** Used when there is no validation data: the mean of the three learned components' logits. Never thresholded. */
export const FALLBACK_STACKER: StackerParams = { slopes: [1 / 3, 1 / 3, 1 / 3, 0, 0], intercepts: new Array<number>(ITEM_COUNT).fill(0) };

export function fitStacker(rows: readonly StackerRow[], l2: number): StackerParams {
  const data: LogisticRow[] = rows.map((r) => ({ idx: [0, 1, 2, 3, 4, K + r.item], val: [...r.inputs, 1], y: r.y, w: r.w }));
  const fit = fitLogistic(data, K + ITEM_COUNT, { l2, interceptL2: 1e-4 });
  return {
    slopes: Array.from(fit.weights.subarray(0, K)),
    intercepts: Array.from({ length: ITEM_COUNT }, (_, i) => fit.intercept + fit.weights[K + i]),
  };
}

export function stackerProbability(s: StackerParams, r: StackerRow): number {
  let z = s.intercepts[r.item];
  for (let k = 0; k < K; k++) z += s.slopes[k] * r.inputs[k];
  return sigmoid(z);
}

/** Out-of-fold stacker probabilities: subjects are split into folds, each fold scored by a stacker fitted on the rest. */
export function crossFittedProbabilities(rows: readonly StackerRow[], l2: number, folds: number, seed: number): Float64Array {
  const subjects = [...new Set(rows.map((r) => r.subject))];
  shuffle(rng(seed), subjects);
  const fold = new Map(subjects.map((s, i) => [s, i % folds]));
  const out = new Float64Array(rows.length);
  for (let f = 0; f < folds; f++) {
    const fitRows = rows.filter((r) => fold.get(r.subject) !== f);
    if (fitRows.length === rows.length) continue;
    const s = fitRows.length > 0 ? fitStacker(fitRows, l2) : FALLBACK_STACKER;
    rows.forEach((r, i) => {
      if (fold.get(r.subject) === f) out[i] = stackerProbability(s, r);
    });
  }
  return out;
}

export interface ThresholdOptions {
  floor: number;
  minPrecision: number;
  minOffers: number;
}

/**
 * Per item: the lowest threshold ≥ floor (in steps of 0.01) at which at least `minOffers` validation examples
 * would have been offered and at least `minPrecision` of them (weighted) were kept. Null when no threshold meets
 * both: that item is never suggested.
 */
export function chooseThresholds(p: ArrayLike<number>, rows: readonly StackerRow[], o: ThresholdOptions): (number | null)[] {
  const out: (number | null)[] = [];
  for (let item = 0; item < ITEM_COUNT; item++) {
    const idx: number[] = [];
    rows.forEach((r, i) => {
      if (r.item === item) idx.push(i);
    });
    let chosen: number | null = null;
    for (let step = Math.round(o.floor * 100); step <= 99; step++) {
      const t = step / 100;
      let offers = 0;
      let kept = 0;
      let weight = 0;
      for (const i of idx) {
        if (p[i] < t) continue;
        offers++;
        kept += rows[i].w * rows[i].y;
        weight += rows[i].w;
      }
      if (offers < o.minOffers) break; // higher thresholds only offer fewer
      if (weight > 0 && kept / weight >= o.minPrecision) {
        chosen = t;
        break;
      }
    }
    out.push(chosen);
  }
  return out;
}

export function stackerMetrics(p: ArrayLike<number>, rows: readonly StackerRow[]) {
  const pp = Array.from(p);
  const y = rows.map((r) => r.y);
  const w = rows.map((r) => r.w);
  return { logLoss: logLoss(pp, y, w), ece: expectedCalibrationError(pp, y, 10, w) };
}
