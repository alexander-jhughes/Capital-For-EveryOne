// Evaluation metrics for the recommender. Pure functions, no dependencies, no I/O.
// Ranking metrics take a ranked candidate list; probability metrics take labels and predicted probabilities.
// Functions return null when a metric is undefined for the input (e.g. recall with nothing relevant), and aggregates
// skip nulls, so "undefined" is never silently counted as 0.

export const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Mean of the non-null values, or null when there are none. */
export function mean(xs: readonly (number | null | undefined)[]): number | null {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    s += x;
    n++;
  }
  return n ? s / n : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Ranking (top-K) metrics
// ---------------------------------------------------------------------------------------------------------------

/** Hits in the top K divided by min(K, number of candidates). Null when there are no candidates. */
export function precisionAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number | null {
  const n = Math.min(k, ranked.length);
  if (n === 0) return null;
  let hits = 0;
  for (let i = 0; i < n; i++) if (relevant.has(ranked[i])) hits++;
  return hits / n;
}

/** Hits in the top K divided by the number of relevant items. Null when nothing is relevant. */
export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number | null {
  if (relevant.size === 0) return null;
  let hits = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (relevant.has(ranked[i])) hits++;
  return hits / relevant.size;
}

/** DCG@K = Σ_{i<K} gain(i) / log2(i + 2), with graded gains. */
export function dcgAtK(ranked: readonly string[], gains: ReadonlyMap<string, number>, k: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) s += (gains.get(ranked[i]) ?? 0) / Math.log2(i + 2);
  return s;
}

/** NDCG@K: DCG of the ranking over DCG of the ideal ranking of the same candidates. Null when no candidate has gain. */
export function ndcgAtK(ranked: readonly string[], gains: ReadonlyMap<string, number>, k: number): number | null {
  const ideal = [...ranked].sort((a, b) => (gains.get(b) ?? 0) - (gains.get(a) ?? 0));
  const idcg = dcgAtK(ideal, gains, k);
  return idcg > 0 ? dcgAtK(ranked, gains, k) / idcg : null;
}

/** Share of the catalogue recommended to at least one person. */
export function catalogueCoverage(lists: readonly (readonly string[])[], catalogueSize: number): number {
  const seen = new Set<string>();
  for (const l of lists) for (const x of l) seen.add(x);
  return catalogueSize > 0 ? seen.size / catalogueSize : 0;
}

/** Share of people who received at least one recommendation. */
export function userCoverage(lists: readonly (readonly string[])[]): number {
  return lists.length ? lists.filter((l) => l.length > 0).length / lists.length : 0;
}

/** Share of recommended items whose true benefit is ≤ 0 (they would not help). Null when nothing was recommended. */
export function falseRecommendationRate(utilities: readonly number[]): number | null {
  return utilities.length ? utilities.filter((u) => u <= 0).length / utilities.length : null;
}

/** Mean true benefit of what was recommended. Null when nothing was recommended. */
export const benefit = (utilities: readonly number[]): number | null => mean(utilities);

/**
 * Kept-rate versus benefit for a set of recommended items: how often they would be kept, how much they help, and the
 * share of expected keeps that are items which do not help ("clicked Keep" but not "actually helped").
 */
export function keptVsBenefit(rows: readonly { keepProbability: number; utility: number }[]): { expectedKeptRate: number | null; meanBenefit: number | null; harmfulShareOfKept: number | null } {
  if (rows.length === 0) return { expectedKeptRate: null, meanBenefit: null, harmfulShareOfKept: null };
  const kept = rows.reduce((s, r) => s + r.keepProbability, 0);
  const harmful = rows.reduce((s, r) => s + (r.utility <= 0 ? r.keepProbability : 0), 0);
  return { expectedKeptRate: kept / rows.length, meanBenefit: mean(rows.map((r) => r.utility)), harmfulShareOfKept: kept > 0 ? harmful / kept : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Probability metrics
// ---------------------------------------------------------------------------------------------------------------

/** ROC AUC (Mann-Whitney U, ties counted as half). Null when one class is missing. */
export function auc(y: readonly number[], score: readonly number[]): number | null {
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (pos === 0 || neg === 0) return null;
  const order = score.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
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

/**
 * Rejection-prediction AUC: how well (1 − P(keep)) ranks the items a person explicitly turned down ("No thanks")
 * above the items they kept. Unlike the label, this event excludes undo and ratings.
 */
export const rejectionAuc = (rejected: readonly number[], pKeep: readonly number[]): number | null =>
  auc(
    rejected,
    pKeep.map((p) => 1 - p),
  );

export const brier = (y: readonly number[], p: readonly number[]): number => (y.length ? y.reduce((s, v, i) => s + (p[i] - v) ** 2, 0) / y.length : 0);

/** Mean log loss with probabilities clipped to [1e-6, 1 − 1e-6]. */
export const logLoss = (y: readonly number[], p: readonly number[]): number =>
  y.length
    ? -y.reduce((s, v, i) => {
        const q = Math.min(Math.max(p[i], 1e-6), 1 - 1e-6);
        return s + (v === 1 ? Math.log(q) : Math.log(1 - q));
      }, 0) / y.length
    : 0;

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

/** Equal-width bins over [0, 1]; a probability of exactly 1 goes in the last bin. */
export function reliability(y: readonly number[], p: readonly number[], bins = 10): ReliabilityBin[] {
  const n = new Array<number>(bins).fill(0);
  const sp = new Array<number>(bins).fill(0);
  const sy = new Array<number>(bins).fill(0);
  for (let i = 0; i < y.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p[i] * bins)));
    n[b]++;
    sp[b] += p[i];
    sy[b] += y[i];
  }
  return n.map((c, b) => ({ lo: b / bins, hi: (b + 1) / bins, n: c, meanPredicted: c ? sp[b] / c : null, observedRate: c ? sy[b] / c : null }));
}

/** Expected calibration error: Σ_b (n_b / N)·|mean predicted_b − observed rate_b|, equal-width bins. */
export function ece(y: readonly number[], p: readonly number[], bins = 10): number {
  if (y.length === 0) return 0;
  return reliability(y, p, bins).reduce((s, b) => s + (b.n ? (b.n / y.length) * Math.abs(b.meanPredicted! - b.observedRate!) : 0), 0);
}

export interface Calibration {
  n: number;
  ece: number;
  brier: number;
  logLoss: number;
  bins: ReliabilityBin[];
}

export const calibration = (y: readonly number[], p: readonly number[], bins = 10): Calibration => ({
  n: y.length,
  ece: ece(y, p, bins),
  brier: brier(y, p),
  logLoss: logLoss(y, p),
  bins: reliability(y, p, bins),
});

// ---------------------------------------------------------------------------------------------------------------
// Groups and disparity
// ---------------------------------------------------------------------------------------------------------------

export interface GroupValue {
  n: number;
  mean: number | null;
}

/** Mean of a per-person value for every group a person belongs to (people can be in several groups). */
export function groupMeans(rows: readonly { groups: readonly string[]; value: number | null }[]): Record<string, GroupValue> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const r of rows)
    for (const g of r.groups) {
      const a = acc.get(g) ?? { s: 0, n: 0 };
      if (r.value !== null && Number.isFinite(r.value)) {
        a.s += r.value;
        a.n++;
      }
      acc.set(g, a);
    }
  const out: Record<string, GroupValue> = {};
  for (const [g, a] of [...acc.entries()].sort((x, y) => x[0].localeCompare(y[0]))) out[g] = { n: a.n, mean: a.n ? a.s / a.n : null };
  return out;
}

export interface Disparity {
  worst: string;
  best: string;
  min: number;
  max: number;
  /** min / max (1 = parity). */
  ratio: number;
  difference: number;
  groups: number;
}

/** Worst over best group mean among groups with at least `minN` people and a defined value. Null with fewer than two. */
export function disparity(values: Record<string, GroupValue>, minN = 1): Disparity | null {
  const ok = Object.entries(values).filter(([, v]) => v.n >= minN && v.mean !== null) as [string, { n: number; mean: number }][];
  if (ok.length < 2) return null;
  const worst = ok.reduce((a, b) => (b[1].mean < a[1].mean ? b : a));
  const best = ok.reduce((a, b) => (b[1].mean > a[1].mean ? b : a));
  const ratio = best[1].mean > 0 ? worst[1].mean / best[1].mean : worst[1].mean === best[1].mean ? 1 : 0;
  return { worst: worst[0], best: best[0], min: worst[1].mean, max: best[1].mean, ratio, difference: best[1].mean - worst[1].mean, groups: ok.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Latency and size
// ---------------------------------------------------------------------------------------------------------------

/** Nearest-rank percentiles: the smallest sample with at least p% of samples at or below it. */
export function percentiles(samples: readonly number[], ps: readonly number[] = [50, 95, 99]): Record<string, number | null> {
  const sorted = [...samples].sort((a, b) => a - b);
  const out: Record<string, number | null> = {};
  for (const p of ps) out[`p${p}`] = sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null;
  return out;
}

/** Size of a JSON artifact in UTF-8 bytes, as it would be stored. */
export const jsonBytes = (x: unknown): number => new TextEncoder().encode(JSON.stringify(x)).length;
