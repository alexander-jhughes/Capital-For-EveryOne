import { describe, expect, it } from "vitest";
import { SEED_TRANSACTIONS as txns } from "../data/seed";
import { dailySpend, monthToDateSpend } from "./index";

describe("dailySpend", () => {
  const days = dailySpend(txns, "2026-11-01", "2026-11-08");
  it("covers every day, in order", () => {
    expect(days.map((d) => d.date)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"].map((d) => `2026-11-${d}`));
  });
  it("adds up to the month-to-date total", () => {
    expect(days.reduce((s, d) => s + d.total, 0)).toBe(monthToDateSpend(txns, "2026-11-08"));
  });
  it("matches the seed day by day", () => {
    expect(days.map((d) => d.total)).toEqual([3539, 6720, 3014, 6231, 3862, 8931, 7772, 166]);
  });
  it("crosses a month boundary and handles empty days", () => {
    const d = dailySpend([], "2026-10-30", "2026-11-02");
    expect(d.map((x) => x.date)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(d.every((x) => x.total === 0 && x.ids.length === 0)).toBe(true);
  });
});
