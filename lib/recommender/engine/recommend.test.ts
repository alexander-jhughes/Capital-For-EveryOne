import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { CATALOG, conflicts, DIMENSIONS, type Dimension, isActive, isCompatible, ITEM_IDS, type ItemId, MAX_BUNDLE_SIZE } from "../catalog";
import { rng } from "../random";
import type { HistoryEntry, RecommendationResult, RecommenderInput } from "../types";
import { safeLogit } from "./math";
import type { RecommenderModel } from "./model";
import { evidenceLevel, POLICY, recommend, scoreItems } from "./recommend";
import { COLD_START, DAY, fixtureModel, fixtureSplits, MINIMAL_GUIDED_VOICE } from "./test-world";

let model: RecommenderModel;
beforeAll(() => {
  model = fixtureModel();
}, 60_000);

const NOW = Date.UTC(2026, 9, 1);

/**
 * A copy of the trained model whose calibrated probabilities are fixed per item (stacker slopes 0), every item
 * thresholded at `threshold`, and plenty of similar people for anyone who answered something. Lets the policy layer
 * be tested in isolation from what the fixture happened to learn.
 */
function rig(probs: Partial<Record<ItemId, number>>, threshold = 0.6, supportScale = 1000): RecommenderModel {
  const m = JSON.parse(JSON.stringify(model)) as RecommenderModel;
  m.stacker = { slopes: [0, 0, 0, 0, 0], intercepts: ITEM_IDS.map((id) => safeLogit(probs[id] ?? 0.2)) };
  m.thresholds = ITEM_IDS.map(() => threshold);
  m.collaborative.count = m.collaborative.count.map((row) => row.map((n) => n * supportScale));
  return m;
}

const ALL_HIGH = Object.fromEntries(ITEM_IDS.map((id, i) => [id, 0.95 - i * 0.01])) as Record<ItemId, number>;
const person: RecommenderInput = { ...MINIMAL_GUIDED_VOICE, view: "simple" };
const allSuggested = (r: RecommendationResult) => [r.configuration, ...r.alternatives].filter((c) => c !== null).flatMap((c) => c!.items);
const reasonOf = (r: RecommendationResult, id: ItemId) => r.withheld.find((w) => w.item === id)?.reason;

describe("status and cold start", () => {
  it("someone who told Dial nothing gets no confident guess: insufficient data, with few_answers and synthetic_only warnings", () => {
    const r = recommend(model, COLD_START, { now: NOW });
    expect(r.status).toBe("insufficient_data");
    expect(r.configuration).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["synthetic_only", "few_answers"]));
    expect(r.scores.length).toBeGreaterThan(0); // population-level scores are still reported…
    expect(r.scores.every((s) => s.evidence === "insufficient" && s.support === 0)).toBe(true); // …with no support
    expect(r.explanation.summary).toMatch(/About you/);
  });

  it("even a rigged, very confident model can't suggest to someone it has no similar people for", () => {
    const r = recommend(rig(ALL_HIGH), COLD_START, { now: NOW });
    expect(r.status).toBe("insufficient_data");
    expect(r.withheld.filter((w) => w.reason === "insufficient_evidence").length).toBeGreaterThan(10);
  });

  it("someone who only answered About you (no history, default settings) gets a useful suggestion straight away", () => {
    const r = recommend(model, MINIMAL_GUIDED_VOICE, { now: NOW });
    expect(r.status).toBe("ok");
    expect(r.configuration).not.toBeNull();
    expect(r.configuration!.items.length).toBeGreaterThan(0);
    expect(r.warnings.map((w) => w.code)).not.toContain("few_answers");
    expect(r.modelVersion).toBe(model.version);
    expect(r.trainedOn).toBe("synthetic");
  });

  it("is mostly ok for answered fixture people and never ok for people who said nothing", () => {
    const people = fixtureSplits().test.people;
    const statuses = people.map((p) => recommend(model, p.first, { now: NOW }).status);
    expect(statuses.filter((s) => s === "ok").length).toBeGreaterThan(people.length * 0.2);
    expect(statuses.includes("unavailable")).toBe(false);
  });

  it("warns when only one or two questions were answered", () => {
    const r = recommend(model, { ...COLD_START, answers: { inputMode: "voice", priority: "payments" } }, { now: NOW });
    expect(r.warnings.map((w) => w.code)).toContain("few_answers");
  });

  it("has no synthetic_only warning for a model trained with real data", () => {
    const real = { ...model, trainedOn: "synthetic+real" as const };
    const r = recommend(real, MINIMAL_GUIDED_VOICE, { now: NOW });
    expect(r.warnings.map((w) => w.code)).not.toContain("synthetic_only");
    expect(r.trainedOn).toBe("synthetic+real");
  });
});

describe("eligibility (hard policy)", () => {
  it("never suggests an item on a dimension the person set themselves", () => {
    const r = recommend(rig(ALL_HIGH), { ...person, explicit: ["textSize", "density", "homeFocus"] }, { now: NOW });
    expect(r.status).toBe("ok");
    for (const id of allSuggested(r)) expect(["textSize", "density", "homeFocus"]).not.toContain(CATALOG[id].dimension);
    expect(reasonOf(r, "textSize.125")).toBe("explicit");
    expect(reasonOf(r, "homeFocus.bill")).toBe("explicit");
  });

  it("treats a non-default value as set on purpose, even if no event recorded it", () => {
    const r = recommend(rig(ALL_HIGH), { ...person, preferences: { ...DEFAULT_PREFS, textSize: 125 } }, { now: NOW });
    expect(reasonOf(r, "textSize.125")).toBe("already_on");
    expect(reasonOf(r, "textSize.150")).toBe("explicit");
  });

  it("never suggests something already in effect", () => {
    const prefs = { ...DEFAULT_PREFS, contrast: "high" as const, layout: { ...DEFAULT_PREFS.layout, density: "calm" as const } };
    const r = recommend(rig(ALL_HIGH), { ...person, preferences: prefs }, { now: NOW });
    expect(reasonOf(r, "contrast.high")).toBe("already_on");
    expect(reasonOf(r, "density.calm")).toBe("already_on");
    expect(reasonOf(r, "view.simple")).toBe("already_on");
    for (const id of allSuggested(r)) expect(isActive(id, prefs, "simple")).toBe(false);
  });

  it("never suggests a calmer home screen against an explicit Detailed view", () => {
    const r = recommend(rig(ALL_HIGH), { ...person, view: "complex", explicit: ["view"] }, { now: NOW });
    expect(reasonOf(r, "density.calm")).toBe("conflict");
    expect(allSuggested(r)).not.toContain("density.calm");
  });

  it("in a Detailed view the person didn't fix, a calmer home screen only comes together with Simple view", () => {
    const r = recommend(rig(ALL_HIGH), { ...person, view: "complex" }, { now: NOW });
    for (const c of [r.configuration!, ...r.alternatives]) if (c.items.includes("density.calm")) expect(c.items).toContain("view.simple");
    const noSimple = recommend(rig({ ...ALL_HIGH, "view.simple": 0.1 }), { ...person, view: "complex" }, { now: NOW });
    expect(allSuggested(noSimple)).not.toContain("density.calm");
    expect(reasonOf(noSimple, "density.calm")).toBe("conflict");
  });
});

describe("feedback suppression", () => {
  const h = (item: ItemId, outcome: HistoryEntry["outcome"], daysAgo: number): HistoryEntry => ({ item, outcome, at: NOW - daysAgo * DAY });
  const run = (history: HistoryEntry[]) => recommend(rig(ALL_HIGH), { ...person, history }, { now: NOW });

  it("does not offer again something turned down or undone in the last 90 days", () => {
    const r = run([h("contrast.high", "rejected", 10), h("spacing.roomy", "reverted", 89)]);
    expect(reasonOf(r, "contrast.high")).toBe("rejected");
    expect(reasonOf(r, "spacing.roomy")).toBe("rejected");
    expect(allSuggested(r)).not.toContain("contrast.high");
  });

  it("may offer again after 90 days, but never after two turn-downs", () => {
    expect(reasonOf(run([h("contrast.high", "rejected", 120)]), "contrast.high")).toBeUndefined();
    expect(reasonOf(run([h("contrast.high", "rejected", 300), h("contrast.high", "rejected", 200)]), "contrast.high")).toBe("rejected");
  });

  it('"Not now" pauses an item for 7 days', () => {
    expect(reasonOf(run([h("contrast.high", "dismissed", 3)]), "contrast.high")).toBe("cooldown");
    expect(reasonOf(run([h("contrast.high", "dismissed", 8)]), "contrast.high")).toBeUndefined();
  });

  it("after 3 turn-downs in 30 days with nothing kept, only very confident suggestions are made, with a fatigue warning", () => {
    const tired = [h("textSize.150", "rejected", 20), h("targets.large", "rejected", 10), h("motion.reduced", "reverted", 2)];
    const probs = { ...Object.fromEntries(ITEM_IDS.map((id) => [id, 0.8])), "voiceFirst.on": 0.9 } as Record<ItemId, number>;
    const r = recommend(rig(probs), { ...person, history: tired }, { now: NOW });
    expect(r.warnings.map((w) => w.code)).toContain("fatigue");
    expect(r.configuration?.items).toEqual(["voiceFirst.on"]);
    expect(r.configuration!.confidence).toBeGreaterThanOrEqual(POLICY.fatigueFloor);
    expect(reasonOf(r, "contrast.high")).toBe("below_threshold");
    // Something kept in that time means no fatigue.
    const kept = recommend(rig(probs), { ...person, history: [...tired, h("homeFocus.chart", "accepted", 1)] }, { now: NOW });
    expect(kept.warnings.map((w) => w.code)).not.toContain("fatigue");
    expect(kept.configuration!.items.length).toBeGreaterThan(1);
  });
});

describe("thresholds, evidence and withheld reasons", () => {
  it("maps support to evidence levels", () => {
    expect(evidenceLevel(0)).toBe("insufficient");
    expect(evidenceLevel(14.9)).toBe("insufficient");
    expect(evidenceLevel(15)).toBe("limited");
    expect(evidenceLevel(50)).toBe("moderate");
    expect(evidenceLevel(150)).toBe("strong");
  });

  it("withholds items below their threshold or without one", () => {
    const m = rig({ ...ALL_HIGH, "contrast.high": 0.59 });
    m.thresholds[ITEM_IDS.indexOf("spacing.roomy")] = null;
    const r = recommend(m, person, { now: NOW });
    expect(reasonOf(r, "contrast.high")).toBe("below_threshold");
    expect(reasonOf(r, "spacing.roomy")).toBe("below_threshold");
  });

  it("withholds items with too little evidence and warns about limited evidence", () => {
    // Scale support so that no item has more than 30 similar people behind it: only 'limited' or 'insufficient'.
    const base = scoreItems(rig(ALL_HIGH, 0.6, 1), person);
    const maxSupport = Math.max(...base.map((s) => s.support));
    const m = rig(ALL_HIGH, 0.6, 30 / maxSupport);
    // And nobody at all for stronger contrast.
    const contrast = ITEM_IDS.indexOf("contrast.high");
    for (const row of m.collaborative.count) row[contrast] = 0;
    const r = recommend(m, person, { now: NOW });
    expect(r.scores.every((s) => s.evidence === "limited" || s.evidence === "insufficient")).toBe(true);
    expect(r.scores.find((s) => s.item === "contrast.high")!.support).toBe(0);
    expect(reasonOf(r, "contrast.high")).toBe("insufficient_evidence");
    for (const s of r.scores) if (s.evidence === "insufficient") expect(reasonOf(r, s.item)).toBe("insufficient_evidence");
    expect(r.status).toBe("ok");
    expect(r.configuration!.evidence).toBe("limited");
    expect(r.configuration!.items.every((id) => r.scores.find((s) => s.item === id)!.evidence === "limited")).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("limited_evidence");
  });

  it("warns about low confidence when the weakest item is below 0.7", () => {
    const probs = Object.fromEntries(ITEM_IDS.map((id) => [id, 0.65])) as Record<ItemId, number>;
    const r = recommend(rig(probs), person, { now: NOW });
    expect(r.status).toBe("ok");
    expect(r.warnings.map((w) => w.code)).toContain("low_confidence");
  });

  it("accounts for every item: suggested, withheld with a reason, or eligible above threshold", () => {
    const r = recommend(rig(ALL_HIGH), { ...person, explicit: ["textSize"], history: [{ item: "contrast.high", outcome: "rejected", at: NOW - DAY }] }, { now: NOW });
    const suggested = new Set(r.configuration!.items);
    const withheld = new Set(r.withheld.map((w) => w.item));
    for (const id of ITEM_IDS) {
      if (suggested.has(id) || withheld.has(id)) continue;
      const s = r.scores.find((x) => x.item === id)!;
      expect(s.probability).toBeGreaterThanOrEqual(0.6);
    }
    for (const id of suggested) expect(withheld.has(id)).toBe(false);
    expect(r.scores.every((s) => !r.withheld.some((w) => w.item === s.item && ["explicit", "already_on", "rejected", "cooldown"].includes(w.reason)))).toBe(true);
  });
});

describe("configurations", () => {
  it("picks the compatible set with the largest total margin over thresholds, at most 4 items", () => {
    const r = recommend(rig(ALL_HIGH), person, { now: NOW });
    expect(r.configuration!.items.length).toBe(MAX_BUNDLE_SIZE);
    expect(isCompatible(r.configuration!.items)).toBe(true);
    expect(r.configuration!.confidence).toBe(Math.min(...r.configuration!.items.map((id) => r.scores.find((s) => s.item === id)!.probability)));
    expect(r.alternatives.length).toBeLessThanOrEqual(2);
    expect(r.alternatives.some((a) => a.items.length === 1)).toBe(true); // a "start small" option
  });

  it("honours options.alternatives", () => {
    expect(recommend(rig(ALL_HIGH), person, { now: NOW, alternatives: 0 }).alternatives).toEqual([]);
    expect(recommend(rig(ALL_HIGH), person, { now: NOW, alternatives: 4 }).alternatives.length).toBe(4);
  });

  it("every configuration and alternative is compatible and policy-safe, for many people and settings (property)", () => {
    const r0 = rng(99);
    const people = fixtureSplits().test.people;
    const m = rig(Object.fromEntries(ITEM_IDS.map((id) => [id, 0.6 + r0() * 0.35])) as Record<ItemId, number>);
    for (let k = 0; k < 300; k++) {
      const p = people[k % people.length].first;
      const explicit = DIMENSIONS.filter(() => r0() < 0.2) as Dimension[];
      const view = r0() < 0.5 ? "simple" : "complex";
      const input = { ...p, view, explicit } as RecommenderInput;
      for (const mm of [m, model]) {
        const r = recommend(mm, input, { now: NOW });
        for (const c of [r.configuration, ...r.alternatives]) {
          if (!c) continue;
          expect(isCompatible(c.items)).toBe(true);
          for (const id of c.items) {
            expect(explicit).not.toContain(CATALOG[id].dimension);
            expect(isActive(id, input.preferences, view)).toBe(false);
            if (view === "complex" && id === "density.calm") expect(c.items).toContain("view.simple");
          }
          for (const a of c.items) for (const b of c.items) if (a !== b) expect(conflicts(a, b)).toBe(false);
          expect(c.actions.length + (c.mode ? 1 : 0)).toBeGreaterThan(0);
        }
        const keys = [r.configuration, ...r.alternatives].filter(Boolean).map((c) => c!.items.join(","));
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });
});

describe("scoreItems", () => {
  it("scores all 16 items, best first, without eligibility filtering", () => {
    const s = scoreItems(model, { ...person, explicit: [...DIMENSIONS] });
    expect(s.map((x) => x.item).sort()).toEqual([...ITEM_IDS].sort());
    for (let i = 1; i < s.length; i++) expect(s[i - 1].probability).toBeGreaterThanOrEqual(s[i].probability);
    for (const x of s) for (const v of [x.probability, ...Object.values(x.components)]) expect(v > 0 && v < 1).toBe(true);
  });
});

describe("latency", () => {
  it("recommend() takes under 2 ms at the 95th percentile", () => {
    const people = fixtureSplits().test.people;
    recommend(model, people[0].first, { now: NOW });
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t = performance.now();
      recommend(model, people[i % people.length].first, { now: NOW });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(2);
  });
});
