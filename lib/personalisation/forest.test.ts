import { describe, expect, it } from "vitest";
import { contributions, isValidTree, predictProba, rng, trainForest, type Tree } from "./forest";
import { auc, binaryMetrics, recommendationMetrics } from "./metrics";

// y = 1 when feature 0 is high AND feature 1 is high: needs two splits, so a stump cannot learn it.
function toyData(n: number, seed: number) {
  const r = rng(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = [Math.floor(r() * 4), Math.floor(r() * 4), Math.floor(r() * 4)]; // feature 2 is noise
    X.push(x);
    y.push(x[0] >= 2 && x[1] >= 2 ? 1 : 0);
  }
  return { X, y, rows: X.map((_, i) => i) };
}

const OPTS = { trees: 15, maxDepth: 4, minLeaf: 5, featuresPerSplit: 2, bootstrap: true, seed: 7 };

describe("random forest", () => {
  it("learns an interaction a single split cannot", () => {
    const train = toyData(800, 1);
    const test = toyData(300, 2);
    const forest = trainForest(train.X, train.y, train.rows, OPTS);
    const stump = trainForest(train.X, train.y, train.rows, { ...OPTS, trees: 1, maxDepth: 1, featuresPerSplit: 0, bootstrap: false });
    const p = test.X.map((x) => predictProba(forest, x));
    expect(binaryMetrics(test.y, p, 0.5).accuracy).toBeGreaterThan(0.97);
    expect(auc(test.y, p)!).toBeGreaterThan(auc(test.y, test.X.map((x) => predictProba(stump, x)))!);
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const d = toyData(300, 3);
    expect(trainForest(d.X, d.y, d.rows, OPTS)).toEqual(trainForest(d.X, d.y, d.rows, OPTS));
    expect(trainForest(d.X, d.y, d.rows, OPTS)).not.toEqual(trainForest(d.X, d.y, d.rows, { ...OPTS, seed: 8 }));
  });

  it("respects max depth and min leaf size", () => {
    const d = toyData(500, 4);
    const [tree] = trainForest(d.X, d.y, d.rows, { ...OPTS, trees: 1, maxDepth: 2, bootstrap: false });
    const depth = (i: number): number => (tree.f[i] === -1 ? 0 : 1 + Math.max(depth(tree.l[i]), depth(tree.r[i])));
    expect(depth(0)).toBeLessThanOrEqual(2);
  });

  it("probabilities stay strictly between 0 and 1 (smoothed leaves)", () => {
    const d = toyData(400, 5);
    const forest = trainForest(d.X, d.y, d.rows, OPTS);
    for (const x of d.X) {
      const p = predictProba(forest, x);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("contributions add up exactly to the prediction", () => {
    const d = toyData(400, 6);
    const forest = trainForest(d.X, d.y, d.rows, OPTS);
    for (const x of d.X.slice(0, 50)) {
      const { bias, byFeature } = contributions(forest, x);
      expect(bias + byFeature.reduce((s, c) => s + c, 0)).toBeCloseTo(predictProba(forest, x), 10);
    }
    // The noise feature should matter far less than the real ones.
    const { byFeature } = contributions(forest, [3, 3, 0]);
    expect(Math.abs(byFeature[2])).toBeLessThan(Math.min(byFeature[0], byFeature[1]));
  });

  it("validates tree structure before use", () => {
    const good: Tree = { f: [0, -1, -1], t: [0.5, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [0.5, 0.2, 0.8] };
    expect(isValidTree(good, 3)).toBe(true);
    expect(isValidTree({ ...good, l: [0, -1, -1] }, 3)).toBe(false); // cycle
    expect(isValidTree({ ...good, f: [9, -1, -1] }, 3)).toBe(false); // unknown feature
    expect(isValidTree({ ...good, v: [0.5, 2, 0.8] }, 3)).toBe(false); // not a probability
    expect(isValidTree({ ...good, v: [0.5, Number.NaN, 0.8] }, 3)).toBe(false);
    expect(isValidTree({ ...good, r: [7, -1, -1] }, 3)).toBe(false); // out of range
    expect(isValidTree({ ...good, t: [0.5, 0] }, 3)).toBe(false); // ragged
    expect(isValidTree(null, 3)).toBe(false);
  });
});

describe("metrics", () => {
  it("AUC: perfect, inverted, ties and single class", () => {
    expect(auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])).toBe(1);
    expect(auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1])).toBe(0);
    expect(auc([0, 1], [0.5, 0.5])).toBe(0.5);
    expect(auc([1, 1], [0.2, 0.3])).toBeNull();
  });

  it("confusion-based metrics", () => {
    const m = binaryMetrics([1, 1, 0, 0], [0.9, 0.4, 0.6, 0.1], 0.5);
    expect(m).toMatchObject({ accuracy: 0.5, precision: 0.5, recall: 0.5, f1: 0.5, positives: 2 });
    expect(m.brier).toBeCloseTo((0.01 + 0.36 + 0.36 + 0.01) / 4, 4);
  });

  it("recommendation keep rate and coverage", () => {
    expect(recommendationMetrics([1, 0, 1, 0], [0.9, 0.8, 0.3, 0.1], 0.7)).toEqual({ offered: 2, coverage: 0.5, keepRate: 0.5 });
    expect(recommendationMetrics([1, 0], [0.1, 0.2], 0.7).keepRate).toBeNull();
  });
});
