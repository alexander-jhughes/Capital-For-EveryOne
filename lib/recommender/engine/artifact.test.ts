/* eslint-disable @typescript-eslint/no-explicit-any -- the tests corrupt arbitrary parts of a JSON copy */
import { beforeAll, describe, expect, it } from "vitest";
import { isValidRecommenderModel, roundDeep } from "./artifact";
import { round4 } from "./math";
import type { RecommenderModel } from "./model";
import { recommend, scoreItems } from "./recommend";
import { COLD_START, fixtureModel } from "./test-world";

let model: RecommenderModel;
beforeAll(() => {
  model = fixtureModel();
}, 60_000);

const corrupt = (f: (m: Record<string, any>) => void): unknown => {
  const copy = JSON.parse(JSON.stringify(model)) as Record<string, any>;
  f(copy);
  return copy;
};

const CORRUPTIONS: [string, (m: Record<string, any>) => void][] = [
  ["wrong format", (m) => (m.format = "other")],
  ["wrong format version", (m) => (m.formatVersion = 2)],
  ["empty version", (m) => (m.version = "")],
  ["unknown trainedOn", (m) => (m.trainedOn = "real")],
  ["missing datasetVersion", (m) => delete m.datasetVersion],
  ["feature ids reordered", (m) => m.featureIds.reverse()],
  ["feature id missing", (m) => m.featureIds.pop()],
  ["items changed", (m) => (m.items[0] = "theme.dark")],
  ["NaN content weight", (m) => (m.content.weights[3][5] = Number.NaN)],
  ["string content weight", (m) => (m.content.weights[3][5] = "1")],
  ["short content row", (m) => m.content.weights[2].pop()],
  ["missing intercepts", (m) => delete m.content.intercept],
  ["popularity rate of 1", (m) => (m.popularity.rate[0] = 1)],
  ["negative popularity count", (m) => (m.popularity.count[0] = -1)],
  ["cluster rate above 1", (m) => (m.collaborative.rate[0][0] = 1.5)],
  ["negative cluster count", (m) => (m.collaborative.count[0][0] = -3)],
  ["centroid of the wrong length", (m) => m.collaborative.centroids[0].push(0)],
  ["rate rows don't match clusters", (m) => m.collaborative.rate.pop()],
  ["zero temperature", (m) => (m.collaborative.temperature = 0)],
  ["coLift wrong shape", (m) => m.collaborative.coLift[0].pop()],
  ["infinite coLift", (m) => (m.collaborative.coLift[0][0][1] = Number.POSITIVE_INFINITY)],
  ["factor count zero", (m) => (m.factorization.factors = 0)],
  ["factor count not matching embeddings", (m) => (m.factorization.factors = 9)],
  ["tags changed", (m) => (m.factorization.tags[0] = "fun")],
  ["embedding row too short", (m) => m.factorization.featureEmb[0].pop()],
  ["stacker slope missing", (m) => m.stacker.slopes.pop()],
  ["threshold of 1", (m) => (m.thresholds[0] = 1)],
  ["threshold as string", (m) => (m.thresholds[0] = "0.6")],
  ["thresholds too short", (m) => m.thresholds.pop()],
  ["stats missing", (m) => delete m.stats],
  ["hyper with a string", (m) => (m.hyper.contentL2 = "4")],
];

describe("isValidRecommenderModel", () => {
  it("accepts a trained model and its JSON copy", () => {
    expect(isValidRecommenderModel(model)).toBe(true);
    expect(isValidRecommenderModel(JSON.parse(JSON.stringify(model)))).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const x of [null, undefined, 1, "model", [], [model]]) expect(isValidRecommenderModel(x)).toBe(false);
  });

  it.each(CORRUPTIONS)("rejects a model with %s", (_, f) => {
    expect(isValidRecommenderModel(corrupt(f))).toBe(false);
  });

  it("an invalid model makes recommend() unavailable and scoreItems() throw, never a guess", () => {
    for (const [, f] of CORRUPTIONS.slice(0, 10)) {
      const bad = corrupt(f) as RecommenderModel;
      const r = recommend(bad, COLD_START, { now: 0 });
      expect(r.status).toBe("unavailable");
      expect(r.configuration).toBeNull();
      expect(r.scores).toEqual([]);
      expect(r.warnings.map((w) => w.code)).toEqual(["model_unavailable"]);
      expect(() => scoreItems(bad, COLD_START)).toThrow();
    }
  });
});

describe("rounding", () => {
  it("keeps 4 significant digits and never -0", () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(123456)).toBe(123500);
    expect(Object.is(round4(-0.00000001), -0)).toBe(false);
    expect(roundDeep({ a: [1.234567, { b: -2.345678 }], c: "x", d: null })).toEqual({ a: [1.235, { b: -2.346 }], c: "x", d: null });
  });
});
