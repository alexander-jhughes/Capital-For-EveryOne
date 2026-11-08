// Each component, trained only from TrainingExamples of the fixture world, must learn the planted relationships
// and beat the popularity baseline on held-out people.
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { ITEM_IDS } from "../catalog";
import type { RecommenderInput } from "../types";
import { mergeSmallClusters, sphericalKMeans, trainCollaborative } from "./collaborative";
import { prepareExamples } from "./data";
import { auc, logLoss } from "./math";
import { DEFAULT_HYPER } from "./model";
import { trainPopularity } from "./popularity";
import { SIMILARITY_WEIGHTS } from "./similarity";
import { rng } from "../random";
import { COLD_START, FIXTURE_OPTIONS, fixtureSplits, MINIMAL_GUIDED_VOICE, T0 } from "./test-world";
import { type Scorer, trainComponentScorers } from "./train";

type Name = "content" | "collaborative" | "factorization" | "popularity";
let scorers: Record<Name, Scorer>;
let heldOut: { p: Record<Name, number[]>; y: number[] };

const keyFacts: RecommenderInput = MINIMAL_GUIDED_VOICE;
const everything: RecommenderInput = {
  ...MINIMAL_GUIDED_VOICE,
  answers: {
    detailLevel: "everything",
    screenComplexity: "everything",
    inputMode: "touch",
    guidance: "independent",
    creditFamiliarity: "confident",
    explanationFormat: "written",
    priority: "transactions",
    appConfidence: "high",
    budgetingFamiliarity: "some",
    answerLength: "detailed",
    screenReader: "no",
  },
  view: "simple",
};

beforeAll(() => {
  const s = fixtureSplits();
  scorers = trainComponentScorers(s.train, FIXTURE_OPTIONS);
  const p = { content: [], collaborative: [], factorization: [], popularity: [] } as Record<Name, number[]>;
  const y: number[] = [];
  for (const e of s.test.examples) {
    for (const name of Object.keys(p) as Name[]) p[name].push(scorers[name](e.input)[e.item]!);
    y.push(e.label);
  }
  heldOut = { p, y };
}, 60_000);

describe("every component", () => {
  it("returns a probability for all 16 items", () => {
    for (const name of ["content", "collaborative", "factorization", "popularity"] as Name[]) {
      const out = scorers[name](keyFacts);
      expect(Object.keys(out).sort()).toEqual([...ITEM_IDS].sort());
      expect(Object.values(out).every((v) => v! > 0 && v! < 1)).toBe(true);
    }
  });

  it.each(["content", "collaborative", "factorization"] as const)("%s beats popularity on held-out people (log loss and AUC)", (name) => {
    const { p, y } = heldOut;
    expect(logLoss(p[name], y)).toBeLessThan(logLoss(p.popularity, y) - 0.01);
    expect(auc(p[name], y)).toBeGreaterThan(auc(p.popularity, y) + 0.04);
  });
});

describe("planted relationships", () => {
  it("content and factorisation learn that 'Talking' predicts keeping voice-first and 'Upcoming payments' the bill at the top", () => {
    const touch = { ...keyFacts, answers: { ...keyFacts.answers, inputMode: "touch" as const, priority: "transactions" as const } };
    for (const name of ["content", "factorization"] as const) {
      expect(scorers[name](keyFacts)["voiceFirst.on"]! - scorers[name](touch)["voiceFirst.on"]!).toBeGreaterThan(0.2);
      expect(scorers[name](keyFacts)["homeFocus.bill"]! - scorers[name](touch)["homeFocus.bill"]!).toBeGreaterThan(0.2);
      expect(scorers[name](touch)["homeFocus.recent"]!).toBeGreaterThan(scorers[name](keyFacts)["homeFocus.recent"]!);
    }
  });

  it("collaborative: people with answers like 'as little as possible' kept a calmer home screen more than people who want everything", () => {
    const c = scorers.collaborative;
    expect(c(keyFacts)["density.calm"]! - c(everything)["density.calm"]!).toBeGreaterThan(0.15);
    expect(c(everything)["homeFocus.recent"]!).toBeGreaterThan(c(keyFacts)["homeFocus.recent"]!);
  });

  it("collaborative: someone who told Dial nothing gets the population rate", () => {
    const pop = scorers.popularity(COLD_START);
    const cold = scorers.collaborative(COLD_START);
    for (const id of ITEM_IDS) expect(cold[id]).toBeCloseTo(pop[id]!, 3);
  });

  it("item-to-item: keeping one 'less on screen' change raises the next one; turning it down lowers it", () => {
    const c = scorers.collaborative;
    const answered = { ...COLD_START, preferences: DEFAULT_PREFS, view: "complex" as const };
    const kept = c({ ...answered, history: [{ item: "view.simple", outcome: "accepted", at: T0 }] })["motion.reduced"]!;
    const turnedDown = c({ ...answered, history: [{ item: "view.simple", outcome: "rejected", at: T0 }] })["motion.reduced"]!;
    expect(kept).toBeGreaterThan(turnedDown + 0.05);
  });
});

describe("collaborative privacy", () => {
  it("never keeps a cluster smaller than the minimum size, and stores aggregates only", () => {
    const data = prepareExamples(fixtureSplits().train);
    const pop = trainPopularity(data, 20);
    const params = trainCollaborative(
      data,
      pop.rate,
      SIMILARITY_WEIGHTS,
      { ...DEFAULT_HYPER, priorStrength: 10, minClusterSize: 40, clusters: 48, iterations: 20 },
      rng(1),
    );
    expect(params.centroids.length).toBeGreaterThan(3);
    expect(params.centroids.length).toBeLessThanOrEqual(Math.floor(1500 / 40));
    // No per-item cell describes fewer people than the suppression limit (suppressed cells are stored as 0).
    for (const row of params.count) for (const n of row) expect(n === 0 || n >= DEFAULT_HYPER.minCellCount).toBe(true);
    expect(JSON.stringify(params)).not.toMatch(/train-\d/);
  });

  it("merges small clusters until every cluster has at least the minimum size", () => {
    const r = rng(3);
    const n = 200;
    const dim = 4;
    const points = new Float64Array(n * dim);
    for (let i = 0; i < n; i++) {
      const v = Array.from({ length: dim }, () => r());
      const norm = Math.hypot(...v);
      v.forEach((x, f) => (points[i * dim + f] = x / norm));
    }
    const assign = sphericalKMeans(points, n, dim, 20, rng(4), 20);
    const groups = mergeSmallClusters(points, dim, assign, 20, 25);
    expect(groups.every((g) => g.length >= 25)).toBe(true);
    expect(groups.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(mergeSmallClusters(points, dim, assign, 20, 1000)).toEqual([]);
  });
});

describe("determinism", () => {
  it("the same seed gives identical component scores", () => {
    const again = trainComponentScorers(fixtureSplits().train, FIXTURE_OPTIONS);
    for (const name of ["content", "collaborative", "factorization", "popularity"] as Name[]) expect(again[name](keyFacts)).toEqual(scorers[name](keyFacts));
  });
});
