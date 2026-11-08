// Probability calibration, fitted per target on the VALIDATION split only (never on test data).
// Isotonic regression (pool adjacent violators) turns the forest's vote share into "share of people like this who
// kept it". It is monotone, so it never changes which of two people looks more likely, only what the number means.
// Stored as a few knots and applied by linear interpolation, so it is tiny, fast and easy to validate.

export interface Calibration {
  /** Raw forest probabilities, strictly increasing, in [0, 1]. */
  x: number[];
  /** Calibrated probabilities at those points, non-decreasing, in [0, 1]. */
  y: number[];
}

export const IDENTITY_CALIBRATION: Calibration = { x: [0, 1], y: [0, 1] };
export const MAX_KNOTS = 64;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Fits isotonic regression of y on p. Blocks smaller than `minBlock` people are merged into a neighbour, so no knot
 * rests on a handful of people. Each block's value is Laplace-smoothed like the forest's leaves (never 0 or 1).
 */
export function fitIsotonic(y: number[], p: number[], minBlock = 25): Calibration {
  if (y.length === 0) return IDENTITY_CALIBRATION;
  // One block per distinct raw value (forests produce many ties), in increasing order.
  const byValue = new Map<number, { n: number; pos: number; sum: number }>();
  for (let i = 0; i < y.length; i++) {
    const b = byValue.get(p[i]) ?? { n: 0, pos: 0, sum: 0 };
    b.n++;
    b.pos += y[i];
    b.sum += p[i];
    byValue.set(p[i], b);
  }
  type Block = { n: number; pos: number; sum: number };
  const rate = (b: Block) => b.pos / b.n;
  const merge = (a: Block, b: Block): Block => ({ n: a.n + b.n, pos: a.pos + b.pos, sum: a.sum + b.sum });
  const blocks: Block[] = [];
  for (const [, b] of [...byValue.entries()].sort((a, b) => a[0] - b[0])) {
    blocks.push({ ...b });
    // Pool adjacent violators.
    while (blocks.length > 1 && rate(blocks[blocks.length - 2]) >= rate(blocks[blocks.length - 1])) blocks.push(merge(blocks.pop()!, blocks.pop()!));
  }
  // Merge thin blocks into the neighbour with the closer rate. Merging neighbours keeps the sequence increasing.
  while (blocks.length > 1) {
    let i = -1;
    for (let k = 0; k < blocks.length; k++) if (blocks[k].n < minBlock && (i < 0 || blocks[k].n < blocks[i].n)) i = k;
    if (i < 0 && blocks.length <= MAX_KNOTS) break;
    if (i < 0) i = blocks.reduce((m, b, k) => (b.n < blocks[m].n ? k : m), 0);
    const j = i === 0 ? 1 : i === blocks.length - 1 ? i - 1 : Math.abs(rate(blocks[i - 1]) - rate(blocks[i])) <= Math.abs(rate(blocks[i + 1]) - rate(blocks[i])) ? i - 1 : i + 1;
    const [lo, hi] = i < j ? [i, j] : [j, i];
    blocks.splice(lo, 2, merge(blocks[lo], blocks[hi]));
  }
  const x: number[] = [];
  const out: number[] = [];
  for (const b of blocks) {
    const xv = r4(b.sum / b.n);
    const yv = r4((b.pos + 1) / (b.n + 2));
    if (x.length && xv <= x[x.length - 1]) continue; // rounding collision: keep the first
    x.push(xv);
    out.push(out.length ? Math.max(yv, out[out.length - 1]) : yv);
  }
  return { x, y: out };
}

/** Piecewise-linear interpolation between knots, flat beyond the ends. */
export function calibrate(c: Calibration, p: number): number {
  const { x, y } = c;
  if (p <= x[0]) return y[0];
  const last = x.length - 1;
  if (p >= x[last]) return y[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= p) lo = mid;
    else hi = mid;
  }
  return y[lo] + ((y[hi] - y[lo]) * (p - x[lo])) / (x[hi] - x[lo]);
}

/** Structural check for a calibration loaded from JSON. */
export function isValidCalibration(c: unknown): c is Calibration {
  if (typeof c !== "object" || c === null) return false;
  const { x, y } = c as Record<string, unknown>;
  if (!Array.isArray(x) || !Array.isArray(y) || x.length === 0 || x.length !== y.length || x.length > MAX_KNOTS) return false;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = y[i];
    if (typeof xi !== "number" || typeof yi !== "number" || !(xi >= 0 && xi <= 1 && yi >= 0 && yi <= 1)) return false;
    if (i > 0 && !(xi > (x[i - 1] as number) && yi >= (y[i - 1] as number))) return false;
  }
  return true;
}
