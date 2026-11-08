// Multinomial logistic regression (softmax regression) with L2 regularisation, trained by full-batch gradient descent.
// Chosen because it gives calibrated class probabilities, every prediction splits exactly into per-feature
// contributions (weight x value) that can be shown to the person, and it needs no ML library.

export interface SoftmaxModel {
  classes: string[];
  features: string[];
  /** weights[c][j]: class c, feature j. */
  weights: number[][];
  bias: number[];
}

export interface TrainOptions {
  epochs: number;
  learningRate: number;
  l2: number;
}

export function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function logits(model: SoftmaxModel, x: number[]): number[] {
  return model.weights.map((w, c) => w.reduce((s, wj, j) => s + wj * (x[j] ?? 0), model.bias[c]));
}

export const predictProba = (model: SoftmaxModel, x: number[]) => softmax(logits(model, x));

/** How much each feature moved class c's score above the average class. Sums (with the bias part) to the logit gap. */
export function contributions(model: SoftmaxModel, x: number[], c: number): number[] {
  const k = model.classes.length;
  return model.features.map((_, j) => {
    const mean = model.weights.reduce((s, w) => s + w[j], 0) / k;
    return (model.weights[c][j] - mean) * (x[j] ?? 0);
  });
}

export function train(xs: number[][], ys: number[], classes: string[], features: string[], opts: TrainOptions): SoftmaxModel {
  const k = classes.length;
  const d = features.length;
  const n = xs.length;
  // Flat typed arrays and plain loops: about ten times faster than the readable version, which matters for tests.
  const w = new Float64Array(k * d);
  const b = new Float64Array(k);
  const gw = new Float64Array(k * d);
  const gb = new Float64Array(k);
  const z = new Float64Array(k);
  const sparse = xs.map((x) => x.flatMap((v, j) => (v !== 0 ? [j] : [])));

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    gw.fill(0);
    gb.fill(0);
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      const nz = sparse[i];
      let max = -Infinity;
      for (let c = 0; c < k; c++) {
        let s = b[c];
        const row = c * d;
        for (const j of nz) s += w[row + j] * x[j];
        z[c] = s;
        if (s > max) max = s;
      }
      let sum = 0;
      for (let c = 0; c < k; c++) sum += z[c] = Math.exp(z[c] - max);
      for (let c = 0; c < k; c++) {
        const err = z[c] / sum - (ys[i] === c ? 1 : 0);
        gb[c] += err;
        const row = c * d;
        for (const j of nz) gw[row + j] += err * x[j];
      }
    }
    for (let c = 0; c < k; c++) {
      b[c] -= (opts.learningRate * gb[c]) / n;
      for (let j = 0; j < d; j++) w[c * d + j] -= opts.learningRate * (gw[c * d + j] / n + opts.l2 * w[c * d + j]);
    }
  }
  // Rounded so the committed file is small and the same on every machine.
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return { classes, features, weights: Array.from({ length: k }, (_, c) => Array.from(w.subarray(c * d, (c + 1) * d), round)), bias: Array.from(b, round) };
}
