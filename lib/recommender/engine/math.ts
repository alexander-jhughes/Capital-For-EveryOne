// Small numeric helpers shared by the engine. Pure, deterministic, no dependencies.
import { sigmoid } from "../random";

export { sigmoid };

/** Logits are clipped to this range so one extreme component can't dominate (or overflow) the stacker. */
export const LOGIT_CLIP = 10;

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** logit(p), with p clipped away from 0 and 1. */
export function safeLogit(p: number): number {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return clamp(Math.log(q / (1 - q)), -LOGIT_CLIP, LOGIT_CLIP);
}

/** Rounds to 4 significant digits (artifact size), and never returns -0. */
export function round4(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const r = Number(x.toPrecision(4));
  return r === 0 ? 0 : r;
}

/** Rounds to a fixed number of decimals (output probabilities). */
export const roundTo = (x: number, decimals: number) => {
  const f = 10 ** decimals;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};

/**
 * Solves A x = b for a symmetric positive-definite n×n matrix (row-major), by Cholesky.
 * Overwrites nothing. Adds a tiny jitter to the diagonal if the matrix is numerically singular.
 */
export function solveSpd(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const l = new Float64Array(n * n);
  for (let attempt = 0; attempt < 4; attempt++) {
    const jitter = attempt === 0 ? 0 : 1e-8 * 100 ** attempt;
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = a[i * n + j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= l[i * n + k] * l[j * n + k];
        if (i === j) {
          if (!(s > 0)) {
            ok = false;
            break;
          }
          l[i * n + i] = Math.sqrt(s);
        } else l[i * n + j] = s / l[j * n + j];
      }
    }
    if (!ok) continue;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= l[i * n + k] * y[k];
      y[i] = s / l[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= l[k * n + i] * x[k];
      x[i] = s / l[i * n + i];
    }
    return x;
  }
  throw new Error("solveSpd: matrix is not positive definite");
}

/** Weighted mean log loss. */
export function logLoss(p: readonly number[], y: readonly number[], w?: readonly number[]): number {
  let s = 0;
  let sw = 0;
  for (let i = 0; i < p.length; i++) {
    const q = clamp(p[i], 1e-9, 1 - 1e-9);
    const wi = w ? w[i] : 1;
    s -= wi * (y[i] === 1 ? Math.log(q) : Math.log(1 - q));
    sw += wi;
  }
  return sw > 0 ? s / sw : 0;
}

/** Expected calibration error with equal-width bins (weighted). */
export function expectedCalibrationError(p: readonly number[], y: readonly number[], bins = 10, w?: readonly number[]): number {
  const sp = new Float64Array(bins);
  const sy = new Float64Array(bins);
  const sw = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    const b = Math.min(bins - 1, Math.floor(clamp(p[i], 0, 1) * bins));
    const wi = w ? w[i] : 1;
    sp[b] += wi * p[i];
    sy[b] += wi * y[i];
    sw[b] += wi;
    total += wi;
  }
  let e = 0;
  for (let b = 0; b < bins; b++) if (sw[b] > 0) e += Math.abs(sp[b] - sy[b]) / total;
  return e;
}

/** Area under the ROC curve (ties count half). */
export function auc(p: readonly number[], y: readonly number[]): number {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b] || a - b);
  let pos = 0;
  let neg = 0;
  for (const v of y) {
    if (v === 1) pos++;
    else neg++;
  }
  if (pos === 0 || neg === 0) return 0.5;
  let rankSum = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[idx[k]] === 1) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
