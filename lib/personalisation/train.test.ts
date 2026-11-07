// Trains the real model once (a few seconds) and checks reproducibility, evaluation and the committed artifact.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FORMAT_FEATURES, isValidModel, type ModelArtifact } from "./artifact";
import { calibrate } from "./calibration";
import { FEATURE_IDS } from "./features";
import { recommendPreferences } from "./infer";
import { INITIAL_STATE } from "./state";
import { DEFAULT_SYNTHETIC, generateSynthetic, servedPopulation, splitIndices } from "./synthetic";
import { TARGET_IDS, targetStatus } from "./targets";
import { chooseThreshold, DEFAULT_CONFIG, trainModel, type TrainingReport, V1_CONFIG, V2_CONFIG } from "./train";

let model: ModelArtifact;
let report: TrainingReport;
beforeAll(() => {
  ({ model, report } = trainModel(DEFAULT_CONFIG));
}, 120_000);

describe("synthetic data", () => {
  const small = { ...DEFAULT_SYNTHETIC, people: 500 };

  it("is reproducible from its seed", () => {
    expect(generateSynthetic(small)).toEqual(generateSynthetic(small));
    expect(generateSynthetic(small)).not.toEqual(generateSynthetic({ ...small, seed: small.seed + 1 }));
  });

  it("contains only allowlisted, non-financial inputs", () => {
    for (const p of generateSynthetic(small)) {
      expect(Object.keys(p.input).sort()).toEqual(["choices", "preferences", "view"]);
      // Every field name anywhere in a synthetic person is a display setting, a choice, a signal or a label.
      // (Values can be home-screen widget ids such as "balance": those name a section of the screen, not an amount.)
      const keys: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === "object" && v !== null)
          for (const [k, inner] of Object.entries(v)) {
            keys.push(k);
            walk(inner);
          }
      };
      walk(p);
      expect(keys.join(" ")).not.toMatch(/balance|transaction|amount|spend|merchant|income|\bage\b|vulnerab|condition/i);
      expect(JSON.stringify(p)).not.toMatch(/£|\d+\.\d\d/);
    }
  });

  it("has missing data like real use: some never did Make it yours, some never consented to signals (v1: some on the older schema)", () => {
    for (const version of [1, 2] as const) {
      const people = generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 2000, version });
      const share = (f: (p: (typeof people)[number]) => boolean) => people.filter(f).length / people.length;
      expect(share((p) => p.input.choices === null), `v${version}`).toBeGreaterThan(0.4);
      expect(share((p) => p.signals === null), `v${version}`).toBeGreaterThan(0.3);
      // Version 2 models this app, where every person has the current schema (sanitize() fills it in).
      expect(share((p) => p.input.preferences!.voiceFirst === undefined), `v${version}`)[version === 1 ? "toBeGreaterThan" : "toBe"](version === 1 ? 0.2 : 0);
    }
  });

  it("version 1 is unchanged, so the v1 baseline can still be reproduced and evaluated", () => {
    const v1 = generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 300, version: 1 });
    expect(v1).toEqual(generateSynthetic({ ...V1_CONFIG.data, people: 300 }));
    expect(v1).not.toEqual(generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 300 }));
    expect(v1.every((p) => !p.signals || !("readAloud" in p.signals))).toBe(true);
  });

  it("never generates speechInput (a microphone privacy choice, not a display preference)", () => {
    for (const p of generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 300 })) expect(Object.keys(p.input.preferences!)).not.toContain("speechInput");
  });

  it("splits people into disjoint train, validation and test sets covering everyone", () => {
    const s = splitIndices(1000, 1);
    const all = [...s.train, ...s.validation, ...s.test];
    expect(new Set(all).size).toBe(1000);
    expect(all.length).toBe(1000);
    expect([s.train.length, s.validation.length, s.test.length]).toEqual([600, 200, 200]);
  });
});

describe("training", () => {
  it("produces a valid model with the feature order of its format", () => {
    expect(isValidModel(model)).toBe(true);
    expect(model.formatVersion).toBe(DEFAULT_CONFIG.pipeline);
    expect(model.features).toEqual(FORMAT_FEATURES[DEFAULT_CONFIG.pipeline]);
    expect(FEATURE_IDS.slice(0, FORMAT_FEATURES[1].length)).toEqual(FORMAT_FEATURES[1]); // features are append-only
    expect(model.trainedOn).toBe("synthetic");
    for (const id of TARGET_IDS) expect(model.targets[id].trees).toHaveLength(DEFAULT_CONFIG.forest.trees);
  });

  it("is reproducible: the committed model.json is exactly what the training script produces", () => {
    const committed = JSON.parse(readFileSync(fileURLToPath(new URL("./model.json", import.meta.url)), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(model)));
  });

  it("trains each target only on people who have that setting off", () => {
    const people = generateSynthetic(DEFAULT_CONFIG.data);
    const split = splitIndices(people.length, DEFAULT_CONFIG.data.seed);
    for (const id of TARGET_IDS) {
      const eligible = split.train.filter((i) => targetStatus(id, people[i].input.preferences) === "off").length;
      expect(report.targets[id].eligible.train).toBe(eligible);
      expect(eligible).toBeLessThan(split.train.length);
    }
  });

  it("stays small enough to ship to the browser", () => {
    expect(JSON.stringify(model).length).toBeLessThan(300 * 1024);
  });
});

describe("the v2 candidate pipeline (V2_CONFIG)", () => {
  // Small, so the suite stays fast; the full candidate is trained by `train.ts --evaluate`.
  const { model: v2, report: r2 } = trainModel({ ...V2_CONFIG, data: { ...V2_CONFIG.data, people: 6000 }, forest: { ...V2_CONFIG.forest, trees: 5 } });

  it("produces a valid format-2 model with every feature and a monotone calibration per target", () => {
    expect(isValidModel(v2)).toBe(true);
    expect(v2.formatVersion).toBe(2);
    expect(v2.features).toEqual(FEATURE_IDS);
    for (const id of TARGET_IDS) {
      const c = v2.targets[id].calibration!;
      const ys = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((p) => calibrate(c, p));
      expect(ys, id).toEqual([...ys].sort((a, b) => a - b));
      expect(r2.targets[id].ece.calibrated, id).not.toBeNull();
    }
  });

  it("trains only on the people the app can score, and runs through inference", () => {
    const served = servedPopulation(generateSynthetic({ ...V2_CONFIG.data, people: 6000 })).length;
    expect(r2.people.train + r2.people.validation + r2.people.test).toBe(served);
    const r = recommendPreferences({ preferences: { textSize: 150 }, view: "simple" }, { ...INITIAL_STATE, consent: "granted", signals: { readAloud: 4 } }, v2);
    expect(["ok", "no_recommendation"]).toContain(r.status);
  });
});

describe("evaluation", () => {
  it("beats the majority baseline and a decision stump on every target (test AUC and Brier)", () => {
    for (const id of TARGET_IDS) {
      const t = report.targets[id].test;
      expect(t.forest.auc!, id).toBeGreaterThan(0.55);
      expect(t.forest.auc!, id).toBeGreaterThan(t.stump.auc!);
      expect(t.forest.brier, id).toBeLessThan(t.majority.brier);
    }
  });

  it("does not overfit: train/test AUC gap stays small, and smaller than a single deep tree's on average", () => {
    const gaps = TARGET_IDS.map((id) => report.targets[id].overfitGap);
    for (const g of gaps) expect(g.forest!).toBeLessThan(0.08);
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean(gaps.map((g) => g.forest!))).toBeLessThan(mean(gaps.map((g) => g.singleTree!)));
  });

  it("only enables a target when its offers would mostly be kept, and that holds on unseen test people", () => {
    const enabled = TARGET_IDS.filter((id) => report.targets[id].threshold !== null);
    expect(enabled.length).toBeGreaterThan(0);
    for (const id of enabled) {
      expect(report.targets[id].threshold!).toBeGreaterThanOrEqual(DEFAULT_CONFIG.thresholdFloor);
      expect(report.targets[id].recommendations!.keepRate!, id).toBeGreaterThan(0.75);
    }
  });

  it("chooses no threshold when the model can't reach the required keep rate", () => {
    const cfg = { minKeepRate: 0.8, minOffered: 2, thresholdFloor: 0.6 };
    expect(chooseThreshold([0, 0, 1, 0], [0.9, 0.9, 0.9, 0.95], cfg)).toBeNull();
    expect(chooseThreshold([1, 1, 0, 0], [0.9, 0.9, 0.2, 0.62], cfg)).toBe(0.65);
    expect(chooseThreshold([1], [0.99], cfg)).toBeNull(); // too few offers to trust
  });
});
