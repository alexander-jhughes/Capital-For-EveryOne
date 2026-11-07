// The evaluation harness (EVALUATION-v2.md): calibration metrics, generator B and the app-like simulations.
import { describe, expect, it } from "vitest";
import type { ModelArtifact } from "./artifact";
import { pipelineStats, scoreTargets, servedPopulation, simulateRepetition } from "./evaluate";
import { ece, reliability } from "./metrics";
import modelJson from "./model.json";
import { DEFAULT_SYNTHETIC, generateSynthetic } from "./synthetic";
import { DEFAULT_SYNTHETIC_B, generateSyntheticB } from "./synthetic-b";
import { TARGET_IDS } from "./targets";

const model = modelJson as unknown as ModelArtifact;
const smallB = { ...DEFAULT_SYNTHETIC_B, people: 600 };

describe("calibration metrics", () => {
  it("ECE is 0 when predicted rates match observed rates, and measures the gap otherwise", () => {
    const y = [1, 0, 1, 0, 1, 1, 1, 1, 0];
    expect(ece(y, [0.5, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 0.8, 0.8])).toBeCloseTo(0, 6);
    expect(ece([1, 1, 0, 0], [0.9, 0.9, 0.9, 0.9])).toBeCloseTo(0.4, 6);
    expect(ece([], [])).toBeNull();
  });

  it("reliability bins cover [0, 1], count every prediction once and include p = 1 in the last bin", () => {
    const bins = reliability([1, 0, 1, 0], [0, 0.05, 0.55, 1]);
    expect(bins).toHaveLength(10);
    expect(bins.reduce((n, b) => n + b.n, 0)).toBe(4);
    expect(bins[0]).toMatchObject({ n: 2, observed: 0.5 });
    expect(bins[9]).toMatchObject({ n: 1, predicted: 1, observed: 0 });
    expect(bins[3]).toMatchObject({ n: 0, predicted: null, observed: null });
  });
});

describe("generator B", () => {
  it("is reproducible from its seed and differs from generator A", () => {
    expect(generateSyntheticB(smallB)).toEqual(generateSyntheticB(smallB));
    expect(generateSyntheticB(smallB)).not.toEqual(generateSyntheticB({ ...smallB, seed: smallB.seed + 1 }));
    const a = generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 600 });
    expect(generateSyntheticB(smallB)).not.toEqual(a);
  });

  it("contains only allowlisted, non-financial inputs, like generator A", () => {
    for (const p of generateSyntheticB(smallB)) {
      expect(Object.keys(p.input).sort()).toEqual(["choices", "preferences", "view"]);
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
      expect(keys.join(" ")).not.toMatch(/balance|transaction|amount|spend|merchant|income|\bage\b|vulnerab|condition|speechInput/i);
      expect(JSON.stringify(p)).not.toMatch(/£|\d+\.\d\d/);
    }
  });
});

describe("evaluation harness", () => {
  const served = servedPopulation(generateSyntheticB(smallB));

  it("scores only the people the app can score, exactly as the provider passes them", () => {
    expect(served.length).toBeGreaterThan(0);
    for (const p of served) {
      expect(p.signals).not.toBeNull();
      expect(p.input.choices).toBeNull();
      expect(typeof p.input.preferences!.voiceFirst).toBe("boolean");
    }
    const older = generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 600 });
    expect(servedPopulation(older).every((p) => p.input.preferences!.explanations !== undefined)).toBe(true);
  });

  it("scores every target on eligible people only, and is deterministic", () => {
    const s = scoreTargets(model, served);
    for (const id of TARGET_IDS) {
      expect(s[id].eligible, id).toBeLessThanOrEqual(served.length);
      expect(s[id].reliability.reduce((n, b) => n + b.n, 0), id).toBe(s[id].eligible);
    }
    expect(scoreTargets(model, served)).toEqual(s);
  });

  it("pipeline coverage counts at most one suggestion per person", () => {
    const p = pipelineStats(model, served);
    const shown = TARGET_IDS.reduce((n, id) => n + p.byTarget[id].shown, 0);
    expect(shown).toBe(Math.round(p.anySuggestion * served.length));
  });

  it("repetition simulation is deterministic and only follows people who were offered something", () => {
    const a = servedPopulation(generateSynthetic({ ...DEFAULT_SYNTHETIC, people: 3000, seed: 11 }));
    const r = simulateRepetition(model, a, { policy: "noThanks", visits: 4 });
    expect(r.people).toBeGreaterThan(0);
    expect(r.shownPerPerson).toBeGreaterThanOrEqual(1);
    expect(simulateRepetition(model, a, { policy: "noThanks", visits: 4 })).toEqual(r);
  });
});
