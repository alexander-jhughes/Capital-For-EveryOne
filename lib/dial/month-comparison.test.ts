// "How do my groceries compare to last month?" is this month so far against last month (product review, Task B).
// Before the fix the planner read "last month" as the month asked about and compared it with the month before.
import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { INITIAL_SPEND_PAUSE } from "../demo-config";
import type { InsightContext } from "../insights/types";
import type { Category, ISODate, Transaction } from "../types";
import { plan, type PlanEnvWithTransactions } from "./plan";
import { EMPTY_CONTEXT, type DialStep, type Visual } from "./types";
import { buildVisual } from "./visuals";

function env(today: ISODate, months: string[], transactions: Transaction[] = SEED_TRANSACTIONS): PlanEnvWithTransactions {
  return {
    context: EMPTY_CONTEXT,
    textSize: 100,
    merchants: [...new Set(transactions.map((t) => t.merchant))],
    transactionIds: transactions.map((t) => t.id),
    months,
    today,
    transactions,
  };
}
const SEED_ENV = env("2026-11-08", ["2026-09", "2026-10", "2026-11"]);
const comparison = (text: string, e: PlanEnvWithTransactions = SEED_ENV) => {
  const steps = plan({ text }, e).steps;
  const v = steps.find((s): s is Extract<DialStep, { type: "visual" }> => s.type === "visual");
  return v?.request;
};

describe("the planner picks this month against last month", () => {
  it.each([
    "How do my groceries compare to last month?",
    "Compare my groceries with last month",
    "Groceries vs last month",
    "How have my groceries changed since last month?",
    "Did I spend more on groceries than last month?",
  ])("%s", (text) => {
    expect(comparison(text)).toEqual({ kind: "month_comparison", category: "Groceries", months: ["2026-11", "2026-10"] });
  });

  it("works for all spending, not just one category", () => {
    expect(comparison("How does my spending compare to last month?")).toEqual({ kind: "month_comparison", months: ["2026-11", "2026-10"] });
  });

  it("is worked out from today, never a fixed month: across a year boundary", () => {
    const jan = env("2027-01-15", ["2026-11", "2026-12", "2027-01"]);
    expect(comparison("How do my groceries compare to last month?", jan)).toEqual({ kind: "month_comparison", category: "Groceries", months: ["2027-01", "2026-12"] });
  });

  it("on the first of the month", () => {
    const first = env("2026-12-01", ["2026-10", "2026-11", "2026-12"]);
    expect(comparison("Compare groceries to last month", first)?.months).toEqual(["2026-12", "2026-11"]);
  });

  it("says there's nothing to compare, rather than inventing a month, when last month has no history", () => {
    const fresh = env("2026-11-08", ["2026-11"]);
    const steps = plan({ text: "How do my groceries compare to last month?" }, fresh).steps;
    expect(steps).toEqual([expect.objectContaining({ type: "unsupported" })]);
  });
});

describe("other comparisons are unchanged", () => {
  it("naming two months compares those months", () => {
    expect(comparison("Compare my groceries in October and September")?.months).toEqual(["2026-10", "2026-09"]);
  });

  it('"this month vs last month" was already right and still is', () => {
    expect(comparison("groceries this month vs last month")?.months).toEqual(["2026-11", "2026-10"]);
  });

  it("last month as the subject, with no baseline word, is still last month against the month before", () => {
    expect(comparison("How did my grocery spending last month compare?")?.months).toEqual(["2026-10", "2026-09"]);
  });

  it('"the month before last" isn\'t mistaken for the baseline', () => {
    expect(comparison("Compare groceries with the month before last")?.months).not.toEqual(["2026-11", "2026-10"]);
  });
});

// ---- The figures on the chart: real transactions only, partial months never shown as full ----

let n = 0;
const txn = (date: ISODate, amount: number, category: Category = "Groceries"): Transaction => ({ id: `x${++n}`, date, merchant: "Shop", amount, category, status: "posted" });
const ctx = (today: ISODate, txns: Transaction[]): InsightContext => ({ account: SEED_ACCOUNT, txns, settings: INITIAL_SPEND_PAUSE, today });
const totals = (v: Visual) => v.series[0]?.data.map((d) => [d.label, d.value]) ?? [];
const sum = (txns: Transaction[], from: ISODate, to: ISODate, category: Category) =>
  txns.filter((t) => t.category === category && t.date >= from && t.date <= to && t.amount > 0).reduce((s, t) => s + t.amount, 0);

describe("the comparison the fixed request produces", () => {
  it("demo data: groceries from 1 to 8 November against 1 to 8 October, both summed from the transactions", () => {
    const v = buildVisual({ kind: "month_comparison", category: "Groceries", months: ["2026-11", "2026-10"] }, ctx("2026-11-08", SEED_TRANSACTIONS));
    expect(totals(v).slice(0, 2)).toEqual([
      ["Spent on groceries, 1 to 8 November", sum(SEED_TRANSACTIONS, "2026-11-01", "2026-11-08", "Groceries")],
      ["Spent on groceries, 1 to 8 October", sum(SEED_TRANSACTIONS, "2026-10-01", "2026-10-08", "Groceries")],
    ]);
    // The incomplete month is never presented as a whole month.
    expect(v.title).toBe("Groceries: November and October compared");
    expect(v.summary).toContain("from 1 to 8 November");
    expect(v.limitations.join(" ")).toContain("November so far covers 8 days");
  });

  it("different month lengths: 30 March is compared with the 28 days February has", () => {
    // History from January, so both months are fully covered and only the month lengths differ.
    const txns = [txn("2027-01-20", 100, "Shopping"), txn("2027-02-03", 1000), txn("2027-02-28", 2000), txn("2027-03-02", 1500), txn("2027-03-29", 700), txn("2027-03-30", 900)];
    const v = buildVisual({ kind: "month_comparison", category: "Groceries", months: ["2027-03", "2027-02"] }, ctx("2027-03-30", txns));
    expect(totals(v).slice(0, 2)).toEqual([
      // 29 and 30 March are outside the 28 days February has, so they don't count.
      ["Spent on groceries, 1 to 28 March", 1500],
      ["Spent on groceries, 1 to 28 February", 1000 + 2000],
    ]);
    expect(v.limitations.join(" ")).toContain("days 1 to 28");
  });

  it("31 October against a 30-day September: same days only", () => {
    const txns = [txn("2026-08-20", 100, "Shopping"), txn("2026-09-01", 400), txn("2026-09-30", 600), txn("2026-10-01", 500), txn("2026-10-31", 9999)];
    const v = buildVisual({ kind: "month_comparison", category: "Groceries", months: ["2026-10", "2026-09"] }, ctx("2026-10-31", txns));
    expect(totals(v).slice(0, 2)).toEqual([
      ["Spent on groceries, 1 to 30 October", 500],
      ["Spent on groceries, 1 to 30 September", 400 + 600],
    ]);
  });

  it("the first of the month compares day 1 with day 1", () => {
    const txns = [txn("2026-10-20", 100, "Shopping"), txn("2026-11-01", 300), txn("2026-11-02", 9999), txn("2026-12-01", 450)];
    const v = buildVisual({ kind: "month_comparison", category: "Groceries", months: ["2026-12", "2026-11"] }, ctx("2026-12-01", txns));
    expect(totals(v).slice(0, 2)).toEqual([
      ["Spent on groceries, 1 December", 450],
      ["Spent on groceries, 1 November", 300],
    ]);
  });

  it("a category with no transactions says so and shows no figure", () => {
    const txns = [txn("2026-10-02", 1200, "Eating out"), txn("2026-11-03", 800, "Eating out")];
    const v = buildVisual({ kind: "month_comparison", category: "Travel", months: ["2026-11", "2026-10"] }, ctx("2026-11-08", txns));
    expect(v.summary).toMatch(/no spending on travel/i);
    expect(v.series.flatMap((s) => s.data)).toEqual([]);
  });

  it("only the asked category counts, and a refund in it is netted off", () => {
    const txns = [txn("2026-10-02", 1000), txn("2026-10-03", 5000, "Shopping"), txn("2026-10-04", -300), txn("2026-11-02", 700)];
    const v = buildVisual({ kind: "month_comparison", category: "Groceries", months: ["2026-11", "2026-10"] }, ctx("2026-11-08", txns));
    const [nov, oct] = totals(v);
    expect(nov[1]).toBe(700);
    expect(oct[1]).toBe(1000 - 300);
  });

  it("a card payment is never counted as spending", () => {
    const txns = [txn("2026-10-02", 1000), txn("2026-11-02", 700), txn("2026-11-03", -20000, "Payments")];
    const v = buildVisual({ kind: "month_comparison", months: ["2026-11", "2026-10"] }, ctx("2026-11-08", txns));
    const [nov, oct] = totals(v);
    expect(nov[1]).toBe(700);
    expect(oct[1]).toBe(1000);
  });
});
