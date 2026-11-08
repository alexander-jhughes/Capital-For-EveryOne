// A small, dependency-free random forest for binary classification (CART trees, Gini impurity, bootstrap
// samples, a random subset of features per split). Deterministic for a given seed.
// Trees are stored as flat arrays so the trained model is plain JSON and inference is a few array lookups.

/** Node i: leaf when f[i] === -1, else go to l[i] if x[f[i]] <= t[i], otherwise r[i]. v[i] = P(yes) at that node. */
export interface Tree {
  f: number[];
  t: number[];
  l: number[];
  r: number[];
  v: number[];
}

export interface ForestOptions {
  trees: number;
  maxDepth: number;
  minLeaf: number;
  /** Features tried at each split. 0 means all (a plain decision tree). */
  featuresPerSplit: number;
  bootstrap: boolean;
  seed: number;
}

/** mulberry32: small, fast, seedable. Good enough for sampling; not for anything security related. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gini = (n: number, pos: number) => {
  if (n === 0) return 0;
  const p = pos / n;
  return 2 * p * (1 - p);
};

/** Laplace-smoothed so a small pure leaf never claims 0% or 100%. */
const leafValue = (n: number, pos: number) => Math.round(((pos + 1) / (n + 2)) * 1e4) / 1e4;

interface Split {
  feature: number;
  threshold: number;
  gain: number;
}

function bestSplit(X: number[][], y: number[], idx: number[], features: number[], minLeaf: number): Split | null {
  const n = idx.length;
  let totalPos = 0;
  for (const i of idx) totalPos += y[i];
  const parent = gini(n, totalPos);
  let best: Split | null = null;

  for (const f of features) {
    // Features are small integers, so count per distinct value instead of sorting rows.
    const counts = new Map<number, [number, number]>();
    for (const i of idx) {
      const v = X[i][f];
      const c = counts.get(v);
      if (c) {
        c[0]++;
        c[1] += y[i];
      } else counts.set(v, [1, y[i]]);
    }
    if (counts.size < 2) continue;
    const values = [...counts.keys()].sort((a, b) => a - b);
    let ln = 0;
    let lp = 0;
    for (let k = 0; k < values.length - 1; k++) {
      const [cn, cp] = counts.get(values[k])!;
      ln += cn;
      lp += cp;
      const rn = n - ln;
      if (ln < minLeaf || rn < minLeaf) continue;
      const weighted = (ln / n) * gini(ln, lp) + (rn / n) * gini(rn, totalPos - lp);
      const gain = parent - weighted;
      if (gain > 1e-9 && (!best || gain > best.gain)) best = { feature: f, threshold: (values[k] + values[k + 1]) / 2, gain };
    }
  }
  return best;
}

function pickFeatures(count: number, k: number, rand: () => number): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (k <= 0 || k >= count) return all;
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, k);
}

export function trainTree(X: number[][], y: number[], rows: number[], opts: ForestOptions, rand: () => number): Tree {
  const tree: Tree = { f: [], t: [], l: [], r: [], v: [] };
  const featureCount = X[0]?.length ?? 0;

  const grow = (idx: number[], depth: number): number => {
    const id = tree.f.length;
    let pos = 0;
    for (const i of idx) pos += y[i];
    tree.f.push(-1);
    tree.t.push(0);
    tree.l.push(-1);
    tree.r.push(-1);
    tree.v.push(leafValue(idx.length, pos));
    if (depth >= opts.maxDepth || idx.length < 2 * opts.minLeaf || pos === 0 || pos === idx.length) return id;

    const split = bestSplit(X, y, idx, pickFeatures(featureCount, opts.featuresPerSplit, rand), opts.minLeaf);
    if (!split) return id;
    const left: number[] = [];
    const right: number[] = [];
    for (const i of idx) (X[i][split.feature] <= split.threshold ? left : right).push(i);
    tree.f[id] = split.feature;
    tree.t[id] = split.threshold;
    tree.l[id] = grow(left, depth + 1);
    tree.r[id] = grow(right, depth + 1);
    return id;
  };

  grow(rows, 0);
  return tree;
}

export function trainForest(X: number[][], y: number[], rows: number[], opts: ForestOptions): Tree[] {
  const rand = rng(opts.seed);
  const trees: Tree[] = [];
  for (let k = 0; k < opts.trees; k++) {
    const sample = opts.bootstrap ? rows.map(() => rows[Math.floor(rand() * rows.length)]) : rows;
    trees.push(trainTree(X, y, sample, opts, rand));
  }
  return trees;
}

function leafOf(tree: Tree, x: number[]): number {
  let i = 0;
  while (tree.f[i] !== -1) i = x[tree.f[i]] <= tree.t[i] ? tree.l[i] : tree.r[i];
  return i;
}

/** Mean of the trees' leaf probabilities. */
export function predictProba(trees: Tree[], x: number[]): number {
  let sum = 0;
  for (const t of trees) sum += t.v[leafOf(t, x)];
  return sum / trees.length;
}

/**
 * Splits a prediction into a starting value plus one contribution per feature, by following each tree's
 * decision path and crediting every change in node probability to the feature that was split on
 * (the "tree interpreter" decomposition). bias + sum(contributions) === predictProba(trees, x).
 */
export function contributions(trees: Tree[], x: number[]): { bias: number; byFeature: number[] } {
  const byFeature = new Array<number>(x.length).fill(0);
  let bias = 0;
  for (const t of trees) {
    let i = 0;
    bias += t.v[0];
    while (t.f[i] !== -1) {
      const next = x[t.f[i]] <= t.t[i] ? t.l[i] : t.r[i];
      byFeature[t.f[i]] += t.v[next] - t.v[i];
      i = next;
    }
  }
  return { bias: bias / trees.length, byFeature: byFeature.map((c) => c / trees.length) };
}

/** Structural check for a tree loaded from JSON: every index in range, no cycles, probabilities in [0, 1]. */
export function isValidTree(t: unknown, featureCount: number): t is Tree {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  const arrays = ["f", "t", "l", "r", "v"].map((k) => o[k]);
  if (!arrays.every((a) => Array.isArray(a) && a.every((n) => typeof n === "number" && Number.isFinite(n)))) return false;
  const [f, , l, r, v] = arrays as number[][];
  const n = f.length;
  if (n === 0 || arrays.some((a) => (a as number[]).length !== n)) return false;
  for (let i = 0; i < n; i++) {
    if (v[i] < 0 || v[i] > 1) return false;
    if (f[i] === -1) continue;
    // Children always come after their parent in the arrays, so a walk can never loop.
    if (!Number.isInteger(f[i]) || f[i] < 0 || f[i] >= featureCount) return false;
    if (!(l[i] > i && l[i] < n && r[i] > i && r[i] < n)) return false;
  }
  return true;
}
