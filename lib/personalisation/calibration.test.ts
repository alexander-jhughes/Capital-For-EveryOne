import { describe, expect, it } from "vitest";
import { calibrate, fitIsotonic, IDENTITY_CALIBRATION, isValidCalibration, MAX_KNOTS } from "./calibration";
import { rng } from "./forest";

describe("isotonic calibration", () => {
  it("is monotone and maps an over-confident score back to the observed rate", () => {
    const r = rng(3);
    const p: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const raw = r();
      p.push(Math.round(raw * 20) / 20);
      y.push(r() < raw * 0.5 ? 1 : 0); // the truth is half of what the score claims
    }
    const c = fitIsotonic(y, p);
    expect(isValidCalibration(c)).toBe(true);
    for (let i = 1; i < c.y.length; i++) expect(c.y[i]).toBeGreaterThanOrEqual(c.y[i - 1]);
    expect(calibrate(c, 0.9)).toBeGreaterThan(0.35);
    expect(calibrate(c, 0.9)).toBeLessThan(0.55);
  });

  it("never rests a knot on a handful of people, and stays small", () => {
    const y = Array.from({ length: 1000 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const p = Array.from({ length: 1000 }, (_, i) => i / 1000);
    const c = fitIsotonic(y, p, 50);
    expect(c.x.length).toBeLessThanOrEqual(Math.min(MAX_KNOTS, 1000 / 50));
    expect(fitIsotonic([], [])).toEqual(IDENTITY_CALIBRATION);
  });

  it("interpolates between knots and is flat beyond the ends", () => {
    const c = { x: [0.2, 0.6], y: [0.1, 0.5] };
    expect(calibrate(c, 0)).toBe(0.1);
    expect(calibrate(c, 0.4)).toBeCloseTo(0.3, 10);
    expect(calibrate(c, 1)).toBe(0.5);
    expect(calibrate(IDENTITY_CALIBRATION, 0.37)).toBeCloseTo(0.37, 10);
  });

  it("rejects malformed calibrations from JSON", () => {
    for (const bad of [null, {}, { x: [], y: [] }, { x: [0.5, 0.4], y: [0.1, 0.2] }, { x: [0.1, 0.2], y: [0.3, 0.2] }, { x: [0.1], y: [1.5] }, { x: [0.1, 0.2], y: [0.1] }, { x: ["0.1"], y: [0.1] }])
      expect(isValidCalibration(bad), JSON.stringify(bad)).toBe(false);
  });
});
