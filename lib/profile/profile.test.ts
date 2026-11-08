import { describe, expect, it } from "vitest";
import { HELP_ANSWER, SIGNPOST_SENTENCE } from "../ai/answer-style";
import { DRIVER_HEADINGS, FREE_HELP, isSensitive, NEED_IDS, NEEDS, PERSON_TYPE_COPY, PERSON_TYPES } from "./catalog";
import { emptyUsage, FEATURE_NAMES, FEATURE_REASONS, featureVector, type ProfileInputs } from "./features";
import { adaptationsFor, CARD_IDS, inferProfile } from "./infer";
import { checkModel, profileModel } from "./model";
import { contributions, predictProba, softmax } from "./softmax";
import { generateDataset } from "./synthetic";
import { DEFAULT_CONFIG, trainModel } from "./train";

const model = profileModel()!;
const base: ProfileInputs = { utilisation: 0.71, payments: [], goalKinds: [], spendPauseOn: false, simpleView: false, needs: [], usage: emptyUsage() };
const run = (over: Partial<ProfileInputs>, chosen: Parameters<typeof inferProfile>[2] = null) => inferProfile(model, { ...base, ...over }, chosen);

describe("the committed model", () => {
  it("matches this code's features and types", () => {
    expect(model).not.toBeNull();
    expect(model.classes).toEqual([...PERSON_TYPES]);
    expect(model.features).toEqual([...FEATURE_NAMES]);
    expect(model.threshold).toBeGreaterThan(0.3);
  });

  it("refuses a file that doesn't match", () => {
    expect(checkModel({ ...model, features: model.features.slice(1) })).toBeNull();
    expect(checkModel({ ...model, weights: model.weights.map((w) => w.map(() => Number.NaN)) })).toBeNull();
    expect(checkModel({ ...model, threshold: 1 })).toBeNull();
    expect(checkModel(null)).toBeNull();
  });
});

describe("training", () => {
  // A smaller run than the committed one, so the test is quick; the committed model is checked by scripts/profile/train.ts --check.
  const small = { ...DEFAULT_CONFIG, train: 1500, validation: 500, test: 800, epochs: 400 };
  const { model: trained, report } = trainModel(small);

  it("is deterministic", () => {
    expect(JSON.stringify(trainModel(small).model)).toBe(JSON.stringify(trained));
  });

  it("beats the hand-written rules and the majority class on held-out data", () => {
    expect(report.test.accuracy).toBeGreaterThan(report.baselines.rules.accuracy + 0.1);
    expect(report.test.macroF1).toBeGreaterThan(report.baselines.rules.macroF1 + 0.1);
    expect(report.test.accuracy).toBeGreaterThan(report.baselines.majority.accuracy * 3);
    expect(report.test.logLoss).toBeLessThan(report.baselines.rules.logLoss);
  });

  it("doesn't overfit: train and test accuracy are close", () => {
    expect(Math.abs(report.train.accuracy - report.test.accuracy)).toBeLessThan(0.05);
  });

  it("is more accurate above the threshold than overall", () => {
    expect(report.test.confidentAccuracy).toBeGreaterThan(report.test.accuracy);
    expect(report.test.coverage).toBeLessThan(1);
  });

  it("synthetic data never carries an amount, and health needs only come with consent behaviour built in", () => {
    for (const p of generateDataset(300, 1)) {
      expect(Object.keys(p.input).sort()).toEqual(Object.keys(base).sort());
      expect(p.input.needs.every((n) => NEED_IDS.includes(n))).toBe(true);
    }
  });
});

describe("softmax maths", () => {
  it("probabilities sum to 1 and survive large logits", () => {
    const p = softmax([1000, 1001, 999]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(p.every(Number.isFinite)).toBe(true);
  });

  it("contributions explain the gap between a class and the average class", () => {
    const x = featureVector({ ...base, needs: ["money_tight"] });
    const c = PERSON_TYPES.indexOf("stretched");
    const total = contributions(model, x, c).reduce((a, b) => a + b, 0);
    const z = model.weights.map((w, k) => w.reduce((s, v, j) => s + v * x[j], model.bias[k]));
    const meanBias = model.bias.reduce((a, b) => a + b, 0) / model.bias.length;
    const meanZ = z.reduce((a, b) => a + b, 0) / z.length;
    expect(total).toBeCloseTo(z[c] - meanZ - (model.bias[c] - meanBias), 6);
  });
});

describe("features are an allowlist", () => {
  it("every feature is between 0 and 1", () => {
    const x = featureVector({ ...base, utilisation: 3, usage: { dial: 99, learn: -4, whatIf: 10, goals: Number.NaN, detailed: 1 } });
    expect(x).toHaveLength(FEATURE_NAMES.length);
    expect(x.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it("extra fields such as amounts, merchants or questions can't change the result", () => {
    const plain = featureVector(base);
    const noisy = featureVector({ ...base, balance: 999999, merchant: "Tesco", question: "how much?", transactions: [{ amount: 5 }] } as ProfileInputs);
    expect(noisy).toEqual(plain);
  });
});

describe("inferProfile", () => {
  it("reads someone who says money is tight and they're behind on bills", () => {
    const r = run({ needs: ["money_tight", "behind_bills"] });
    expect(r.type).toBe("stretched");
    expect(r.source).toBe("model");
    expect(r.reasons).toContain("You told us: money is tight right now");
    expect(r.reasons).toContain("You told us: I'm behind on some bills");
    expect(r.adaptations.signpost).toBe(true);
    expect(r.adaptations.style.gentle).toBe(true);
    expect(r.adaptations.cards[0]).toBe("free_help");
  });

  it("reads someone who is new to credit", () => {
    const r = run({ needs: ["new_to_credit"], usage: { ...emptyUsage(), learn: 3 } });
    expect(r.type).toBe("building");
    expect(r.adaptations.style.plain).toBe(true);
  });

  it("reads someone who wants plain words, one step at a time, in Simple view", () => {
    const r = run({ needs: ["plain_words", "step_by_step"], simpleView: true });
    expect(r.type).toBe("clear_simple");
    expect(r.adaptations.style).toMatchObject({ plain: true, stepByStep: true });
    expect(r.adaptations.displayOffer?.mode).toBe("simple");
  });

  it("reads a planner from how they use the app, with no needs ticked", () => {
    const r = run({ usage: { dial: 2, learn: 0, whatIf: 5, goals: 3, detailed: 5 }, payments: [{ kind: "statement" }], utilisation: 0.3 });
    expect(r.type).toBe("planner");
    expect(r.reasons).toContain("You've tried what-if sums");
  });

  it("doesn't guess when it isn't sure", () => {
    const r = run({});
    expect(r.type).toBeNull();
    expect(r.source).toBe("none");
    expect(r.reasons).toEqual([]);
    expect(r.adaptations.cards).toEqual([]);
  });

  it("the person's own choice always wins", () => {
    const r = run({ needs: ["money_tight", "behind_bills"] }, "planner");
    expect(r.type).toBe("planner");
    expect(r.source).toBe("chosen");
    expect(r.reasons).toEqual(["You chose this yourself"]);
    // Their needs still count: someone behind on bills still sees free help.
    expect(r.adaptations.signpost).toBe(true);
  });

  it("reasons only mention things the person actually has", () => {
    const r = run({ needs: ["bereavement"] });
    expect(r.reasons).toEqual(["You told us: someone close to me has died"]);
  });

  it("a stated need is honoured whatever type is picked or chosen", () => {
    const wants = { plain_words: "plain", new_to_credit: "plain", short_answers: "brief", step_by_step: "stepByStep", money_tight: "gentle" } as const;
    for (const t of [null, ...PERSON_TYPES]) {
      for (const [need, flag] of Object.entries(wants)) {
        expect(adaptationsFor(t, [need as keyof typeof wants]).style[flag]).toBe(true);
      }
      expect(adaptationsFor(t, ["behind_bills"]).signpost).toBe(true);
    }
  });

  it("only produces allowlisted cards and display actions", () => {
    for (const t of [null, ...PERSON_TYPES]) {
      const a = adaptationsFor(t, [...NEED_IDS]);
      expect(a.cards.every((c) => CARD_IDS.includes(c))).toBe(true);
      expect(a.cards.length).toBeLessThanOrEqual(3);
      for (const action of a.displayOffer?.actions ?? []) expect(["density", "explanations", "show"]).toContain(action.type);
    }
  });
});

describe("person-facing words", () => {
  const all = [
    ...NEEDS.map((n) => n.label),
    ...Object.values(DRIVER_HEADINGS).flatMap((h) => [h.title, h.hint]),
    ...Object.values(PERSON_TYPE_COPY).flatMap((c) => [c.title, c.summary]),
    ...Object.values(FEATURE_REASONS),
    ...FREE_HELP.map((h) => h.what),
    HELP_ANSWER,
    SIGNPOST_SENTENCE,
  ] as string[];

  it("never label the person", () => {
    for (const text of all) expect(text).not.toMatch(/vulnerab|disab|diagnos|disorder|mental|illness|impair|elderly|poor\b|high[- ]risk|risky/i);
  });

  it("help text carries no figures, so it can never contradict the account", () => {
    for (const text of [HELP_ANSWER, SIGNPOST_SENTENCE, ...FREE_HELP.map((h) => h.what)]) expect(text).not.toMatch(/\d|£/);
  });

  it("health needs are the sensitive ones", () => {
    expect(NEEDS.filter((n) => isSensitive(n.id)).map((n) => n.driver)).toEqual(["health", "health", "health", "health"]);
  });

  it("probabilities from the model always sum to about 1", () => {
    expect(predictProba(model, featureVector(base)).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});
