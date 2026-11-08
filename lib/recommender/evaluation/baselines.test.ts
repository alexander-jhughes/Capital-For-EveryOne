import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { isCompatible, ITEM_IDS } from "../catalog";
import { eligibleItems, examplesFor, generateWorld, splitPeople } from "../synthetic";
import type { RecommenderInput, TrainingExample } from "../types";
import { assertV1Model, itemRates, randomScorer, rulesPolicy, SMOOTHING, trainPopularity, trainRules, V1_TARGET_TO_ITEM, v1ForestScorer, v1Policy, v1View } from "./baselines";
import { answersToChoices, itemOfAction, rulesItems } from "./rules";

const v1 = assertV1Model(JSON.parse(readFileSync(fileURLToPath(new URL("../../personalisation/model.json", import.meta.url)), "utf8")));
const blank: RecommenderInput = { answers: {}, preferences: DEFAULT_PREFS, view: "complex", explicit: [], signals: {}, history: [] };
const ex = (item: TrainingExample["item"], label: 0 | 1, input = blank): TrainingExample => ({ subject: "s", input, item, label, weight: 1, source: "synthetic" });

describe("rules mapping (baseline only)", () => {
  it("maps answers to Make it yours choices", () => {
    expect(answersToChoices({})).toEqual([]);
    expect(answersToChoices({ screenComplexity: "minimal", detailLevel: "keyFacts" })).toEqual(["lessInfo"]);
    expect(answersToChoices({ inputMode: "voice", guidance: "guided", priority: "payments" }).sort()).toEqual(["paymentsProminent", "stepByStep", "voiceFirst"]);
  });

  it("runs the published rule table and returns catalogue items, direct settings winning conflicts", () => {
    expect(rulesItems({})).toEqual([]);
    // lessInfo -> Calm & Clear: simple view, calm density, roomy spacing.
    expect(rulesItems({ screenComplexity: "minimal" })).toEqual(["view.simple", "density.calm", "spacing.roomy"]);
    // voice -> Accessible Voice: simple view, voice first, large targets.
    expect(rulesItems({ inputMode: "voice" })).toEqual(["view.simple", "voiceFirst.on", "targets.large"]);
    // lessInfo + moreDetail + moreVisual -> Visual Insights (Detailed view, chart on top) plus the direct calm density.
    // Detailed view conflicts with a calm home screen; the direct setting wins, as in the rule table.
    expect(rulesItems({ detailLevel: "everything", screenComplexity: "minimal", explanationFormat: "visual" })).toEqual(["homeFocus.chart", "density.calm"]);
    for (const answers of [{ screenComplexity: "everything" as const, guidance: "guided" as const, priority: "payments" as const }, { inputMode: "voice" as const, detailLevel: "keyFacts" as const }])
      expect(isCompatible(rulesItems(answers).slice(0, 4))).toBe(true);
  });

  it("maps preference actions to items", () => {
    expect(itemOfAction({ type: "textSize", value: 125 })).toBe("textSize.125");
    expect(itemOfAction({ type: "textSize", value: 200 })).toBe("textSize.150");
    expect(itemOfAction({ type: "moveToTop", widget: "chart" })).toBe("homeFocus.chart");
    expect(itemOfAction({ type: "moveToTop", widget: "pause" })).toBeNull();
    expect(itemOfAction({ type: "density", value: "standard" })).toBeNull();
  });
});

describe("label-rate baselines", () => {
  it("popularity shrinks item rates towards the overall rate", () => {
    const train = [ex("textSize.125", 1), ex("textSize.125", 1), ex("density.calm", 0), ex("density.calm", 0)];
    const rates = itemRates(train);
    // overall rate 0.5; textSize.125: (2 + 20·0.5)/(2 + 20)
    expect(rates["textSize.125"]).toBeCloseTo((2 + SMOOTHING * 0.5) / (2 + SMOOTHING), 12);
    expect(rates["density.calm"]).toBeCloseTo((0 + SMOOTHING * 0.5) / (2 + SMOOTHING), 12);
    expect(rates["view.simple"]).toBeCloseTo(0.5, 12);
    expect(trainPopularity(train)(blank)["textSize.125"]).toBe(rates["textSize.125"]);
  });

  it("rules baseline separates items inside and outside the rules' suggestion", () => {
    const calm: RecommenderInput = { ...blank, answers: { screenComplexity: "minimal" } };
    const train = [...Array.from({ length: 50 }, () => ex("density.calm", 1, calm)), ...Array.from({ length: 50 }, () => ex("density.calm", 0, blank))];
    const s = trainRules(train);
    expect(s(calm)["density.calm"]!).toBeGreaterThan(0.6);
    expect(s(blank)["density.calm"]!).toBeLessThan(0.4);
  });

  it("rules policy offers eligible, compatible items and nothing without answers", () => {
    expect(rulesPolicy(blank, 0)).toEqual([]);
    const offer = rulesPolicy({ ...blank, answers: { screenComplexity: "minimal" }, explicit: ["spacing"] }, 0)!;
    expect(offer).toEqual(["view.simple", "density.calm"]);
  });

  it("random scorer is deterministic per input and seed", () => {
    const r = randomScorer(3);
    expect(r(blank)).toEqual(r(structuredClone(blank)));
    expect(randomScorer(4)(blank)).not.toEqual(r(blank));
    expect(Object.keys(r(blank))).toEqual([...ITEM_IDS]);
  });
});

describe("v1 random forest baseline", () => {
  it("sees settings, view and the six v1 signals only (not answers or history)", () => {
    const withAnswers: RecommenderInput = {
      ...blank,
      answers: { inputMode: "voice", screenComplexity: "minimal" },
      history: [{ item: "textSize.125", outcome: "rejected", at: 1 }],
      signals: { voiceSessions: 3, shorterAnswers: 4, moreVisual: 2 },
    };
    const { v1Input, signals } = v1View(withAnswers);
    expect(v1Input.choices).toBeNull();
    expect(Object.keys(signals).sort()).toEqual(["lessOnScreen", "moreDetail", "textLarger", "textSmaller", "undoneChanges", "voiceSessions"]);
    const score = v1ForestScorer(v1);
    expect(score(withAnswers)).toEqual(score({ ...withAnswers, answers: {}, history: [], signals: { voiceSessions: 3 } }));
  });

  it("scores exactly the 8 mapped items with probabilities", () => {
    const s = v1ForestScorer(v1)(blank);
    expect(Object.keys(s).sort()).toEqual(Object.values(V1_TARGET_TO_ITEM).sort());
    for (const v of Object.values(s)) expect(v! >= 0 && v! <= 1).toBe(true);
  });

  it("the end-to-end v1 policy only offers eligible items", () => {
    const world = generateWorld({ seed: 11, people: 400 });
    const policy = v1Policy(v1);
    for (const p of world.people) {
      const offer = policy(p.evaluation.input, p.evaluation.now) ?? [];
      const eligible = eligibleItems(p.evaluation.input);
      for (const id of offer) {
        expect(Object.values(V1_TARGET_TO_ITEM)).toContain(id);
        expect(eligible).toContain(id);
      }
    }
  });
});

describe("baselines on a small synthetic world", () => {
  it("train on train people only and give probabilities in [0, 1]", () => {
    const world = generateWorld({ seed: 12, people: 600 });
    const split = splitPeople(world.people.length, 12);
    const train = examplesFor(world, split.train);
    for (const s of [trainPopularity(train), trainRules(train)]) {
      const out = s(world.people[split.test[0]].evaluation.input);
      expect(Object.keys(out)).toHaveLength(ITEM_IDS.length);
      for (const v of Object.values(out)) expect(v! > 0 && v! < 1).toBe(true);
    }
  });
});
