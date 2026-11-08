import { describe, expect, it } from "vitest";
import type { ContenderResult } from "./benchmark";
import { DEFAULT_BUDGETS, evaluateGates } from "./gates";
import { calibration } from "./metrics";

function result(name: string, ndcg: number, over: { falseRec?: number; ece?: number; ratio?: number; p95?: number } = {}): ContenderResult {
  const y = [0, 1, 0, 1];
  const cal = calibration(y, y.map((v) => (v ? 1 - (over.ece ?? 0) : over.ece ?? 0)));
  return {
    name,
    description: "",
    oracle: {
      overall: { "ndcg@3": ndcg, "falseRec@3": over.falseRec ?? 0.3 },
      strata: {},
      groups: {},
      disparity: { view: { worst: "view: Simple", best: "view: Detailed", min: 0.5, max: 0.5 / (over.ratio ?? 0.9), ratio: over.ratio ?? 0.9, difference: 0, groups: 2 } },
      minDisparityRatio: over.ratio ?? 0.9,
    },
    logged: { n: 4, scoredShare: 1, auc: 1, rejectionAuc: 1, calibration: cal, aucWarm: null, aucCold: null, meanPredicted: 0.5, observedRate: 0.5 },
    policy: null,
    latencyMs: { p50: 0.1, p95: over.p95 ?? 0.5, p99: 1, mean: 0.2, policyP95: null },
    bytes: 1000,
  };
}

describe("promotion gates", () => {
  const popularity = result("popularity", 0.4);
  const v1 = result("v1", 0.37);

  it("pass for a candidate that beats both baselines within every budget", () => {
    const g = evaluateGates({ candidate: result("hybrid", 0.6, { ece: 0.02 }), popularity, v1, active: null, artifactBytes: 50_000 });
    expect(g.gates.map((x) => [x.id, x.passed])).toEqual([
      ["beats_popularity", true],
      ["beats_v1", true],
      ["false_rec_vs_active", true],
      ["calibration", true],
      ["fairness", true],
      ["size", true],
      ["latency", true],
    ]);
    expect(g.passed).toBe(true);
    expect(g.gates[2].note).toContain("no active model");
  });

  it("fail on each budget separately", () => {
    const fail = (c: ContenderResult, bytes = 1000, active: ContenderResult | null = null) =>
      evaluateGates({ candidate: c, popularity, v1, active, artifactBytes: bytes })
        .gates.filter((g) => !g.passed)
        .map((g) => g.id);
    expect(fail(result("c", 0.39))).toEqual(["beats_popularity"]);
    expect(fail(result("c", 0.6, { ece: 0.2 }))).toEqual(["calibration"]);
    expect(fail(result("c", 0.6, { ratio: 0.7 }))).toEqual(["fairness"]);
    expect(fail(result("c", 0.6, { p95: 50 }))).toEqual(["latency"]);
    expect(fail(result("c", 0.6), DEFAULT_BUDGETS.maxArtifactBytes + 1)).toEqual(["size"]);
    expect(fail(result("c", 0.6, { falseRec: 0.32 }), 1000, result("active", 0.5, { falseRec: 0.3 }))).toEqual(["false_rec_vs_active"]);
    expect(fail(result("c", 0.6, { falseRec: 0.305 }), 1000, result("active", 0.5, { falseRec: 0.3 }))).toEqual([]);
  });
});
