import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { generateWorld } from "../synthetic";
import type { RecommenderInput } from "../types";
import { analyseMonitoring, drift, inputDistribution, type MonitoringReference, type MonitoringSnapshotLike, psi } from "./monitoring";

const blank: RecommenderInput = { answers: {}, preferences: DEFAULT_PREFS, view: "complex", explicit: [], signals: {}, history: [] };

describe("PSI", () => {
  it("is 0 for identical distributions and matches a hand computation", () => {
    expect(psi({ a: 10, b: 30 }, { a: 1, b: 3 })).toBeCloseTo(0, 12);
    // e = (0.5, 0.5), a = (0.8, 0.2): 0.3·ln(1.6) + (−0.3)·ln(0.4) = 0.141 + 0.2749
    expect(psi({ a: 5, b: 5 }, { a: 8, b: 2 })).toBeCloseTo(0.3 * Math.log(1.6) - 0.3 * Math.log(0.4), 10);
    expect(psi({ a: 1 }, {})).toBe(0);
  });
});

describe("input distribution and drift", () => {
  const world = generateWorld({ seed: 3, people: 1500 });
  const training = inputDistribution(world.examples.map((e) => e.input));

  it("counts each snapshot once, with skipped answers", () => {
    const d = inputDistribution([blank, blank, { ...blank, view: "simple", answers: { inputMode: "voice" }, explicit: ["textSize"] }]);
    expect(d.snapshots).toBe(2);
    expect(d.answers.inputMode).toEqual({ voice: 1, touch: 0, either: 0, skipped: 1 });
    expect(d.view).toEqual({ simple: 1, complex: 1 });
    expect(d.activeItems["view.detailed"]).toBe(1);
    expect(d.explicit).toEqual({ textSize: 1 });
  });

  it("finds no drift between two samples of the same world and large drift for a different population", () => {
    const other = generateWorld({ seed: 4, people: 1500 });
    const same = drift(training, inputDistribution(other.examples.map((e) => e.input)));
    expect(same.max!.psi).toBeLessThan(0.05);
    const everyoneVoice = inputDistribution(other.people.map((p) => ({ ...p.evaluation.input, answers: { ...p.evaluation.input.answers, inputMode: "voice" as const } })));
    const shifted = drift(training, everyoneVoice);
    expect(shifted.max!.feature).toBe("answer: inputMode");
    expect(shifted.max!.level).toBe("large");
    expect(drift(training, inputDistribution([])).insufficient).toBe(true);
  });

  const rc = (shown: number, kept: number) => ({ shown, kept, rate: shown ? kept / shown : null });
  const snapshot = (over: Partial<MonitoringSnapshotLike["acceptance"]> = {}, feedback?: MonitoringSnapshotLike["feedback"]): MonitoringSnapshotLike => ({
    since: null,
    recommendations: { total: 400, byModel: { m: 400 } },
    acceptance: {
      overall: rc(400, 160),
      byItem: { "textSize.125": rc(100, 40), "density.calm": rc(100, 40), "view.simple": rc(100, 40), "contrast.high": rc(100, 40) },
      byEvidence: { strong: rc(200, 100), moderate: rc(100, 40), limited: rc(100, 20), insufficient: rc(0, 0) },
      byRank: [rc(200, 100), rc(150, 50)],
      ...over,
    },
    feedback: feedback ?? { byOutcome: { accepted: 100, modified: 60, rejected: 200, dismissed: 40, reverted: 20 }, satisfaction: { helpful: 30, neutral: 10, unhelpful: 5 } },
    inputs: training,
  });
  const reference: MonitoringReference = { inputs: training, keptRate: 0.4, keptRateByPosition: [0.45, 0.35] };

  it("raises no warning when live behaviour matches training", () => {
    expect(analyseMonitoring(snapshot(), reference).warnings).toEqual([]);
  });

  it("warns on feedback bias: rank inversion, evidence inversion, dead items, concentration, unhelpful ratings", () => {
    const w = analyseMonitoring(
      snapshot(
        {
          overall: rc(400, 80),
          byRank: [rc(200, 40), rc(150, 60)],
          byEvidence: { strong: rc(100, 10), moderate: rc(0, 0), limited: rc(100, 50), insufficient: rc(0, 0) },
          byItem: { "textSize.125": rc(380, 79), "density.calm": rc(40, 1) },
        },
        { byOutcome: { accepted: 40, modified: 0, rejected: 60, dismissed: 0, reverted: 50 }, satisfaction: { helpful: 5, neutral: 5, unhelpful: 30 } },
      ),
      reference,
    ).warnings.join("\n");
    expect(w).toContain("Kept rate");
    expect(w).toContain("Rank 2 is kept more often");
    expect(w).toContain('"limited" evidence');
    expect(w).toContain("density.calm is kept only");
    expect(w).toContain("popularity feedback loop");
    expect(w).toContain("did not make Dial easier");
    expect(w).toContain("Undone suggestions");
  });

  it("says when there is no reference to measure drift against", () => {
    expect(analyseMonitoring(snapshot(), null).warnings[0]).toContain("drift cannot be measured");
  });
});
