// Standard binary-classification metrics. Pure functions, no dependencies.

export interface BinaryMetrics {
  n: number;
  positives: number;
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Area under the ROC curve: 0.5 is guessing, 1 is perfect ranking. */
  auc: number | null;
  /** Mean squared error of the probabilities: lower is better; always guessing the base rate is the reference. */
  brier: number;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Mann-Whitney AUC with ties counted as half. */
export function auc(y: number[], p: number[]): number | null {
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (pos === 0 || neg === 0) return null;
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  let rankSumPos = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (y[order[k][1]] === 1) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function binaryMetrics(y: number[], p: number[], threshold: number): BinaryMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let sq = 0;
  for (let i = 0; i < y.length; i++) {
    const pred = p[i] >= threshold ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1) fp++;
    else if (y[i] === 1) fn++;
    else tn++;
    sq += (p[i] - y[i]) ** 2;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const a = auc(y, p);
  return {
    n: y.length,
    positives: tp + fn,
    accuracy: r4(y.length ? (tp + tn) / y.length : 0),
    precision: precision === null ? null : r4(precision),
    recall: recall === null ? null : r4(recall),
    f1: f1 === null ? null : r4(f1),
    auc: a === null ? null : r4(a),
    brier: r4(y.length ? sq / y.length : 0),
  };
}

/** Of the people we would make a suggestion to, the share who would keep it, and how many people get one. */
export function recommendationMetrics(y: number[], p: number[], threshold: number) {
  const offered = p.map((v, i) => (v >= threshold ? i : -1)).filter((i) => i >= 0);
  const kept = offered.filter((i) => y[i] === 1).length;
  return {
    offered: offered.length,
    coverage: r4(y.length ? offered.length / y.length : 0),
    keepRate: offered.length ? r4(kept / offered.length) : null,
  };
}

export interface ReliabilityBin {
  /** Bin covers predicted probabilities in [lo, hi) (the last bin includes 1). */
  lo: number;
  hi: number;
  n: number;
  /** Mean predicted probability in the bin, or null when empty. */
  predicted: number | null;
  /** Share of the bin that actually kept the setting, or null when empty. */
  observed: number | null;
}

const rawBins = (y: number[], p: number[], bins: number) => {
  const out = Array.from({ length: bins }, (_, b) => ({ lo: b / bins, hi: (b + 1) / bins, n: 0, sp: 0, sy: 0 }));
  for (let i = 0; i < y.length; i++) {
    const b = out[Math.min(Math.max(Math.floor(p[i] * bins), 0), bins - 1)];
    b.n++;
    b.sp += p[i];
    b.sy += y[i];
  }
  return out;
};

/** Equal-width reliability diagram: does "0.7" mean about 70% kept? */
export function reliability(y: number[], p: number[], bins = 10): ReliabilityBin[] {
  return rawBins(y, p, bins).map(({ lo, hi, n, sp, sy }) => ({ lo: r4(lo), hi: r4(hi), n, predicted: n ? r4(sp / n) : null, observed: n ? r4(sy / n) : null }));
}

/** Expected calibration error: the n-weighted mean gap between predicted and observed rate over equal-width bins. 0 is perfect. */
export function ece(y: number[], p: number[], bins = 10): number | null {
  if (y.length === 0) return null;
  let sum = 0;
  for (const b of rawBins(y, p, bins)) sum += Math.abs(b.sp - b.sy);
  return r4(sum / y.length);
}
