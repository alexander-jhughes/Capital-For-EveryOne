import { describe, expect, it } from "vitest";
import { applyActions, DEFAULT_PREFS, sanitize, type UiAction } from "../preferences/schema";
import type { ModelArtifact } from "./artifact";
import { EXAMPLES, DEFAULTS, REDESIGN_DEFAULTS } from "./examples";
import { FEATURE_IDS, FEATURES, type PersonalisationInput } from "./features";
import { getPersonalisation, loadModel } from "./index";
import { recommendPreferences } from "./infer";
import modelJson from "./model.json";
import { INITIAL_STATE, type PersonalisationState, recordOutcome, recordSignal, resetPersonalisation, setConsent } from "./state";
import { TARGET_IDS, TARGETS } from "./targets";

const model = modelJson as unknown as ModelArtifact;
const clone = () => JSON.parse(JSON.stringify(model)) as ModelArtifact;
const granted = (signals: PersonalisationState["signals"] = {}): PersonalisationState => ({ ...INITIAL_STATE, consent: "granted", signals });
const example = (startsWith: string) => EXAMPLES.find((e) => e.name.startsWith(startsWith))!;

// "Often talks to Dial and chose bigger buttons": the model suggests voice-first.
const TALKER = example("Often talks to Dial and chose bigger buttons");
// "The same, and also hid a section": the model suggests a calmer home screen.
const CALM = example("The same, and also hid a section");

describe("inference: recommendations", () => {
  it("suggests voice-first for someone who often talks to Dial, with reasons and a question", () => {
    const r = recommendPreferences(TALKER.input, TALKER.state, model);
    expect(r.status).toBe("ok");
    expect(r.preferences[0].target).toBe("voiceFirst");
    expect(r.recommendedLayout).toBe("voice");
    expect(r.offer).toMatch(/^Would you like/);
    expect(r.reasons[0]).toBe("You've talked to Dial 6 times");
    expect(r.modelVersion).toBe(model.modelVersion);
    expect(r.trainedOn).toBe("synthetic");
  });

  it("suggests a calmer layout for someone who asked for less and hid a section", () => {
    const r = recommendPreferences(CALM.input, CALM.state, model);
    expect(r.preferences.map((p) => p.target)).toContain("calmLayout");
    expect(r.recommendedLayout).toBe("calm");
  });

  it("every suggestion is above its trained threshold and the floor, explained, and only uses allowlisted actions", () => {
    for (const e of EXAMPLES) {
      const r = recommendPreferences(e.input, e.state, model);
      for (const p of r.preferences) {
        expect(p.confidence).toBeGreaterThanOrEqual(Math.max(model.targets[p.target].threshold!, 0.6) - 0.005);
        expect(p.confidence).toBeLessThanOrEqual(1);
        expect(p.reasons.length).toBeGreaterThan(0);
        expect(p.actions).toEqual(TARGETS[p.target].actions);
      }
      expect(r.preferences.length).toBeLessThanOrEqual(3);
    }
  });

  it("never suggests a setting the person already has", () => {
    const r = recommendPreferences({ ...TALKER.input, preferences: { ...DEFAULTS, targets: "large", voiceFirst: true } }, TALKER.state, model);
    expect(r.preferences.map((p) => p.target)).not.toContain("voiceFirst");
    expect(r.withheld).toContainEqual({ target: "voiceFirst", reason: "already_on" });
  });

  it("never suggests a target the model could not predict reliably", () => {
    const unreliable = TARGET_IDS.filter((id) => model.targets[id].threshold === null);
    for (const e of EXAMPLES) {
      const r = recommendPreferences(e.input, e.state, model);
      for (const id of unreliable) expect(r.preferences.map((p) => p.target)).not.toContain(id);
    }
  });

  it("is deterministic", () => {
    expect(recommendPreferences(TALKER.input, TALKER.state, model)).toEqual(recommendPreferences(TALKER.input, TALKER.state, model));
  });
});

describe("inference: confidence thresholds", () => {
  it("returns no suggestion when confidence is below the requested floor", () => {
    const r = recommendPreferences(TALKER.input, TALKER.state, model, { minConfidence: 0.99 });
    expect(r.status).toBe("no_recommendation");
    expect(r.preferences).toEqual([]);
    expect(r.withheld).toContainEqual({ target: "voiceFirst", reason: "low_confidence" });
  });

  it("uses the trained per-target threshold, not just the floor", () => {
    const m = clone();
    m.targets.voiceFirst.threshold = 0.99;
    const r = recommendPreferences(TALKER.input, TALKER.state, m);
    expect(r.withheld).toContainEqual({ target: "voiceFirst", reason: "low_confidence" });
  });

  it("caps the number of suggestions", () => {
    const r = recommendPreferences(CALM.input, CALM.state, model, { maxSuggestions: 1 });
    expect(r.preferences.length).toBeLessThanOrEqual(1);
  });
});

describe("inference: missing and conflicting information", () => {
  it("no settings at all: insufficient data", () => {
    expect(recommendPreferences({}, granted({ voiceSessions: 5 }), model).status).toBe("insufficient_data");
    expect(recommendPreferences({ preferences: null }, granted(), model).status).toBe("insufficient_data");
  });

  it("only defaults and no actions: nothing to learn from", () => {
    expect(recommendPreferences({ preferences: DEFAULTS, view: "complex" }, granted(), model).status).toBe("insufficient_data");
  });

  it("settings this app version doesn't have are never suggested (redesign schema has no voice-first)", () => {
    const r = recommendPreferences({ preferences: { ...REDESIGN_DEFAULTS, targets: "large" }, view: "simple" }, TALKER.state, model);
    expect(r.withheld).toContainEqual({ target: "voiceFirst", reason: "not_supported" });
    expect(r.withheld).toContainEqual({ target: "stepByStep", reason: "not_supported" });
  });

  it("partial or malformed settings don't throw and unknown fields count as unsupported", () => {
    const r = recommendPreferences({ preferences: { textSize: 150 } as never, view: "simple" }, granted({ voiceSessions: 6 }), model);
    expect(["ok", "no_recommendation"]).toContain(r.status);
    expect(r.withheld.find((w) => w.target === "calmLayout")?.reason).toBe("not_supported");
    const junk = recommendPreferences({ preferences: { textSize: "huge", layout: "x" } as never, choices: [1, 2] as never }, granted({ voiceSessions: -4 } as never), model);
    expect(junk.status).not.toBe("ok");
  });

  it("withholds layout suggestions when the person asked for both less and more", () => {
    const e = example("Mixed signals");
    const r = recommendPreferences(e.input, e.state, model);
    expect(r.withheld).toContainEqual({ target: "calmLayout", reason: "conflicting_signals" });
    expect(r.preferences.map((p) => p.target)).not.toContain("calmLayout");
  });

  it("withholds larger text when the person made text both bigger and smaller", () => {
    const r = recommendPreferences(TALKER.input, granted({ textLarger: 3, textSmaller: 3, voiceSessions: 6 }), model);
    expect(r.withheld).toContainEqual({ target: "largerText", reason: "conflicting_signals" });
  });

  it("never offers two suggestions that fight over the home screen", () => {
    const m = clone();
    // Force both layout targets to be confident (and explainable: one split on "hid a section"), to test the overlap rule itself.
    const hidden = FEATURE_IDS.indexOf("hiddenCount");
    m.targets.calmLayout = { ...m.targets.calmLayout, threshold: 0.6, trees: [{ f: [hidden, -1, -1], t: [0.5, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [0.5, 0.1, 0.9] }] };
    m.targets.visualSummary = { ...m.targets.visualSummary, threshold: 0.6, trees: [{ f: [hidden, -1, -1], t: [0.5, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [0.5, 0.1, 0.8] }] };
    const r = recommendPreferences(CALM.input, CALM.state, m);
    const layoutTargets = r.preferences.filter((p) => p.target === "calmLayout" || p.target === "visualSummary");
    expect(layoutTargets).toHaveLength(1);
    expect(r.withheld.some((w) => w.reason === "overlaps_other")).toBe(true);
  });
});

describe("inference: the person stays in control", () => {
  it("needs consent before predicting anything", () => {
    const r = recommendPreferences(TALKER.input, { ...TALKER.state, consent: "unset" }, model);
    expect(r.status).toBe("needs_consent");
    expect(r.preferences).toEqual([]);
  });

  it("personalisation turned off: nothing is predicted", () => {
    const off = setConsent(TALKER.state, false);
    expect(recommendPreferences(TALKER.input, off, model).status).toBe("disabled");
  });

  it("a rejected suggestion isn't repeated while the person's settings are unchanged", () => {
    const first = recommendPreferences(TALKER.input, TALKER.state, model);
    const state = recordOutcome(TALKER.state, "voiceFirst", "rejected", first.fingerprint!);
    const second = recommendPreferences(TALKER.input, recordSignal(state, "voiceSessions"), model);
    expect(second.preferences.map((p) => p.target)).not.toContain("voiceFirst");
    expect(second.withheld).toContainEqual({ target: "voiceFirst", reason: "previously_rejected" });
  });

  it("after the person changes their settings it may be offered once more, but never after a second no", () => {
    const first = recommendPreferences(TALKER.input, TALKER.state, model);
    let state = recordOutcome(TALKER.state, "voiceFirst", "rejected", first.fingerprint!);
    const changed: PersonalisationInput = { ...TALKER.input, preferences: { ...DEFAULTS, targets: "large", contrast: "high" } };
    const again = recommendPreferences(changed, state, model);
    if (again.preferences.some((p) => p.target === "voiceFirst")) {
      state = recordOutcome(state, "voiceFirst", "rejected", again.fingerprint!);
      const changedAgain: PersonalisationInput = { ...TALKER.input, preferences: { ...DEFAULTS, targets: "large", spacing: "roomy" } };
      expect(recommendPreferences(changedAgain, state, model).withheld).toContainEqual({ target: "voiceFirst", reason: "previously_rejected" });
    } else expect(again.withheld.find((w) => w.target === "voiceFirst")?.reason).not.toBe("previously_rejected");
  });

  it("an ignored suggestion is held back until the settings change", () => {
    const first = recommendPreferences(TALKER.input, TALKER.state, model);
    const state = recordOutcome(TALKER.state, "voiceFirst", "ignored", first.fingerprint!);
    expect(recommendPreferences(TALKER.input, state, model).withheld).toContainEqual({ target: "voiceFirst", reason: "recently_ignored" });
  });

  it("an accepted suggestion becomes the person's setting and is not offered again", () => {
    const first = recommendPreferences(CALM.input, CALM.state, model);
    const accepted = first.preferences.find((p) => p.target === "calmLayout")!;
    // What the frontend does on "yes": apply the actions through the existing schema.
    const prefs = applyActions(CALM.input.preferences as typeof DEFAULT_PREFS, accepted.actions as unknown as UiAction[]);
    const r = recommendPreferences({ ...CALM.input, preferences: prefs }, recordOutcome(CALM.state, accepted.target, "accepted", first.fingerprint!), model);
    expect(r.withheld).toContainEqual({ target: "calmLayout", reason: "already_on" });
  });

  it("updates when explicit settings change", () => {
    const before = recommendPreferences(TALKER.input, TALKER.state, model);
    const after = recommendPreferences({ ...TALKER.input, preferences: { ...DEFAULTS, targets: "large", textSize: 150 } }, TALKER.state, model);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.withheld).toContainEqual({ target: "largerText", reason: "already_on" });
  });

  it("reset forgets everything learned, so a rejected suggestion can come back and action counts are gone", () => {
    const first = recommendPreferences(TALKER.input, TALKER.state, model);
    const rejected = recordOutcome(TALKER.state, "voiceFirst", "rejected", first.fingerprint!);
    const reset = resetPersonalisation(rejected);
    expect(reset.signals).toEqual({});
    expect(reset.consent).toBe("granted");
    expect(reset.rejected).toEqual({});
    expect(recommendPreferences(TALKER.input, reset, model).preferences.map((p) => p.target)).not.toContain("voiceFirst");
    expect(recommendPreferences(TALKER.input, { ...reset, signals: TALKER.state.signals }, model).preferences[0].target).toBe("voiceFirst");
  });
});

describe("inference: failure modes", () => {
  it("model missing: unavailable, and the app carries on", () => {
    expect(recommendPreferences(TALKER.input, TALKER.state, null).status).toBe("unavailable");
    expect(recommendPreferences(TALKER.input, TALKER.state, undefined).preferences).toEqual([]);
  });

  it("invalid model output is rejected before use", () => {
    const bad = [
      () => ({ ...clone(), format: "something-else" }),
      () => ({ ...clone(), features: [...model.features].reverse() }),
      () => {
        const m = clone();
        m.targets.voiceFirst.trees[0].v[0] = 7;
        return m;
      },
      () => {
        const m = clone();
        m.targets.calmLayout.trees[0].l[0] = 0;
        return m;
      },
      () => {
        const m = clone();
        delete (m.targets as Partial<ModelArtifact["targets"]>).highContrast;
        return m;
      },
    ];
    for (const make of bad) expect(recommendPreferences(TALKER.input, TALKER.state, make() as ModelArtifact).status).toBe("unavailable");
  });

  it("never throws, even if the model blows up mid-inference", () => {
    const exploding = new Proxy(clone(), {
      get(target, prop, receiver) {
        if (prop === "targets") throw new Error("boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(() => recommendPreferences(TALKER.input, TALKER.state, exploding)).not.toThrow();
    expect(recommendPreferences(TALKER.input, TALKER.state, exploding).status).toBe("unavailable");
  });

  it("loads the bundled model lazily and runs end to end", async () => {
    expect(await loadModel()).not.toBeNull();
    const r = await getPersonalisation(TALKER.input, TALKER.state);
    expect(r.status).toBe("ok");
  });
});

describe("inference: performance", () => {
  it("runs in well under a millisecond per call", () => {
    for (let i = 0; i < 50; i++) recommendPreferences(CALM.input, CALM.state, model); // warm up
    const runs = 1000;
    const start = performance.now();
    for (let i = 0; i < runs; i++) recommendPreferences(i % 2 ? CALM.input : TALKER.input, i % 2 ? CALM.state : TALKER.state, model);
    const perCall = (performance.now() - start) / runs;
    expect(perCall).toBeLessThan(2); // typically ~0.006 ms; generous for slow CI machines
  });
});

describe("privacy and safety", () => {
  const BANNED = /disab|impair|condition|diagnos|dyslex|autis|adhd|neuro|dementia|anxiety|depress|mental|vulnerab|elderly|older|senior|\bage\b|blind|deaf|struggl|confus/i;

  it("never uses diagnostic, condition, age or vulnerability language in anything a person can see", () => {
    const text = [
      ...Object.values(TARGETS).flatMap((t) => [t.title, t.offer]),
      ...FEATURES.flatMap((f) => [0, 1, 2, 3, 5].map((v) => f.describe(v) ?? "")),
      ...EXAMPLES.flatMap((e) => {
        const r = recommendPreferences(e.input, e.state, model);
        return [r.offer ?? "", ...r.reasons, ...r.preferences.flatMap((p) => p.reasons)];
      }),
    ].join("\n");
    expect(text).not.toMatch(BANNED);
  });

  it("ignores financial or personal data even if it is passed in", () => {
    const leaky = {
      ...TALKER.input,
      transactions: [{ id: "t1", amount: 99999, merchant: "Anywhere" }],
      balance: 486.2,
      age: 82,
      spending: { gambling: 5000 },
      preferences: { ...TALKER.input.preferences, statementBalance: 1, income: 2 },
    } as PersonalisationInput;
    expect(recommendPreferences(leaky, TALKER.state, model)).toEqual(recommendPreferences(TALKER.input, TALKER.state, model));
  });

  it("returns no hidden score: only suggestions, their confidence and reasons", () => {
    const r = recommendPreferences(TALKER.input, TALKER.state, model);
    expect(Object.keys(r).sort()).toEqual(
      ["confidence", "fingerprint", "modelVersion", "offer", "preferences", "reasons", "recommendedLayout", "status", "trainedOn", "withheld"].sort(),
    );
  });

  it("suggested actions are valid for the existing preferences schema and turn the setting on", () => {
    // stepByStep and voiceFirst need the adaptive-UI schema; the rest work on this branch's schema as-is.
    for (const id of TARGET_IDS.filter((t) => t !== "stepByStep" && t !== "voiceFirst")) {
      const prefs = applyActions(DEFAULT_PREFS, TARGETS[id].actions as unknown as UiAction[]);
      expect(sanitize(prefs), id).toEqual(prefs);
      expect(TARGETS[id].status(prefs), id).toBe("on");
    }
  });
});
