import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { examplesFor, generateWorld, splitPeople } from "../synthetic";
import type { RecommenderInput, TrainingExample } from "../types";
import { checkDataset, containsResearchData, invalidReason } from "./quality";

const blank: RecommenderInput = { answers: {}, preferences: DEFAULT_PREFS, view: "complex", explicit: [], signals: {}, history: [] };
const ex = (over: Partial<TrainingExample> = {}): TrainingExample => ({ subject: "a", input: blank, item: "textSize.125", label: 1, weight: 1, source: "synthetic", ...over });

describe("example validation", () => {
  it("accepts a clean example", () => expect(invalidReason(ex())).toBeNull());

  it("rejects each kind of broken example", () => {
    expect(invalidReason(ex({ item: "theme.dark" as never }))).toBe("unknown item");
    expect(invalidReason(ex({ label: 2 as never }))).toBe("label");
    expect(invalidReason(ex({ weight: 0 }))).toBe("weight");
    expect(invalidReason(ex({ input: { ...blank, answers: { inputMode: "shout" } as never } }))).toBe("answers");
    expect(invalidReason(ex({ input: { ...blank, preferences: { ...DEFAULT_PREFS, textSize: 130 as never } } }))).toBe("preferences");
    expect(invalidReason(ex({ input: { ...blank, explicit: ["textSize", "textSize"] } }))).toBe("explicit");
    expect(invalidReason(ex({ input: { ...blank, signals: { textLarger: 11 } } }))).toBe("signals");
    expect(invalidReason(ex({ input: { ...blank, signals: { salary: 1 } as never } }))).toBe("signals");
    expect(
      invalidReason(
        ex({
          input: {
            ...blank,
            history: [
              { item: "density.calm", outcome: "rejected", at: 5 },
              { item: "density.calm", outcome: "rejected", at: 1 },
            ],
          },
        }),
      ),
    ).toBe("history order");
    expect(invalidReason(ex({ input: { ...blank, ageBand: "65+" } as never }))).toBe("input keys");
    // Product policy violations.
    expect(invalidReason(ex({ input: { ...blank, preferences: { ...DEFAULT_PREFS, textSize: 125 } } }))).toBe("item already active");
    expect(invalidReason(ex({ input: { ...blank, explicit: ["textSize"] } }))).toBe("item on explicit dimension");
  });

  it("detects research data anywhere", () => {
    expect(containsResearchData(ex())).toBe(false);
    expect(containsResearchData({ ...ex(), subject: "65+" })).toBe(true);
    expect(containsResearchData({ ...ex(), extra: { ageBand: "x" } } as never)).toBe(true);
  });
});

describe("dataset checks", () => {
  it("passes the synthetic world, with no leakage between person splits", () => {
    const world = generateWorld({ seed: 5, people: 800 });
    const split = splitPeople(world.people.length, 5);
    const parts = { train: examplesFor(world, split.train), validation: examplesFor(world, split.validation), test: examplesFor(world, split.test) };
    const r = checkDataset(world.examples, parts);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.leakage).toEqual({ trainValidation: 0, trainTest: 0, validationTest: 0 });
    expect(r.subjects).toBeGreaterThan(700);
    expect(r.labelBalance["density.calm"].n).toBeGreaterThan(0);
  });

  it("finds duplicates, invalid examples, leakage and thin items", () => {
    const a = ex();
    const r = checkDataset([a, { ...a }, ex({ label: 3 as never })], { train: [a], validation: [], test: [ex()] });
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual({ label: 1 });
    expect(r.leakage!.trainTest).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w) => w.includes("view.simple: only 0"))).toBe(true);
    expect(checkDataset([], null).errors).toContain("no examples");
  });
});
