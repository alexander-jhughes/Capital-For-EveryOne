// Hand-computed cases for every metric used in the benchmark.
import { describe, expect, it } from "vitest";
import {
  auc,
  benefit,
  brier,
  calibration,
  catalogueCoverage,
  dcgAtK,
  disparity,
  ece,
  falseRecommendationRate,
  groupMeans,
  jsonBytes,
  keptVsBenefit,
  mean,
  ndcgAtK,
  percentiles,
  precisionAtK,
  recallAtK,
  rejectionAuc,
  reliability,
  userCoverage,
} from "./metrics";

describe("ranking metrics", () => {
  const ranked = ["a", "b", "c", "d"];
  const relevant = new Set(["a", "c"]);

  it("precision@K divides by min(K, candidates)", () => {
    expect(precisionAtK(ranked, relevant, 1)).toBe(1);
    expect(precisionAtK(ranked, relevant, 2)).toBe(0.5);
    expect(precisionAtK(ranked, relevant, 3)).toBeCloseTo(2 / 3, 12);
    expect(precisionAtK(["c"], relevant, 3)).toBe(1); // one candidate, and it is relevant
    expect(precisionAtK([], relevant, 3)).toBeNull();
  });

  it("recall@K divides by the number of relevant items", () => {
    expect(recallAtK(ranked, relevant, 1)).toBe(0.5);
    expect(recallAtK(ranked, relevant, 3)).toBe(1);
    expect(recallAtK(ranked, new Set(), 3)).toBeNull();
  });

  it("NDCG@K with graded gains", () => {
    const gains = new Map([
      ["a", 0],
      ["b", 2],
      ["c", 1],
    ]);
    // DCG = 0/log2(2) + 2/log2(3) + 1/log2(4) = 1.2618595 + 0.5; IDCG = 2/1 + 1/log2(3) = 2.6309298
    expect(dcgAtK(["a", "b", "c"], gains, 3)).toBeCloseTo(1.7618595, 6);
    expect(ndcgAtK(["a", "b", "c"], gains, 3)).toBeCloseTo(1.7618595 / 2.6309298, 6);
    expect(ndcgAtK(["b", "c", "a"], gains, 3)).toBeCloseTo(1, 12);
    // @1: DCG = 0, IDCG = 2.
    expect(ndcgAtK(["a", "b", "c"], gains, 1)).toBe(0);
    expect(ndcgAtK(["a"], gains, 3)).toBeNull(); // no candidate with gain
  });

  it("catalogue and user coverage", () => {
    expect(catalogueCoverage([["a", "b"], ["b"], []], 4)).toBe(0.5);
    expect(userCoverage([["a", "b"], ["b"], []])).toBeCloseTo(2 / 3, 12);
    expect(userCoverage([])).toBe(0);
  });

  it("false recommendation rate and benefit", () => {
    expect(falseRecommendationRate([0.5, -0.2, 0, 1])).toBe(0.5); // utility ≤ 0 counts as false
    expect(falseRecommendationRate([])).toBeNull();
    expect(benefit([0.5, -0.2, 0, 1])).toBeCloseTo(0.325, 12);
    expect(benefit([])).toBeNull();
  });

  it("kept rate versus benefit", () => {
    const r = keptVsBenefit([
      { keepProbability: 0.8, utility: 1 },
      { keepProbability: 0.6, utility: -0.5 },
      { keepProbability: 0.1, utility: -1 },
    ]);
    expect(r.expectedKeptRate).toBeCloseTo(0.5, 12);
    expect(r.meanBenefit).toBeCloseTo(-0.5 / 3, 12);
    expect(r.harmfulShareOfKept).toBeCloseTo(0.7 / 1.5, 12);
  });
});

describe("probability metrics", () => {
  it("AUC by pairs, ties as half", () => {
    // positives 0.9, 0.7; negatives 0.8, 0.1: pairs won 0.9>0.8, 0.9>0.1, 0.7>0.1; lost 0.7<0.8 -> 3/4
    expect(auc([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.1])).toBe(0.75);
    expect(auc([1, 0], [0.5, 0.5])).toBe(0.5);
    expect(auc([1, 1], [0.2, 0.3])).toBeNull();
  });

  it("rejection AUC ranks explicit turn-downs by 1 − P(keep)", () => {
    // rejected items had P(keep) 0.2 and 0.6; kept items 0.4 and 0.9: pairs (0.8 vs 0.6 ✓, 0.8 vs 0.1 ✓, 0.4 vs 0.6 ✗, 0.4 vs 0.1 ✓)
    expect(rejectionAuc([1, 0, 1, 0], [0.2, 0.4, 0.6, 0.9])).toBe(0.75);
  });

  it("Brier, ECE and the reliability table", () => {
    const y = [0, 0, 1, 0];
    const p = [0.05, 0.15, 0.95, 0.95];
    expect(brier(y, p)).toBeCloseTo((0.0025 + 0.0225 + 0.0025 + 0.9025) / 4, 12);
    // bin 0: |0.05 − 0|·1/4, bin 1: |0.15 − 0|·1/4, bin 9: |0.95 − 0.5|·2/4
    expect(ece(y, p)).toBeCloseTo(0.0125 + 0.0375 + 0.225, 12);
    const bins = reliability(y, p);
    expect(bins).toHaveLength(10);
    expect(bins[9]).toEqual({ lo: 0.9, hi: 1, n: 2, meanPredicted: 0.95, observedRate: 0.5 });
    expect(bins[5]).toEqual({ lo: 0.5, hi: 0.6, n: 0, meanPredicted: null, observedRate: null });
    expect(reliability([1], [1])[9].n).toBe(1); // p = 1 goes in the last bin
    const c = calibration(y, p);
    expect(c.n).toBe(4);
    expect(c.ece).toBeCloseTo(0.275, 12);
    expect(c.logLoss).toBeGreaterThan(0);
  });

  it("perfectly calibrated predictions have ECE 0", () => {
    expect(ece([1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5])).toBe(0);
  });
});

describe("groups, latency and size", () => {
  it("group means skip null values and disparity is worst over best", () => {
    const g = groupMeans([
      { groups: ["view:simple", "age:18-24"], value: 0.6 },
      { groups: ["view:detailed", "age:18-24"], value: 0.8 },
      { groups: ["view:detailed"], value: 1 },
      { groups: ["view:simple"], value: null },
    ]);
    expect(g["view:simple"]).toEqual({ n: 1, mean: 0.6 });
    expect(g["view:detailed"]).toEqual({ n: 2, mean: 0.9 });
    expect(g["age:18-24"].mean).toBeCloseTo(0.7, 12);
    const d = disparity({ simple: g["view:simple"], detailed: g["view:detailed"] })!;
    expect(d.worst).toBe("simple");
    expect(d.best).toBe("detailed");
    expect(d.ratio).toBeCloseTo(0.6 / 0.9, 12);
    expect(d.difference).toBeCloseTo(0.3, 12);
    expect(disparity({ simple: g["view:simple"], detailed: g["view:detailed"] }, 2)).toBeNull(); // simple has n = 1
  });

  it("nearest-rank percentiles", () => {
    const xs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentiles(xs, [50, 95, 99])).toEqual({ p50: 5, p95: 10, p99: 10 });
    expect(percentiles([], [50])).toEqual({ p50: null });
  });

  it("mean ignores nulls and JSON size counts UTF-8 bytes", () => {
    expect(mean([1, null, 3, undefined])).toBe(2);
    expect(mean([null])).toBeNull();
    expect(jsonBytes({ a: "é" })).toBe(10); // {"a":"é"} with é as 2 bytes
  });
});
