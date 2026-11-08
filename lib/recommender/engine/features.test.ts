import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { DIMENSIONS, ITEM_IDS } from "../catalog";
import { QUESTIONS } from "../profile";
import { type RecommenderInput, SIGNAL_CAP, SIGNAL_IDS } from "../types";
import { encode, FEATURE_IDS, featureIndex, FEATURES, HISTORY_CAP, normaliseInput } from "./features";
import { similarityVector, SIMILARITY_WEIGHTS, weightedCosine } from "./similarity";
import { COLD_START, DAY, MINIMAL_GUIDED_VOICE, T0 } from "./test-world";

const at = (id: string, x: number[]) => x[featureIndex(id)];
const base: RecommenderInput = { ...COLD_START };

describe("feature allowlist", () => {
  it("has one feature per answer option, section, catalog item, dimension, signal and history aggregate, with unique ids", () => {
    const options = QUESTIONS.reduce((n, q) => n + q.options.length, 0);
    expect(FEATURE_IDS.length).toBe(options + 3 + ITEM_IDS.length + DIMENSIONS.length + SIGNAL_IDS.length + 4);
    expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
    expect(encode(base)).toHaveLength(FEATURE_IDS.length);
  });

  it("reads nothing outside RecommenderInput: demographic, money and conversation fields change nothing", () => {
    const extra = {
      ...MINIMAL_GUIDED_VOICE,
      ageBand: "65+",
      research: { ageBand: "18-24" },
      income: 12000,
      balance: 532.11,
      transactions: [{ merchant: "Shop", amount: 1299 }],
      transcript: "I can't read the screen",
      answers: { ...MINIMAL_GUIDED_VOICE.answers, ageBand: "65+", disability: "yes", income: "low" },
      preferences: { ...DEFAULT_PREFS, health: "poor", layout: { ...DEFAULT_PREFS.layout, secret: 1 } },
      signals: { voiceSessions: 2, transcriptWords: 900, spend: 40 },
    } as unknown as RecommenderInput;
    const clean = { ...MINIMAL_GUIDED_VOICE, signals: { voiceSessions: 2 } };
    expect(encode(extra)).toEqual(encode(clean));
  });

  it("never throws on malformed input and treats it as nothing said", () => {
    for (const bad of [null, undefined, 42, "x", [], { answers: "x", preferences: 7, view: "weird", explicit: "all", signals: [], history: {} }]) {
      const x = encode(bad as unknown as RecommenderInput);
      expect(x).toHaveLength(FEATURE_IDS.length);
      expect(x.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    }
  });
});

describe("answers", () => {
  it("one-hot encodes each answer and marks its section; skipped questions are all zeros", () => {
    const x = encode({ ...base, answers: { detailLevel: "keyFacts" } });
    expect(at("answer.detailLevel.keyFacts", x)).toBe(1);
    expect(at("answer.detailLevel.some", x)).toBe(0);
    expect(at("answer.detailLevel.everything", x)).toBe(0);
    expect(at("section.experience", x)).toBe(1);
    expect(at("section.interaction", x)).toBe(0);
    expect(at("section.accessibility", x)).toBe(0);
    for (const q of QUESTIONS) if (q.id !== "detailLevel") for (const o of q.options) expect(at(`answer.${q.id}.${o.value}`, x)).toBe(0);
  });

  it("drops unknown values instead of guessing", () => {
    const x = encode({ ...base, answers: { detailLevel: "lots", priority: "payments" } as never });
    expect(FEATURE_IDS.filter((id) => id.startsWith("answer.detailLevel")).every((id) => at(id, x) === 0)).toBe(true);
    expect(at("answer.priority.payments", x)).toBe(1);
    expect(normaliseInput({ ...base, answers: { detailLevel: "lots" } }).answered).toBe(0);
  });
});

describe("settings, explicit, view", () => {
  it("encodes each catalog item as in effect or not, including the view", () => {
    const x = encode({ ...base, preferences: { ...DEFAULT_PREFS, textSize: 150, layout: { ...DEFAULT_PREFS.layout, pinned: ["bill"] } }, view: "complex" });
    expect(at("active.textSize.125", x)).toBe(1);
    expect(at("active.textSize.150", x)).toBe(1);
    expect(at("active.homeFocus.bill", x)).toBe(1);
    expect(at("active.view.detailed", x)).toBe(1);
    expect(at("active.view.simple", x)).toBe(0);
    expect(at("active.contrast.high", x)).toBe(0);
  });

  it("encodes explicit dimensions and ignores unknown ones", () => {
    const x = encode({ ...base, explicit: ["textSize", "nonsense" as never, "view"] });
    expect(at("explicit.textSize", x)).toBe(1);
    expect(at("explicit.view", x)).toBe(1);
    expect(DIMENSIONS.filter((d) => at(`explicit.${d}`, x) === 1)).toHaveLength(2);
  });
});

describe("signals and history", () => {
  it("scales signals as log1p(min(n, cap)) / log1p(cap) and caps them", () => {
    const x = encode({ ...base, signals: { voiceSessions: 3, textLarger: 1000, textSmaller: -4, moreDetail: Number.NaN } });
    expect(at("signal.voiceSessions", x)).toBeCloseTo(Math.log1p(3) / Math.log1p(SIGNAL_CAP), 10);
    expect(at("signal.textLarger", x)).toBe(1);
    expect(at("signal.textSmaller", x)).toBe(0);
    expect(at("signal.moreDetail", x)).toBe(0);
  });

  it("aggregates history without item identities, capped", () => {
    const history = [
      ...Array.from({ length: 9 }, (_, i) => ({ item: "density.calm" as const, outcome: "rejected" as const, at: T0 + i * DAY })),
      { item: "textSize.125" as const, outcome: "accepted" as const, at: T0 },
      { item: "contrast.high" as const, outcome: "dismissed" as const, at: T0 },
    ];
    const x = encode({ ...base, history });
    expect(at("history.rejected", x)).toBe(1); // capped at HISTORY_CAP
    expect(at("history.accepted", x)).toBeCloseTo(Math.log1p(1) / Math.log1p(HISTORY_CAP), 10);
    expect(at("history.reverted", x)).toBe(0);
    expect(at("history.rounds", x)).toBe(1); // 9 distinct moments, capped
    expect(FEATURE_IDS.some((id) => id.startsWith("history.") && id.includes("density"))).toBe(false);
  });
});

describe("descriptions", () => {
  it("describe the person's own choices, and never quote the accessibility answer", () => {
    const x = encode({
      ...MINIMAL_GUIDED_VOICE,
      answers: { ...MINIMAL_GUIDED_VOICE.answers, screenReader: "yes" },
      preferences: { ...DEFAULT_PREFS, textSize: 125 },
      signals: { voiceSessions: 3, textLarger: 40 },
    });
    const texts = FEATURES.map((f, i) => (x[i] > 0 ? f.describe(x[i]) : null)).filter((t): t is string => t !== null);
    expect(texts).toContain('You said "Just the key facts" when asked how much financial detail you like to see');
    expect(texts).toContain("You chose larger text");
    expect(texts).toContain("You've opened Voice Mode 3 times");
    expect(texts).toContain(`You made the text bigger ${SIGNAL_CAP} or more times`);
    expect(texts.every((t) => t.startsWith("You"))).toBe(true);
    expect(texts.join(" ")).not.toMatch(/screen reader/i);
  });
});

describe("similarity", () => {
  it("is a weighted cosine: 1 for the same person, 0 for someone who told Dial nothing", () => {
    const a = encode(MINIMAL_GUIDED_VOICE);
    expect(weightedCosine(a, a)).toBeCloseTo(1, 12);
    expect(weightedCosine(a, encode(COLD_START))).toBe(0);
    expect(similarityVector(encode(COLD_START))).toBeNull();
  });

  it("ignores history and the view, and down-weights signals", () => {
    const a = encode(MINIMAL_GUIDED_VOICE);
    const withHistory = encode({ ...MINIMAL_GUIDED_VOICE, view: "simple", history: [{ item: "density.calm", outcome: "rejected", at: T0 }] });
    expect(weightedCosine(a, withHistory)).toBeCloseTo(1, 12);
    expect(SIMILARITY_WEIGHTS[featureIndex("signal.voiceSessions")]).toBeLessThan(SIMILARITY_WEIGHTS[featureIndex("answer.inputMode.voice")]);
    const oneAnswerDiffers = encode({ ...MINIMAL_GUIDED_VOICE, answers: { ...MINIMAL_GUIDED_VOICE.answers, inputMode: "touch" } });
    const signalsDiffer = encode({ ...MINIMAL_GUIDED_VOICE, signals: { voiceSessions: SIGNAL_CAP } });
    expect(weightedCosine(a, signalsDiffer)).toBeGreaterThan(weightedCosine(a, oneAnswerDiffers));
  });
});
