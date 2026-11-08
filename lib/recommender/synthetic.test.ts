import { describe, expect, it } from "vitest";
import { CATALOG, DIMENSIONS, isActive, isCompatible, isItemId, ITEM_IDS } from "./catalog";
import { AGE_BANDS, isValidAnswers, QUESTIONS } from "./profile";
import { sanitize } from "../preferences/schema";
import {
  ageBandFor,
  eligibleItems,
  examplesFor,
  generateWorld,
  historyStats,
  isWarm,
  loggedFor,
  oracleTruth,
  PARAMS,
  splitPeople,
  TRAIT_LOADINGS,
  TRAITS,
  trueKeepProbability,
  trueUtility,
  warmPeople,
  type World,
} from "./synthetic";
import { isSignalId, SIGNAL_CAP } from "./types";

const small = { seed: 7, people: 300 };
const world: World = generateWorld({ seed: 20261108, people: 4000 });

describe("synthetic world: determinism", () => {
  it("is reproducible from its seed and changes with it", () => {
    const a = JSON.stringify(generateWorld(small));
    expect(JSON.stringify(generateWorld(small))).toBe(a);
    expect(JSON.stringify(generateWorld({ ...small, seed: 8 }))).not.toBe(a);
  }, 60_000);

  it("person i is the same whatever the world size (per-person random streams)", () => {
    const big = generateWorld({ ...small, people: 400 });
    const few = generateWorld({ ...small, people: 50 });
    for (let i = 0; i < 50; i++) expect(JSON.stringify(few.people[i])).toBe(JSON.stringify(big.people[i]));
  });

  it("trait loadings leave room for unique noise (every trait has unit variance)", () => {
    for (const t of TRAITS) expect(Object.values(TRAIT_LOADINGS[t]).reduce((s, l) => s + l * l, 0)).toBeLessThan(1);
  });
});

describe("synthetic world: schema validity", () => {
  it("every example's input passes the app's own validators and the product policy", () => {
    // Collect problems and assert once: thousands of expect() calls are slow on a busy machine.
    const problems: string[] = [];
    const bad = (cond: boolean, what: string, i: number) => {
      if (!cond && problems.length < 20) problems.push(`example ${i}: ${what}`);
    };
    const checkedInputs = new Map<object, ReturnType<typeof eligibleItems>>();
    world.logged.forEach((l, i) => {
      const e = l.example;
      bad(Object.keys(e).sort().join() === "input,item,label,source,subject,weight", "example keys", i);
      bad(isItemId(e.item), "item", i);
      bad(e.label === 0 || e.label === 1, "label", i);
      bad(e.weight === 1 && e.source === "synthetic", "weight/source", i);
      let eligible = checkedInputs.get(e.input);
      if (!eligible) {
        // Inputs are shared by every item of one suggestion: validate each snapshot once.
        const x = e.input;
        bad(Object.keys(x).sort().join() === "answers,explicit,history,preferences,signals,view", "input keys", i);
        bad(isValidAnswers(x.answers), "answers", i);
        bad(JSON.stringify(sanitize(x.preferences)) === JSON.stringify(x.preferences), "preferences", i);
        bad(x.view === "simple" || x.view === "complex", "view", i);
        bad(new Set(x.explicit).size === x.explicit.length && x.explicit.every((d) => (DIMENSIONS as readonly string[]).includes(d)), "explicit", i);
        for (const [k, v] of Object.entries(x.signals)) bad(isSignalId(k) && Number.isInteger(v) && v! >= 1 && v! <= SIGNAL_CAP, `signal ${k}`, i);
        for (const h of x.history) {
          bad(isItemId(h.item) && ["accepted", "rejected", "reverted", "dismissed"].includes(h.outcome), "history entry", i);
          // The input is the point-in-time snapshot: only answers given before this suggestion.
          bad(h.at < l.at, "history after the suggestion", i);
        }
        eligible = eligibleItems(x);
        checkedInputs.set(x, eligible);
      }
      // Never suggest something already in effect or on a dimension the person set themselves.
      bad(!isActive(e.item, e.input.preferences, e.input.view), "item already active", i);
      bad(!e.input.explicit.includes(CATALOG[e.item].dimension), "item on an explicit dimension", i);
      bad(eligible.includes(e.item), "item not eligible", i);
    });
    expect(problems).toEqual([]);
    expect(checkedInputs.size).toBeGreaterThan(1000);
  }, 60_000);

  it("every shown configuration is compatible and never repeats something turned down or undone", () => {
    for (const p of world.people) {
      for (const round of p.rounds) expect(isCompatible(round.items)).toBe(true);
      const seen = new Set<string>();
      for (const round of p.rounds) {
        for (const item of round.items) expect(seen.has(item)).toBe(false);
        const logged = loggedFor(world, [p.index]).filter((l) => l.at === round.at);
        for (const l of logged) if (l.outcome !== "kept") seen.add(l.example.item);
      }
    }
  }, 60_000);

  it("labels follow CONTRACT.md §8 exactly", () => {
    for (const l of world.logged) expect(l.example.label).toBe(l.outcome === "kept" && !l.ratedUnhelpful ? 1 : 0);
    // Dismissed rounds ("Not now") produce no example.
    for (const p of world.people) {
      const dismissedAt = new Set(p.rounds.filter((r) => r.outcome === "dismissed").map((r) => r.at));
      for (const l of loggedFor(world, [p.index])) expect(dismissedAt.has(l.at)).toBe(false);
    }
  });
});

describe("synthetic world: missingness, cold start and noise", () => {
  const n = world.people.length;
  const answered = world.people.map((p) => Object.keys(p.answers).length);

  it("about 20% of people answer nothing", () => {
    const share = answered.filter((a) => a === 0).length / n;
    expect(share).toBeGreaterThan(0.17);
    expect(share).toBeLessThan(0.23);
  });

  it("people who answer skip each question about 25-45% of the time, and each cold-start stratum is populated", () => {
    const answering = world.people.filter((p) => Object.keys(p.answers).length > 0);
    const skipRate = 1 - answering.reduce((s, p) => s + Object.keys(p.answers).length, 0) / (answering.length * QUESTIONS.length);
    expect(skipRate).toBeGreaterThan(0.25);
    expect(skipRate).toBeLessThan(0.5);
    expect(answered.filter((a) => a >= 1 && a <= 4).length / n).toBeGreaterThan(0.08);
    expect(answered.filter((a) => a >= 5).length / n).toBeGreaterThan(0.4);
  });

  it("about 10% of the given answers are inconsistent with the traits", () => {
    const given = answered.reduce((s, a) => s + a, 0);
    const share = world.people.reduce((s, p) => s + p.inconsistent.length, 0) / given;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.12);
  });

  it("label balance per item stays within sane bounds", () => {
    for (const id of ITEM_IDS) {
      const ex = world.examples.filter((e) => e.item === id);
      expect(ex.length, id).toBeGreaterThan(50);
      const rate = ex.reduce((s, e) => s + e.label, 0) / ex.length;
      expect(rate, id).toBeGreaterThan(0.03);
      expect(rate, id).toBeLessThan(0.7);
    }
  }, 60_000);

  it("models the gap between 'kept' and 'helped': some kept items hurt, and those are undone more often", () => {
    const kept = world.logged.filter((l) => l.outcome !== "rejected");
    const harmful = kept.filter((l) => l.utility <= 0);
    const helpful = kept.filter((l) => l.utility > 0);
    expect(harmful.length / kept.length).toBeGreaterThan(0.1);
    const undone = (xs: typeof kept) => xs.filter((l) => l.outcome === "reverted").length / xs.length;
    expect(undone(harmful)).toBeGreaterThan(2 * undone(helpful));
  });

  it("the logging policy is a biased mixture", () => {
    const policies = new Set(world.logged.map((l) => l.policy));
    expect([...policies].sort()).toEqual(["popularity", "rules", "uniform"]);
    const items = new Set(world.examples.map((e) => e.item));
    expect(items.size).toBe(ITEM_IDS.length);
  });
});

describe("synthetic world: ground truth", () => {
  it("the oracle lists only eligible items and marks relevance as keep > 0.5 and utility > 0", () => {
    for (const p of world.people.slice(0, 500)) {
      const truth = oracleTruth(p, p.evaluation.input);
      expect(truth.map((t) => t.item)).toEqual(eligibleItems(p.evaluation.input));
      for (const t of truth) {
        expect(t.relevant).toBe(t.keepProbability > 0.5 && t.utility > 0);
        expect(t.utility).toBeCloseTo(trueUtility(p, t.item, p.evaluation.input), 12);
        expect(t.keepProbability).toBeCloseTo(trueKeepProbability(p, t.item, p.evaluation.input), 12);
      }
    }
  });

  it("history statistics count rounds and fully turned-down rounds", () => {
    expect(
      historyStats([
        { item: "textSize.125", outcome: "rejected", at: 1 },
        { item: "density.calm", outcome: "rejected", at: 1 },
        { item: "contrast.high", outcome: "accepted", at: 2 },
        { item: "motion.reduced", outcome: "rejected", at: 2 },
        { item: "targets.large", outcome: "dismissed", at: 3 },
      ]),
    ).toEqual({ roundsSeen: 3, rejectedRounds: 1 });
  });
});

describe("synthetic world: research data never reaches a model", () => {
  it("no age band (key or value) appears in any input or training example", () => {
    const seen = new Set<object>();
    const bad = /"(ageBand|age|band|research|birthYear|gender|ethnicity)":/i;
    const values = AGE_BANDS.map((b) => `"${b}"`);
    const check = (v: object, what: string) => {
      if (seen.has(v)) return;
      seen.add(v);
      const json = JSON.stringify(v);
      expect(bad.test(json), what).toBe(false);
      for (const b of values) expect(json.includes(b), what).toBe(false);
    };
    for (const e of world.examples) {
      check(e.input, "input");
      expect(Object.keys(e).sort()).toEqual(["input", "item", "label", "source", "subject", "weight"]);
    }
    for (const p of world.people) check(p.evaluation.input, "evaluation");
    expect(seen.size).toBeGreaterThan(1000);
  }, 60_000);

  it("age band is derived downstream of the traits, with within-band spread far larger than between-band differences", () => {
    // Labels are a function of traits and logging only; ageBandFor reads traits and noise and nothing reads it back.
    for (const t of TRAITS) {
      const byBand = AGE_BANDS.map((b) => world.people.filter((p) => p.research.ageBand === b).map((p) => p.hidden.traits[t]));
      const means = byBand.map((xs) => xs.reduce((s, x) => s + x, 0) / xs.length);
      const sds = byBand.map((xs, i) => Math.sqrt(xs.reduce((s, x) => s + (x - means[i]) ** 2, 0) / xs.length));
      expect(Math.max(...means) - Math.min(...means), t).toBeLessThan(Math.min(...sds) / 2.5);
    }
    // The same traits always give the same band for the same noise (no hidden dependence on anything else).
    expect(ageBandFor(world.people[0].hidden.traits, 0)).toBe(ageBandFor({ ...world.people[0].hidden.traits }, 0));
    expect(PARAMS.age.cuts.length).toBe(AGE_BANDS.length - 1);
  }, 60_000);

  it("label rates barely differ by age band (no direct dependence)", () => {
    const rates = AGE_BANDS.map((b) => {
      const ids = world.people.filter((p) => p.research.ageBand === b).map((p) => p.index);
      const ex = examplesFor(world, ids);
      return ex.reduce((s, e) => s + e.label, 0) / ex.length;
    });
    expect(Math.max(...rates) - Math.min(...rates)).toBeLessThan(0.06);
  }, 60_000);
});

describe("synthetic world: splits", () => {
  const split = splitPeople(world.people.length, 20261108);

  it("is 60/20/20 by person, disjoint and complete", () => {
    expect(split.train.length).toBe(2400);
    expect(split.validation.length).toBe(800);
    expect(split.test.length).toBe(800);
    const all = [...split.train, ...split.validation, ...split.test];
    expect(new Set(all).size).toBe(world.people.length);
  });

  it("no subject appears in two splits' examples", () => {
    const subjects = (ids: number[]) => new Set(examplesFor(world, ids).map((e) => e.subject));
    const [a, b, c] = [subjects(split.train), subjects(split.validation), subjects(split.test)];
    for (const s of a) expect(b.has(s) || c.has(s)).toBe(false);
    for (const s of b) expect(c.has(s)).toBe(false);
  }, 60_000);

  it("the warm variant keeps only people and examples with earlier rounds", () => {
    const warm = warmPeople(world, split.test);
    expect(warm.length).toBeGreaterThan(0.4 * split.test.length);
    expect(warm.length).toBeLessThan(split.test.length);
    for (const i of warm) expect(world.people[i].evaluation.round).toBeGreaterThan(0);
    const ex = examplesFor(world, split.test);
    expect(ex.filter(isWarm).every((e) => e.input.history.length > 0)).toBe(true);
    expect(ex.filter(isWarm).length).toBeGreaterThan(0);
  });
});
