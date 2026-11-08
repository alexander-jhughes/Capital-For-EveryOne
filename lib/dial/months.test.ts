import { describe, expect, it } from "vitest";
import { SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { daysInMonth, historyStart, monthKey, monthName, monthRange, monthsBetween, monthsWithData, nextMonth, previousMonth } from "./months";

describe("months", () => {
  it("keys, steps and counts months", () => {
    expect(monthKey("2026-11-08")).toBe("2026-11");
    expect(previousMonth("2026-11")).toBe("2026-10");
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(monthsBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsBetween("2026-11", "2026-10")).toEqual([]);
  });

  it("names a month with its year only when it isn't this year", () => {
    expect(monthName("2026-10", DEMO_TODAY)).toBe("October");
    expect(monthName("2027-01", DEMO_TODAY)).toBe("January 2027");
  });

  it("labels the month in progress as partial, even on its last day", () => {
    expect(monthRange("2026-11", DEMO_TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-08", partial: true, days: 8, label: "November so far (8 days)" });
    expect(monthRange("2026-11", "2026-11-01").label).toBe("November so far (1 day)");
    expect(monthRange("2026-11", "2026-11-30")).toMatchObject({ partial: true, days: 30 });
  });

  it("treats a complete month as full, and one the history starts part way through as partial", () => {
    expect(monthRange("2026-10", DEMO_TODAY, "2026-09-28")).toEqual({ from: "2026-10-01", to: "2026-10-31", partial: false, days: 31, label: "October" });
    expect(monthRange("2026-09", DEMO_TODAY, "2026-09-28")).toEqual({
      from: "2026-09-28",
      to: "2026-09-30",
      partial: true,
      days: 3,
      label: "September (3 days, 28 to 30 September)",
    });
    expect(monthRange("2026-08", DEMO_TODAY, "2026-09-28")).toMatchObject({ partial: true, days: 0 });
    expect(monthRange("2026-12", DEMO_TODAY)).toMatchObject({ partial: true, days: 0, label: "December (not started yet)" });
  });

  it("finds the months with data, oldest first", () => {
    expect(monthsWithData(SEED_TRANSACTIONS)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(monthsWithData([])).toEqual([]);
    expect(historyStart(SEED_TRANSACTIONS)).toBe("2026-09-28");
    expect(historyStart([])).toBeUndefined();
  });
});
