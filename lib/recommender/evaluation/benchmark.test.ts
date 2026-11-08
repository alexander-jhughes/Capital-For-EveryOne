import { describe, expect, it } from "vitest";
import { AGE_BANDS } from "../profile";
import { examplesFor, generateWorld, splitPeople } from "../synthetic";
import type { RecommenderInput } from "../types";
import { randomScorer, trainPopularity } from "./baselines";
import { acceptanceProfile, familyOf, groupsOf, hasConflictingAnswers, oracleScorer, rankItems, runBenchmark, type Scorer, STRATA, stratumOf } from "./benchmark";

const world = generateWorld({ seed: 31, people: 2500 });
const split = splitPeople(world.people.length, 31);
const train = examplesFor(world, split.train);

describe("ranking helpers and groups", () => {
  it("ranks by score, unscored last, ties in candidate order", () => {
    expect(rankItems({ "density.calm": 0.2, "textSize.125": 0.9, "view.simple": 0.2 }, ["view.simple", "density.calm", "textSize.125", "contrast.high"])).toEqual([
      "textSize.125",
      "view.simple",
      "density.calm",
      "contrast.high",
    ]);
    expect(rankItems({ "density.calm": NaN }, ["density.calm", "view.simple"])).toEqual(["density.calm", "view.simple"]);
  });

  it("flags conflicting answers and puts every snapshot in exactly one stratum", () => {
    expect(hasConflictingAnswers({ screenComplexity: "everything", detailLevel: "keyFacts" })).toBe(true);
    expect(hasConflictingAnswers({ screenComplexity: "everything", detailLevel: "everything" })).toBe(false);
    for (const p of world.people.slice(0, 300)) expect(STRATA).toContain(stratumOf(p.evaluation.input));
  });

  it("reads the age band from the synthetic person, never from the input", () => {
    const p = world.people[0];
    const groups = groupsOf(p, p.evaluation.input);
    expect(groups).toContain(`age band (fairness only): ${p.research.ageBand}`);
    expect(new Set(groups.map(familyOf)).size).toBe(groups.length);
  });
});

describe("benchmark", () => {
  const seen: RecommenderInput[] = [];
  const pop = trainPopularity(train);
  const spy: Scorer = (input) => {
    if (seen.length < 2000) seen.push(input);
    return pop(input);
  };
  const result = runBenchmark(
    world,
    split.test,
    [
      { name: "oracle", scorer: oracleScorer(world) },
      { name: "popularity", scorer: spy, policy: (input) => (input.history.length ? [] : ["textSize.150"]) },
      { name: "random", scorer: randomScorer(5) },
      { name: "partial", scorer: () => ({ "textSize.125": 0.5 }) },
    ],
    { latencySamples: 50, minGroupSize: 20 },
  );
  const [oracle, popularity, random, partial] = result.contenders;

  it("the hidden-truth ceiling ranks perfectly and beats the baselines", () => {
    expect(oracle.oracle.overall["ndcg@3"]).toBeCloseTo(1, 10);
    expect(oracle.oracle.overall["ndcg@1"]).toBeCloseTo(1, 10);
    expect(oracle.logged.auc!).toBeGreaterThan(0.75);
    expect(popularity.oracle.overall["ndcg@3"]!).toBeGreaterThan(random.oracle.overall["ndcg@3"]!);
    expect(oracle.oracle.overall["benefit@3"]!).toBeGreaterThan(popularity.oracle.overall["benefit@3"]!);
    expect(oracle.oracle.overall["falseRec@3"]!).toBeLessThan(random.oracle.overall["falseRec@3"]!);
    expect(random.logged.auc!).toBeGreaterThan(0.4);
    expect(random.logged.auc!).toBeLessThan(0.6);
  });

  it("reports strata, groups and disparity per family", () => {
    expect(result.people).toBe(split.test.length);
    expect(Object.keys(oracle.oracle.strata).every((s) => (STRATA as readonly string[]).includes(s))).toBe(true);
    const strataTotal = STRATA.reduce((s, k) => s + (result.sizes[k] ?? 0), 0);
    expect(strataTotal).toBe(split.test.length);
    expect(Object.keys(popularity.oracle.disparity)).toContain("age band (fairness only)");
    for (const b of AGE_BANDS) expect(result.sizes[`age band (fairness only): ${b}`]).toBeGreaterThan(0);
    const d = popularity.oracle.disparity.view!;
    expect(d.ratio).toBeGreaterThan(0);
    expect(d.ratio).toBeLessThanOrEqual(1);
    expect(popularity.oracle.minDisparityRatio).toBeLessThanOrEqual(d.ratio);
  });

  it("never passes research data to a scorer", () => {
    expect(seen.length).toBeGreaterThan(100);
    for (const input of seen) {
      expect(Object.keys(input).sort()).toEqual(["answers", "explicit", "history", "preferences", "signals", "view"]);
      const json = JSON.stringify(input);
      for (const b of AGE_BANDS) expect(json).not.toContain(`"${b}"`);
    }
  });

  it("counts policy violations and offered-item quality", () => {
    const p = popularity.policy!;
    expect(p.people).toBe(split.test.length);
    expect(p.suggestionRate).toBeGreaterThan(0);
    expect(p.meanConfigurationSize).toBe(1);
    // textSize.150 is offered even when it is not eligible (e.g. text already at 150%): those are violations.
    expect(p.policyViolations).toBeGreaterThan(0);
    expect(p.falseRecRate!).toBeGreaterThan(0.5); // much larger text rarely helps in this world
    expect(p.suggestionRateRepeatRejecters).toBe(0);
  });

  it("logged evaluation skips unscored items and reports the share scored", () => {
    expect(partial.logged.scoredShare).toBeGreaterThan(0);
    expect(partial.logged.scoredShare).toBeLessThan(0.3);
    expect(popularity.logged.scoredShare).toBe(1);
    expect(popularity.logged.calibration.bins).toHaveLength(10);
    expect(popularity.latencyMs.p95).not.toBeNull();
  });

  it("acceptance profile reports label rates by shown position and by item", () => {
    // Raw rates by position mix position bias with selection (bigger suggestions come from the rules policy), so only
    // their presence is checked here; SYNTHETIC-DATA.md discusses the confounding.
    const a = acceptanceProfile(world, split.train);
    for (const k of ["0", "1", "2"]) expect(a.byPosition[k].n).toBeGreaterThan(0);
    for (const v of Object.values(a.byPosition)) expect(v.rate > 0 && v.rate < 1).toBe(true);
    expect(Object.keys(a.byItem).length).toBeGreaterThan(10);
  });
});
