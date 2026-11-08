// Component 2: collaborative, privacy-preserving neighbourhood model.
//
// Training: each training subject becomes one unit similarity vector (from their first snapshot). Subjects are
// clustered with seeded spherical k-means++, and clusters smaller than `minClusterSize` are merged into their
// nearest neighbour, so the artifact never describes a small group or an individual. Per cluster and item it keeps
// only aggregates: how many people had an outcome on the item and their keep rate, shrunk toward the item's global
// rate with a Beta prior (cells with fewer than `minCellCount` people are suppressed). It also keeps an
// item-to-item table: how keeping (or turning down) item i shifts the log-odds of keeping item j, from people with
// outcomes on both (cells with fewer than `coMinCount` people are suppressed).
//
// Inference: the person's similarity to each cluster, relative to how similar the cluster's own members are,
// r_c = cos(person, centroid_c) / cohesion_c, gives a kernel weight a_c = exp((min(r_c, 1) − 1) / T).
//   probability = (Σ a_c · n_ci · rate_ci + α · global_i) / (Σ a_c · n_ci + α)
//   support     =  Σ a_c · n_ci   (the similarity-weighted number of people with an outcome on item i)
// A person who has told Dial nothing is similar to nobody: support 0 and the global rate. Warm users also get the
// item-to-item shift from their own history (item-based collaborative filtering).
import { weightedIndex } from "../random";
import { bySubject, ITEM_COUNT, ITEM_INDEX, type PreparedExample, toDense } from "./data";
import { FEATURE_COUNT } from "./features";
import { clamp, safeLogit, sigmoid } from "./math";
import { similarityVector } from "./similarity";
import type { HistoryEntry } from "../types";

export interface CollaborativeParams {
  /** Kernel temperature T. */
  temperature: number;
  /** Beta prior strength α toward the item's global rate. */
  priorStrength: number;
  /** Largest total log-odds shift from the person's own history. */
  historyClip: number;
  /** Similarity weight per feature (copied from similarity.ts at training time). */
  simWeights: number[];
  /** [cluster][feature]: mean of the members' unit similarity vectors. Its length is the cluster's cohesion. */
  centroids: number[][];
  /** [cluster][item]: keep rate shrunk toward the item's global rate. */
  rate: number[][];
  /** [cluster][item]: people in the cluster with an outcome on the item (0 when suppressed). */
  count: number[][];
  /** [item i][0: turned down, 1: kept][item j]: log-odds shift for j. 0 when there wasn't enough data. */
  coLift: number[][][];
}

export interface CollaborativeOptions {
  clusters: number;
  minClusterSize: number;
  minCellCount: number;
  priorStrength: number;
  coMinCount: number;
  coPrior: number;
  temperature: number;
  historyClip: number;
  iterations: number;
}

const dot = (a: Float64Array, ai: number, b: Float64Array, bi: number, n: number) => {
  let s = 0;
  for (let k = 0; k < n; k++) s += a[ai + k] * b[bi + k];
  return s;
};

/** Seeded spherical k-means++ on unit vectors (rows of `points`). Returns the cluster of each point. */
export function sphericalKMeans(points: Float64Array, n: number, dim: number, k: number, r: () => number, iterations: number): Int32Array {
  const centers = new Float64Array(k * dim);
  // k-means++ seeding: D² sampling with D² = 2 − 2·cos on the unit sphere.
  const d2 = new Float64Array(n).fill(Infinity);
  let chosen = Math.floor(r() * n);
  for (let c = 0; c < k; c++) {
    centers.set(points.subarray(chosen * dim, chosen * dim + dim), c * dim);
    for (let i = 0; i < n; i++) d2[i] = Math.min(d2[i], Math.max(0, 2 - 2 * dot(points, i * dim, centers, c * dim, dim)));
    if (c + 1 < k) chosen = weightedIndex(r, Array.from(d2));
  }
  const assign = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * dim);
  const sizes = new Int32Array(k);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDot = -Infinity;
      for (let c = 0; c < k; c++) {
        const d = dot(points, i * dim, centers, c * dim, dim);
        if (d > bestDot) {
          bestDot = d;
          best = c;
        }
      }
      if (assign[i] !== best) changed++;
      assign[i] = best;
    }
    if (changed === 0) break;
    sums.fill(0);
    sizes.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      sizes[c]++;
      for (let f = 0; f < dim; f++) sums[c * dim + f] += points[i * dim + f];
    }
    for (let c = 0; c < k; c++) {
      if (sizes[c] === 0) continue; // empty: keep its centre; it is merged away later if still small
      let norm = 0;
      for (let f = 0; f < dim; f++) norm += sums[c * dim + f] ** 2;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let f = 0; f < dim; f++) centers[c * dim + f] = sums[c * dim + f] / norm;
    }
  }
  return assign;
}

/** Merges clusters smaller than `minSize` into their most similar neighbour until none is left. */
export function mergeSmallClusters(points: Float64Array, dim: number, assign: Int32Array, k: number, minSize: number): number[][] {
  let groups: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < assign.length; i++) groups[assign[i]].push(i);
  groups = groups.filter((g) => g.length > 0);
  const centre = (g: number[]) => {
    const c = new Float64Array(dim);
    for (const i of g) for (let f = 0; f < dim; f++) c[f] += points[i * dim + f];
    let norm = 0;
    for (let f = 0; f < dim; f++) norm += c[f] * c[f];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let f = 0; f < dim; f++) c[f] /= norm;
    return c;
  };
  while (groups.length > 1) {
    let smallest = -1;
    for (let g = 0; g < groups.length; g++) if (groups[g].length < minSize && (smallest < 0 || groups[g].length < groups[smallest].length)) smallest = g;
    if (smallest < 0) break;
    const cs = centre(groups[smallest]);
    let target = -1;
    let bestDot = -Infinity;
    for (let g = 0; g < groups.length; g++) {
      if (g === smallest) continue;
      const d = dot(cs, 0, centre(groups[g]), 0, dim);
      if (d > bestDot) {
        bestDot = d;
        target = g;
      }
    }
    groups[target] = [...groups[target], ...groups[smallest]].sort((a, b) => a - b);
    groups.splice(smallest, 1);
  }
  return groups.length === 1 && groups[0].length < minSize ? [] : groups;
}

/** Each subject's outcomes: item index → weighted mean label. */
function subjectOutcomes(list: readonly PreparedExample[]): Map<number, number> {
  const pos = new Map<number, number>();
  const tot = new Map<number, number>();
  for (const e of list) {
    pos.set(e.item, (pos.get(e.item) ?? 0) + e.w * e.y);
    tot.set(e.item, (tot.get(e.item) ?? 0) + e.w);
  }
  const out = new Map<number, number>();
  for (const [item, t] of tot) out.set(item, pos.get(item)! / t);
  return out;
}

export function trainCollaborative(
  examples: readonly PreparedExample[],
  globalRate: readonly number[],
  weights: readonly number[],
  options: CollaborativeOptions,
  r: () => number,
): CollaborativeParams {
  const dim = FEATURE_COUNT;
  const subjects = [...bySubject(examples).values()];
  const outcomes = subjects.map(subjectOutcomes);

  // One unit vector per subject, from their first snapshot (fewest answers given before it).
  const vectors: Float64Array[] = [];
  const members: number[] = [];
  const dense = new Float64Array(dim);
  for (let s = 0; s < subjects.length; s++) {
    let first = subjects[s][0];
    for (const e of subjects[s]) if (e.history.length < first.history.length) first = e;
    const u = similarityVector(toDense(first.x, dense), weights);
    if (u) {
      vectors.push(u.slice());
      members.push(s);
    }
  }
  const n = vectors.length;
  const points = new Float64Array(n * dim);
  vectors.forEach((v, i) => points.set(v, i * dim));

  let groups: number[][] = [];
  const k = Math.min(options.clusters, Math.floor(n / options.minClusterSize));
  if (k >= 1) {
    const assign = sphericalKMeans(points, n, dim, k, r, options.iterations);
    groups = mergeSmallClusters(points, dim, assign, k, options.minClusterSize);
  }

  const centroids: number[][] = [];
  const rate: number[][] = [];
  const count: number[][] = [];
  for (const g of groups) {
    const c = new Array<number>(dim).fill(0);
    for (const i of g) for (let f = 0; f < dim; f++) c[f] += points[i * dim + f] / g.length;
    const pos = new Float64Array(ITEM_COUNT);
    const tot = new Float64Array(ITEM_COUNT);
    for (const i of g) {
      for (const [item, mean] of outcomes[members[i]]) {
        pos[item] += mean;
        tot[item] += 1;
      }
    }
    const rr: number[] = [];
    const cc: number[] = [];
    for (let item = 0; item < ITEM_COUNT; item++) {
      const suppressed = tot[item] < options.minCellCount;
      cc.push(suppressed ? 0 : tot[item]);
      rr.push(suppressed ? globalRate[item] : (pos[item] + options.priorStrength * globalRate[item]) / (tot[item] + options.priorStrength));
    }
    centroids.push(c);
    rate.push(rr);
    count.push(cc);
  }

  // Item-to-item table from subjects with outcomes on two or more items.
  const coPos = new Float64Array(ITEM_COUNT * 2 * ITEM_COUNT);
  const coTot = new Float64Array(ITEM_COUNT * 2 * ITEM_COUNT);
  for (const o of outcomes) {
    if (o.size < 2) continue;
    for (const [i, mi] of o) {
      const oi = mi >= 0.5 ? 1 : 0;
      for (const [j, mj] of o) {
        if (i === j) continue;
        const cell = (i * 2 + oi) * ITEM_COUNT + j;
        coPos[cell] += mj;
        coTot[cell] += 1;
      }
    }
  }
  const coLift: number[][][] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const byOutcome: number[][] = [];
    for (let oi = 0; oi < 2; oi++) {
      const row: number[] = [];
      for (let j = 0; j < ITEM_COUNT; j++) {
        const cell = (i * 2 + oi) * ITEM_COUNT + j;
        const other = (i * 2 + (1 - oi)) * ITEM_COUNT + j;
        const tot = coTot[cell];
        if (i === j || tot < options.coMinCount) {
          row.push(0);
          continue;
        }
        // Base: j's keep rate among everyone with an outcome on i, so the lift isolates what i's outcome adds.
        const base = (coPos[cell] + coPos[other] + options.coPrior * globalRate[j]) / (tot + coTot[other] + options.coPrior);
        const conditional = (coPos[cell] + options.coPrior * base) / (tot + options.coPrior);
        row.push(safeLogit(conditional) - safeLogit(base));
      }
      byOutcome.push(row);
    }
    coLift.push(byOutcome);
  }

  return {
    temperature: options.temperature,
    priorStrength: options.priorStrength,
    historyClip: options.historyClip,
    simWeights: [...weights],
    centroids,
    rate,
    count,
    coLift,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------------------------------------------

export interface PreparedCollaborative {
  clusters: number;
  centroids: Float64Array;
  /** ‖centroid‖²: cohesion² (the mean member cosine is ‖centroid‖). */
  norm2: Float64Array;
  rate: Float64Array;
  count: Float64Array;
  coLift: Float64Array;
  weights: Float64Array;
  temperature: number;
  priorStrength: number;
  historyClip: number;
}

export function prepareCollaborative(p: CollaborativeParams): PreparedCollaborative {
  const c = p.centroids.length;
  const centroids = new Float64Array(c * FEATURE_COUNT);
  const norm2 = new Float64Array(c);
  p.centroids.forEach((row, i) => {
    centroids.set(row, i * FEATURE_COUNT);
    norm2[i] = row.reduce((s, v) => s + v * v, 0);
  });
  return {
    clusters: c,
    centroids,
    norm2,
    rate: Float64Array.from(p.rate.flat()),
    count: Float64Array.from(p.count.flat()),
    coLift: Float64Array.from(p.coLift.flat(2)),
    weights: Float64Array.from(p.simWeights),
    temperature: p.temperature,
    priorStrength: p.priorStrength,
    historyClip: p.historyClip,
  };
}

const scratch = new Float64Array(FEATURE_COUNT);

/** Writes the collaborative probability and support of every item. */
export function scoreCollaborative(
  pc: PreparedCollaborative,
  x: ArrayLike<number>,
  history: readonly HistoryEntry[],
  globalRate: readonly number[],
  outP: Float64Array,
  outSupport: Float64Array,
): void {
  const num = new Float64Array(ITEM_COUNT);
  const den = new Float64Array(ITEM_COUNT);
  const u = similarityVector(x, pc.weights, scratch);
  if (u) {
    for (let c = 0; c < pc.clusters; c++) {
      if (!(pc.norm2[c] > 0)) continue;
      const rel = dot(u, 0, pc.centroids, c * FEATURE_COUNT, FEATURE_COUNT) / pc.norm2[c];
      const a = Math.exp((Math.min(rel, 1) - 1) / pc.temperature);
      if (a < 1e-6) continue;
      for (let i = 0; i < ITEM_COUNT; i++) {
        const n = a * pc.count[c * ITEM_COUNT + i];
        num[i] += n * pc.rate[c * ITEM_COUNT + i];
        den[i] += n;
      }
    }
  }
  const lift = historyLift(pc, history);
  for (let i = 0; i < ITEM_COUNT; i++) {
    const p = (num[i] + pc.priorStrength * globalRate[i]) / (den[i] + pc.priorStrength);
    outP[i] = lift ? sigmoid(safeLogit(p) + lift[i]) : p;
    outSupport[i] = den[i];
  }
}

/** Item-based CF: the summed log-odds shifts from the person's own latest answer on each item. */
function historyLift(pc: PreparedCollaborative, history: readonly HistoryEntry[]): Float64Array | null {
  if (history.length === 0) return null;
  const latest = new Map<number, number>();
  for (const h of history) {
    if (h.outcome === "dismissed") continue;
    latest.set(ITEM_INDEX.get(h.item)!, h.outcome === "accepted" ? 1 : 0);
  }
  if (latest.size === 0) return null;
  const lift = new Float64Array(ITEM_COUNT);
  for (const [i, o] of latest) for (let j = 0; j < ITEM_COUNT; j++) lift[j] += pc.coLift[(i * 2 + o) * ITEM_COUNT + j];
  for (let j = 0; j < ITEM_COUNT; j++) lift[j] = clamp(lift[j], -pc.historyClip, pc.historyClip);
  return lift;
}

