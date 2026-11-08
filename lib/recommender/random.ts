// Seeded randomness, so synthetic data, training and evaluation are exactly reproducible.

/** mulberry32: small, fast, good enough for simulation. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
export function normal(r: () => number): number {
  const u = Math.max(r(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** In-place Fisher-Yates shuffle. */
export function shuffle<T>(r: () => number, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** Picks an index with probability proportional to its weight. */
export function weightedIndex(r: () => number, weights: readonly number[]): number {
  const total = weights.reduce((s, w) => s + Math.max(w, 0), 0);
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= Math.max(weights[i], 0);
    if (x < 0) return i;
  }
  return weights.length - 1;
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const logit = (p: number) => Math.log(p / (1 - p));
