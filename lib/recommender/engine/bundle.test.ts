import { describe, expect, it } from "vitest";
import { conflicts, isCompatible, ITEM_IDS, type ItemId, MAX_BUNDLE_SIZE } from "../catalog";
import { rng } from "../random";
import { type Candidate, chooseConfigurations, configurationOffer, configurationTitle, contradicts, enumerateConfigurations, isValidChange, toConfiguration } from "./bundle";

const cand = (item: ItemId, probability: number, threshold = 0.6): Candidate => ({ item, probability, threshold, evidence: "moderate" });

describe("enumerateConfigurations", () => {
  it("finds the compatible subset (≤ 4 items) with the largest Σ (p − threshold), matching brute force", () => {
    const r = rng(5);
    for (let trial = 0; trial < 30; trial++) {
      const items = ITEM_IDS.filter(() => r() < 0.6);
      const cs = items.map((id) => cand(id, 0.6 + r() * 0.4, 0.55 + r() * 0.05));
      const best = enumerateConfigurations(cs, [])[0];
      let bruteBest = -Infinity;
      for (let mask = 1; mask < 1 << cs.length; mask++) {
        const pick = cs.filter((_, i) => mask & (1 << i));
        if (pick.length > MAX_BUNDLE_SIZE || !isCompatible(pick.map((c) => c.item))) continue;
        bruteBest = Math.max(bruteBest, pick.reduce((s, c) => s + c.probability - c.threshold, 0));
      }
      if (cs.length === 0) expect(best).toBeUndefined();
      else expect(best.score).toBeCloseTo(bruteBest, 12);
    }
  });

  it("never puts conflicting items (same dimension, or Detailed view with a calm home screen) together", () => {
    const cs = [cand("view.detailed", 0.95), cand("density.calm", 0.9), cand("textSize.125", 0.9), cand("textSize.150", 0.85), cand("view.simple", 0.7)];
    for (const s of enumerateConfigurations(cs, [])) {
      expect(isCompatible(s.items)).toBe(true);
      for (const a of s.items) for (const b of s.items) if (a !== b) expect(conflicts(a, b)).toBe(false);
    }
  });

  it("respects settings left in effect: no calm home screen while staying in Detailed view", () => {
    expect(isValidChange(["density.calm"], ["view.detailed"])).toBe(false);
    expect(isValidChange(["density.calm", "view.simple"], ["view.detailed"])).toBe(true);
    expect(contradicts("density.calm", ["textSize.125"], ["view.detailed"])).toBe(true);
    expect(contradicts("density.calm", ["view.simple"], ["view.detailed"])).toBe(false);
    const sets = enumerateConfigurations([cand("density.calm", 0.9), cand("textSize.125", 0.7)], ["view.detailed"]);
    expect(sets.map((s) => s.items)).toEqual([["textSize.125"]]);
  });
});

describe("chooseConfigurations", () => {
  it("offers distinct alternatives: start small, and one without the top item's dimension", () => {
    const cs = [cand("textSize.125", 0.95), cand("contrast.high", 0.8), cand("spacing.roomy", 0.75), cand("voiceFirst.on", 0.7)];
    const { best, alternatives } = chooseConfigurations(cs, [], 2);
    expect(best!.items).toEqual(["textSize.125", "contrast.high", "spacing.roomy", "voiceFirst.on"]);
    expect(alternatives).toHaveLength(2);
    expect(alternatives.some((a) => a.items.length === 1 && a.items[0] === "textSize.125")).toBe(true);
    expect(alternatives.some((a) => !a.items.includes("textSize.125"))).toBe(true);
    const keys = [best!, ...alternatives].map((s) => [...s.items].sort().join());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns nothing when no candidate can be suggested", () => {
    expect(chooseConfigurations([], [], 2)).toEqual({ best: null, alternatives: [] });
  });
});

describe("configuration text", () => {
  it("titles list item names in catalog order, keeping view names capitalised", () => {
    expect(configurationTitle(["textSize.125"])).toBe("Larger text");
    expect(configurationTitle(["textSize.125", "density.calm"])).toBe("Less on the home screen and larger text");
    expect(configurationTitle(["targets.large", "view.simple", "textSize.125"])).toBe("Simple view, larger text and bigger buttons");
  });

  it("offers are questions built from the preview actions and the view switch", () => {
    expect(configurationOffer(["textSize.125"])).toBe("Would you like to make the text 125% of the standard size?");
    expect(configurationOffer(["view.simple"])).toBe("Would you like to switch to Simple view?");
    expect(configurationOffer(["view.simple", "contrast.high"])).toBe("Would you like to switch to Simple view and use stronger contrast?");
    expect(configurationOffer(["view.detailed", "contrast.high", "targets.large"])).toBe(
      "Would you like to switch to Detailed view, use stronger contrast and make buttons bigger and easier to press?",
    );
  });

  it("builds the configuration with actions, mode, conservative confidence and the weakest evidence", () => {
    const cs = [cand("view.simple", 0.9), { ...cand("textSize.125", 0.7), evidence: "limited" as const }];
    const c = toConfiguration({ items: ["textSize.125", "view.simple"], score: 0 }, new Map(cs.map((x) => [x.item, x])));
    expect(c).toEqual({
      items: ["view.simple", "textSize.125"],
      actions: [{ type: "textSize", value: 125 }],
      mode: "simple",
      title: "Simple view and larger text",
      offer: "Would you like to switch to Simple view and make the text 125% of the standard size?",
      confidence: 0.7,
      evidence: "limited",
    });
  });
});
