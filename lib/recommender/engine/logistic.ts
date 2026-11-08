// L2-regularised logistic regression by IRLS (Newton's method), on sparse rows. Deterministic: no randomness,
// fixed summation order. Used by the content component (one model per item) and by the stacker.
import { safeLogit, solveSpd } from "./math";

export interface LogisticRow {
  idx: Int32Array | readonly number[];
  val: Float64Array | readonly number[];
  y: number;
  w: number;
}

export interface LogisticFit {
  weights: Float64Array;
  intercept: number;
}

export interface LogisticOptions {
  /** L2 penalty (0.5·λ·β²) per weight, or one value for all. */
  l2: number | ArrayLike<number>;
  /** Penalty on the intercept. Default 1e-4 (practically free). */
  interceptL2?: number;
  maxIter?: number;
  tol?: number;
}

function penalisedLoss(rows: readonly LogisticRow[], theta: Float64Array, n: number, lambda: Float64Array): number {
  let loss = 0;
  for (const r of rows) {
    let z = theta[n];
    for (let k = 0; k < r.idx.length; k++) z += theta[r.idx[k]] * r.val[k];
    // log(1 + e^z) − y z, computed stably
    const softplus = z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
    loss += r.w * (softplus - r.y * z);
  }
  for (let j = 0; j <= n; j++) loss += 0.5 * lambda[j] * theta[j] * theta[j];
  return loss;
}

export function fitLogistic(rows: readonly LogisticRow[], nFeatures: number, options: LogisticOptions): LogisticFit {
  const n = nFeatures;
  const dim = n + 1; // last coefficient is the intercept
  const lambda = new Float64Array(dim);
  for (let j = 0; j < n; j++) lambda[j] = typeof options.l2 === "number" ? options.l2 : options.l2[j];
  lambda[n] = options.interceptL2 ?? 1e-4;
  const maxIter = options.maxIter ?? 50;
  const tol = options.tol ?? 1e-7;

  const theta = new Float64Array(dim);
  let sw = 0;
  let sy = 0;
  for (const r of rows) {
    sw += r.w;
    sy += r.w * r.y;
  }
  if (sw <= 0) return { weights: new Float64Array(n), intercept: 0 };
  theta[n] = safeLogit((sy + 0.5) / (sw + 1));

  let loss = penalisedLoss(rows, theta, n, lambda);
  const h = new Float64Array(dim * dim);
  const g = new Float64Array(dim);
  for (let iter = 0; iter < maxIter; iter++) {
    h.fill(0);
    g.fill(0);
    for (const r of rows) {
      let z = theta[n];
      for (let k = 0; k < r.idx.length; k++) z += theta[r.idx[k]] * r.val[k];
      const p = 1 / (1 + Math.exp(-z));
      const s = r.w * p * (1 - p);
      const res = r.w * (r.y - p);
      const m = r.idx.length;
      for (let a = 0; a < m; a++) {
        const ia = r.idx[a];
        const va = r.val[a];
        g[ia] += res * va;
        const sva = s * va;
        for (let b = 0; b <= a; b++) {
          const ib = r.idx[b];
          if (ia >= ib) h[ia * dim + ib] += sva * r.val[b];
          else h[ib * dim + ia] += sva * r.val[b];
        }
        h[n * dim + ia] += sva;
      }
      g[n] += res;
      h[n * dim + n] += s;
    }
    // Only the lower triangle was filled: mirror it.
    for (let i = 0; i < dim; i++) {
      h[i * dim + i] += lambda[i];
      g[i] -= lambda[i] * theta[i];
      for (let j = 0; j < i; j++) h[j * dim + i] = h[i * dim + j];
    }
    const delta = solveSpd(h, g, dim);
    let step = 1;
    const next = new Float64Array(dim);
    let nextLoss = Infinity;
    for (let halvings = 0; halvings < 20; halvings++) {
      for (let j = 0; j < dim; j++) next[j] = theta[j] + step * delta[j];
      nextLoss = penalisedLoss(rows, next, n, lambda);
      if (nextLoss <= loss + 1e-12) break;
      step /= 2;
    }
    if (!(nextLoss <= loss + 1e-12)) break;
    let maxDelta = 0;
    for (let j = 0; j < dim; j++) maxDelta = Math.max(maxDelta, Math.abs(next[j] - theta[j]));
    theta.set(next);
    const improvement = loss - nextLoss;
    loss = nextLoss;
    if (maxDelta < tol || improvement < tol * Math.max(1, sw) * 1e-3) break;
  }
  return { weights: theta.slice(0, n), intercept: theta[n] };
}
