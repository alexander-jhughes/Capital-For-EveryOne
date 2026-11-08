import { beforeAll, describe, expect, it } from "vitest";
import { ITEM_IDS } from "../catalog";
import { artifactBytes, roundDeep } from "./artifact";
import { auc, expectedCalibrationError, logLoss } from "./math";
import type { RecommenderModel } from "./model";
import { scoreItems } from "./recommend";
import { FIXTURE_OPTIONS, fixtureModel, fixtureSplits } from "./test-world";
import { MIN_VALIDATION_EXAMPLES, trainComponentScorers, trainRecommender } from "./train";
import { isValidRecommenderModel } from "./artifact";

let model: RecommenderModel;
beforeAll(() => {
  model = fixtureModel();
}, 60_000);

describe("trainRecommender", () => {
  it("produces a valid artifact with the contract header", () => {
    expect(isValidRecommenderModel(model)).toBe(true);
    expect(model.format).toBe("cfe-recommender");
    expect(model.formatVersion).toBe(1);
    expect(model.version).toBe(FIXTURE_OPTIONS.version);
    expect(model.datasetVersion).toBe(FIXTURE_OPTIONS.datasetVersion);
    expect(model.trainedOn).toBe("synthetic");
    expect(model.items).toEqual([...ITEM_IDS]);
    expect(model.stats.trainSubjects).toBe(1500);
    expect(model.stats.validationSubjects).toBe(600);
  });

  it("is deterministic: the same seed gives a byte-identical artifact; another seed does not", () => {
    const s = fixtureSplits();
    const again = trainRecommender(s.train, s.validation, FIXTURE_OPTIONS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(model));
    const other = trainRecommender(s.train, s.validation, { ...FIXTURE_OPTIONS, seed: 8 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(model));
  }, 60_000);

  it("is calibrated on held-out people (ECE < 0.05) and at least as good as its best component", () => {
    const test = fixtureSplits().test.examples;
    const y = test.map((e) => e.label);
    const p = test.map((e) => scoreItems(model, e.input).find((s) => s.item === e.item)!.probability);
    expect(expectedCalibrationError(p, y)).toBeLessThan(0.05);
    const scorers = trainComponentScorers(fixtureSplits().train, FIXTURE_OPTIONS);
    const best = Math.min(...(["content", "collaborative", "factorization"] as const).map((n) => logLoss(test.map((e) => scorers[n](e.input)[e.item]!), y)));
    expect(logLoss(p, y)).toBeLessThan(best + 0.005);
    expect(auc(p, y)).toBeGreaterThan(0.7);
    expect(model.stats.validationEce).not.toBeNull();
    expect(model.stats.validationEce!).toBeLessThan(0.05);
  }, 60_000);

  it("chooses thresholds of at least 0.55 on validation, and leaves items it can't trust without one", () => {
    const set = model.thresholds.filter((t): t is number => t !== null);
    expect(set.length).toBeGreaterThan(3);
    expect(set.length).toBeLessThan(ITEM_IDS.length);
    expect(set.every((t) => t >= 0.55 && t < 1)).toBe(true);
    expect(model.stats.itemsWithThreshold).toBe(set.length);
  });

  it("without enough validation data, fits no stacker and sets no thresholds (nothing is ever suggested)", () => {
    const s = fixtureSplits();
    const m = trainRecommender(s.train, s.validation.slice(0, MIN_VALIDATION_EXAMPLES - 1), FIXTURE_OPTIONS);
    expect(isValidRecommenderModel(m)).toBe(true);
    expect(m.thresholds.every((t) => t === null)).toBe(true);
    expect(m.stats.validationEce).toBeNull();
  }, 60_000);

  it("trains on nothing without crashing (population priors only)", () => {
    const m = trainRecommender([], [], FIXTURE_OPTIONS);
    expect(isValidRecommenderModel(m)).toBe(true);
    expect(m.collaborative.centroids).toHaveLength(0);
  });

  it("rejects missing header options", () => {
    expect(() => trainRecommender([], [], { ...FIXTURE_OPTIONS, version: "" })).toThrow();
    expect(() => trainRecommender([], [], { ...FIXTURE_OPTIONS, trainedOn: "real" as never })).toThrow();
  });

  it("ignores malformed examples", () => {
    const s = fixtureSplits();
    const bad = [
      { ...s.train[0], item: "theme.dark" },
      { ...s.train[0], label: 2 },
      { ...s.train[0], weight: 0 },
    ] as never[];
    const m = trainRecommender([...s.train.slice(0, 300), ...bad], [], FIXTURE_OPTIONS);
    expect(m.stats.trainExamples).toBe(300);
  });
});

describe("artifact", () => {
  it("is small: under 150 KB serialised", () => {
    expect(artifactBytes(model)).toBeLessThan(150_000);
  });

  it("holds no examples, subject ids or answers, only rounded parameters and aggregates", () => {
    const json = JSON.stringify(model);
    expect(json).not.toMatch(/train-\d|val-\d|"subject"|"answers"|"history"/);
    expect(JSON.stringify(roundDeep(model))).toBe(json);
  });

  it("survives a JSON round trip", () => {
    const copy = JSON.parse(JSON.stringify(model));
    expect(isValidRecommenderModel(copy)).toBe(true);
    expect(scoreItems(copy, fixtureSplits().test.people[0].first)).toEqual(scoreItems(model, fixtureSplits().test.people[0].first));
  });
});
