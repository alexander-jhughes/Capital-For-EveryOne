// lib/access without the model: routing, scope, merging, validation and the index file. A fake embedding (one
// dimension per label) makes the maths exact, so these tests pin the logic, not the model.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStep } from "../dial/registry";
import { toSteps } from "../ai/command-model";
import { applyActions, DEFAULT_PREFS, effectivePrefs, nightList } from "../preferences/schema";
import { SITUATION_IDS, SITUATIONS, NOT_A_SITUATION } from "./catalogue";
import { decodeIndex, encodeIndex, examplesHash } from "./index-codec";
import { decide, worthUnderstanding } from "./route";
import { changesFor, clauses, detectScope, exampleList, judge, NEGATED, planKeep, scopeFor, THRESHOLDS, type Label } from "./understand";

describe("the catalogue", () => {
  it("has every situation once, with examples, changes and reasons", () => {
    expect(SITUATIONS.map((s) => s.id)).toEqual([...SITUATION_IDS]);
    for (const s of SITUATIONS) {
      expect(s.examples.length, s.id).toBeGreaterThanOrEqual(10);
      expect(s.changes.length, s.id).toBeGreaterThanOrEqual(2);
      for (const c of s.changes) expect(c.why.length, `${s.id} ${c.action.type}`).toBeGreaterThan(10);
    }
  });

  it("only uses changes the settings schema accepts", () => {
    for (const s of SITUATIONS) expect(validateStep({ type: "preferences", actions: s.changes.map((c) => c.action) }), s.id).not.toBeNull();
  });

  it("never repeats an example, and never uses a money or command example as a situation", () => {
    const all = exampleList().map((e) => e.text.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
    expect(NOT_A_SITUATION.money.length + NOT_A_SITUATION.command.length).toBeGreaterThanOrEqual(30);
  });

  it("no change is about money: Dial never pays, moves money or turns Spend Pause off from a situation", () => {
    for (const s of SITUATIONS) for (const c of s.changes) expect(["preferences"].includes("preferences") && !/pay|pause|budget/i.test(c.action.type)).toBe(true);
  });
});

describe("scope: when a change applies", () => {
  it.each([
    ["I have trouble seeing at night", "night"],
    ["my eyes hurt in the evenings", "night"],
    ["the app is too bright in bed", "night"],
    ["I'm outside in the sun", "now"],
    ["I'm on the bus, one hand", "now"],
    ["please do this from now on", "always"],
    ["I have dyslexia", null],
  ])("%s -> %s", (text, scope) => expect(detectScope(text)).toBe(scope));

  it("falls back to the situation's usual scope", () => {
    expect(scopeFor("my night vision is poor", ["night_vision"])).toBe("night");
    expect(scopeFor("glare", ["bright_light"])).toBe("now");
    expect(scopeFor("I have dyslexia", ["reading"])).toBe("always");
  });
});

describe("clauses and negation", () => {
  it("judges each part of a sentence on its own", () => {
    expect(clauses("I have arthritis and I can't see at night")).toEqual(["I have arthritis", "I can't see at night"]);
    expect(clauses("I'm deaf, and also colour blind")).toEqual(["I'm deaf", "colour blind"]);
    expect(clauses("hello")).toEqual(["hello"]);
  });

  it("treats a denial of a named condition as not a situation, and nothing else", () => {
    for (const t of ["i'm not colour blind", "i don't have dyslexia", "i am not deaf", "i'm no longer blind"]) expect(NEGATED.test(t), t).toBe(true);
    for (const t of ["i can't see at night", "i'm not fluent in english", "english isn't my first language", "i don't hear well"]) expect(NEGATED.test(t), t).toBe(false);
  });
});

describe("judge: when a sentence counts as a situation", () => {
  const scores = (...s: [Label, number][]) => s.map(([label, score]) => ({ label, score }));
  it("accepts a clear, close match", () => {
    expect(judge(scores(["reading", 0.7], ["none:money", 0.3]))).toMatchObject({ accepted: true, maybe: false });
  });
  it("is only 'maybe' when it is close but not clear", () => {
    expect(judge(scores(["reading", 0.45], ["none:money", 0.38]))).toMatchObject({ accepted: false, maybe: true });
  });
  it("never accepts when a money question or command is the closest", () => {
    expect(judge(scores(["none:money", 0.8], ["reading", 0.79]))).toMatchObject({ accepted: false, maybe: false });
  });
  it("never accepts a situation that is too close to a money question", () => {
    expect(judge(scores(["low_vision", 0.66], ["none:money", 0.62]))).toMatchObject({ accepted: false });
  });
  it("uses the documented thresholds", () => {
    expect(THRESHOLDS.accept).toBeGreaterThan(THRESHOLDS.maybe);
    expect(THRESHOLDS.margin).toBeGreaterThan(THRESHOLDS.maybeMargin);
  });
});

describe("route: rules first for commands and money", () => {
  const sure = (situations: (typeof SITUATION_IDS)[number][]) => ({ kind: "situations" as const, situations, scope: "always" as const, scores: {}, confidence: "sure" as const });
  it("skips the model for control words, pages, view changes and money questions", () => {
    for (const t of ["undo", "go to settings", "switch to simple view", "how much did I spend at night?", "read it out loud"]) expect(worthUnderstanding(t), t).toBe(false);
    for (const t of ["I have trouble seeing at night", "my hands shake", "I'm colour blind"]) expect(worthUnderstanding(t), t).toBe(true);
  });
  it("leaves money remarks to the money code, but not money worries", () => {
    expect(decide("my balance is giving me a headache", sure(["light_sensitivity"]))).toBe("rules");
    expect(decide("checking my balance gives me anxiety", sure(["money_worry"]))).toBe("adapt");
  });
  it("leaves direct commands to the precise rules", () => {
    expect(decide("make the writing larger", sure(["low_vision"]))).toBe("rules");
    expect(decide("I can't read the small writing", sure(["low_vision"]))).toBe("adapt");
  });
});

describe("changes and how they are kept", () => {
  it("merges situations in order, one change per setting, first heard wins", () => {
    const c = changesFor(["night_vision", "bright_light"]);
    expect(c.filter((x) => x.action.type === "theme")).toEqual([expect.objectContaining({ action: { type: "theme", value: "dark" } })]);
  });
  it("at night, the look becomes the night look and the rest is kept all day", () => {
    const k = planKeep(changesFor(["night_vision", "dexterity"]), "night");
    expect(k.night.map((a) => a.type).sort()).toEqual(["contrast", "spacing", "targets", "textSize", "theme"]);
    expect(k.now.map((a) => a.type).sort()).toEqual(["tapGuard", "voiceFirst"]);
  });
  it("the night look only applies between 7pm and 7am", () => {
    const p = applyActions(DEFAULT_PREFS, [{ type: "nightLook", actions: planKeep(changesFor(["night_vision"]), "night").night }]);
    expect(effectivePrefs(p, 12).theme).toBe("system");
    expect(effectivePrefs(p, 21)).toMatchObject({ theme: "dark", contrast: "high", textSize: 150 });
    expect(effectivePrefs(p, 6).theme).toBe("dark");
    expect(effectivePrefs(p, 7).theme).toBe("system");
  });
  it("a night look from a cookie keeps only allowed visual settings", () => {
    expect(nightList([{ type: "theme", value: "dark" }, { type: "autoRead", value: true }, { type: "textSize", value: 999 }, "x", null])).toEqual([{ type: "theme", value: "dark" }]);
  });
});

describe("validateStep: adapt", () => {
  it("accepts known situations and scopes only", () => {
    expect(validateStep({ type: "adapt", situations: ["reading"], scope: "always" })).toEqual({ type: "adapt", situations: ["reading"], scope: "always" });
    expect(validateStep({ type: "adapt", situations: ["reading", "focus"], scope: "night", tentative: true, cloud: true })).not.toBeNull();
    for (const bad of [
      { type: "adapt", situations: [], scope: "always" },
      { type: "adapt", situations: ["telepathy"], scope: "always" },
      { type: "adapt", situations: ["reading", "reading"], scope: "always" },
      { type: "adapt", situations: ["reading"], scope: "forever" },
      { type: "adapt", situations: ["reading"], scope: "always", actions: [{ type: "theme", value: "dark" }] },
      { type: "adapt", situations: ["reading", "focus", "memory", "hearing"], scope: "always" },
    ])
      expect(validateStep(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the cloud model may only name a situation", () => {
  const screen = { route: "/account", mode: "simple" as const, textSize: 100 as const };
  it("turns a named situation into an adapt step marked as cloud", () => {
    expect(toSteps([{ do: "situation", situation: "dexterity", scope: "always" }], screen)).toEqual([{ type: "adapt", situations: ["dexterity"], scope: "always", cloud: true }]);
  });
  it("uses the situation's own scope when none is given, and drops unknown situations", () => {
    expect(toSteps([{ do: "situation", situation: "night_vision" }], screen)).toEqual([{ type: "adapt", situations: ["night_vision"], scope: "night", cloud: true }]);
    expect(toSteps([{ do: "situation", situation: "pay_my_bill" }], screen)).toEqual([]);
  });
  it("accepts the new display settings as direct commands", () => {
    expect(toSteps([{ do: "display", setting: "voiceRate", value: "slow" }], screen)).toEqual([{ type: "preferences", actions: [{ type: "voiceRate", value: "slow" }] }]);
    expect(toSteps([{ do: "display", setting: "colours", value: "rainbow" }], screen)).toEqual([]);
  });
});

describe("the precomputed index", () => {
  it("round-trips through the file format", () => {
    const v = (a: number[]) => {
      const f = new Float32Array(a);
      const n = Math.hypot(...a);
      return f.map((x) => x / n);
    };
    const list = exampleList();
    const index = { labels: list.map((e) => e.label), vectors: list.map((_, i) => v([1, (i % 7) / 7, 0.5])) };
    const back = decodeIndex(JSON.parse(JSON.stringify(encodeIndex(index))))!;
    expect(back.labels).toEqual(index.labels);
    back.vectors.forEach((x, i) => x.forEach((y, j) => expect(y).toBeCloseTo(index.vectors[i][j], 1)));
  });
  it("rejects a file for another example list or model", () => {
    expect(decodeIndex({ version: 1, model: "other", hash: examplesHash(), dims: 1, labels: [], vectors: "" })).toBeNull();
    expect(decodeIndex({ version: 1, model: "all-MiniLM-L6-v2", hash: "00000000", dims: 1, labels: [], vectors: "" })).toBeNull();
    expect(decodeIndex(null)).toBeNull();
  });
  it("the committed index matches the catalogue (run npm run access:index after editing it)", () => {
    const file = JSON.parse(readFileSync(new URL("../../public/models/access-index.json", import.meta.url), "utf8"));
    expect(file.hash).toBe(examplesHash());
    expect(decodeIndex(file)?.labels.length).toBe(exampleList().length);
  });
});
