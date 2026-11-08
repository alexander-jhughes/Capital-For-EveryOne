import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE } from "../demo-config";
import type { Goal, GoalProgress, GoalSpec } from "../dial/types";
import { budgetStatus, spendingSummary } from "../finance";
import { formatPence } from "../format";
import type { InsightContext } from "../insights";
import type { Category, Transaction } from "../types";
import { describeGoal } from "./describe";
import { goalProgress } from "./progress";

const seed: InsightContext = { account: SEED_ACCOUNT, txns: SEED_TRANSACTIONS, settings: INITIAL_SPEND_PAUSE, today: DEMO_TODAY };
const goal = (spec: GoalSpec): Goal => ({ id: "g-1", spec, createdOn: "2026-11-08" });
const MONEY = /-?£[\d,]+\.\d{2}/g;

let n = 0;
const tx = (date: string, amount: number, category: Category = "Shopping", status: Transaction["status"] = "posted"): Transaction => ({
  id: `p${++n}`,
  date,
  merchant: "Shop",
  amount,
  category,
  status,
});

function check(p: GoalProgress) {
  if (p.percent !== null) {
    expect(Number.isInteger(p.percent)).toBe(true);
    expect(p.percent).toBeGreaterThanOrEqual(0);
    expect(p.percent).toBeLessThanOrEqual(100);
  }
  expect(p.status === "not_measurable").toBe(p.percent === null);
  for (const text of [p.title, p.statement, ...p.limitations]) expect(text).not.toMatch(/[\u2013\u2014]/);
  expect(p.statement).not.toMatch(/\b(should|guarantee|eligib)/i);
}

describe("describeGoal", () => {
  it("names each kind in plain English", () => {
    expect(describeGoal({ kind: "category_cap", category: "Eating out", monthlyLimit: 8000 })).toBe("Spend under £80 on eating out each month");
    expect(describeGoal({ kind: "category_cap", category: "Groceries", monthlyLimit: 15050 })).toBe("Spend under £150.50 on groceries each month");
    expect(describeGoal({ kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-10" })).toBe(
      "Spend £500 less than in October, in total, by the end of January 2027",
    );
    expect(describeGoal({ kind: "stay_in_budget" })).toBe("Stay within your Spend Pause monthly budget");
  });
});

describe("category_cap", () => {
  it("measures this month so far against the limit, from lib/finance", () => {
    const p = goalProgress(goal({ kind: "category_cap", category: "Eating out", monthlyLimit: 8000 }), seed);
    check(p);
    const spent = spendingSummary(SEED_TRANSACTIONS.filter((t) => t.category === "Eating out"), "2026-11-01", DEMO_TODAY).total;
    const october = spendingSummary(SEED_TRANSACTIONS.filter((t) => t.category === "Eating out"), "2026-10-01", "2026-10-31").total;
    expect(spent).toBe(6725);
    expect(p).toMatchObject({ goalId: "g-1", title: "Spend under £80 on eating out each month", percent: 84, status: "at_risk" });
    expect(p.statement).toBe(
      `In November so far (8 days), you've spent £67.25 of your £80.00 limit on eating out, leaving £12.75. In October, you spent ${formatPence(october)}, over the limit.`,
    );
    expect(p.limitations).toContain("November so far covers 8 days.");
  });

  it("is missed for this month once spending passes the limit", () => {
    const p = goalProgress(goal({ kind: "category_cap", category: "Groceries", monthlyLimit: 15000 }), seed);
    check(p);
    expect(p).toMatchObject({ percent: 100, status: "missed" });
    expect(p.statement).toContain("£33.53 over your £150.00 limit");
    expect(p.limitations).toContain("Includes 1 pending item, which may still change.");
  });

  it("is on track well under the limit, and refunds reduce spending", () => {
    const ctx = { ...seed, txns: [tx("2026-11-02", 3000), tx("2026-11-03", -2000), tx("2026-11-04", -9000, "Payments")] };
    const p = goalProgress(goal({ kind: "category_cap", category: "Shopping", monthlyLimit: 10000 }), ctx);
    check(p);
    expect(p).toMatchObject({ percent: 10, status: "on_track" });
  });
});

describe("stay_in_budget", () => {
  it("reads the Spend Pause budget", () => {
    const p = goalProgress(goal({ kind: "stay_in_budget" }), seed);
    check(p);
    const b = budgetStatus(SEED_TRANSACTIONS, INITIAL_SPEND_PAUSE, DEMO_TODAY)!;
    expect(p.percent).toBe(Math.round((b.spent * 100) / b.budget));
    expect(p.status).toBe("at_risk");
    for (const fig of p.statement.match(MONEY)!) expect([formatPence(b.spent), formatPence(b.budget), formatPence(b.remaining)]).toContain(fig);
    expect(p.limitations).toContain("Spend Pause is off, so purchases aren't checked against this budget.");
  });

  it("can't be measured without a budget, and says where to set one", () => {
    const p = goalProgress(goal({ kind: "stay_in_budget" }), { ...seed, settings: { ...INITIAL_SPEND_PAUSE, monthlyBudget: null } });
    check(p);
    expect(p).toMatchObject({ percent: null, status: "not_measurable" });
    expect(p.limitations).toEqual(["Set a monthly budget in Spend Pause to track this goal."]);
  });
});

describe("spend_reduction", () => {
  it("only counts complete months, so on the demo day it can't be measured yet", () => {
    const p = goalProgress(goal({ kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-10" }), seed);
    check(p);
    expect(p).toMatchObject({ percent: null, status: "not_measurable" });
    expect(p.statement).toBe("Progress starts counting when November is over, compared with the £853.27 you spent in October. In November so far (8 days), you've spent £402.35; it counts once the month is over.");
    expect(p.limitations).toContain("This tracks spending on this card, not money in a savings account.");
  });

  it("needs a complete month to compare with", () => {
    const p = goalProgress(goal({ kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-09" }), seed);
    check(p);
    expect(p.status).toBe("not_measurable");
    expect(p.statement).toContain("your history doesn't cover all of September");
  });

  const history = [tx("2026-10-01", 100000), tx("2026-10-20", -5000, "Payments"), tx("2026-11-05", 60000), tx("2026-12-05", 70000), tx("2027-01-03", 10000)];
  const later = { ...seed, txns: history, today: "2027-01-15" };

  it("adds up how much less was spent than the baseline, month by month", () => {
    const p = goalProgress(goal({ kind: "spend_reduction", target: 100000, by: "2027-02", baselineMonth: "2026-10" }), later);
    check(p);
    // (1,000 - 600) + (1,000 - 700) = £700 of £1,000 after 2 of 4 months.
    expect(p).toMatchObject({ percent: 70, status: "on_track" });
    expect(p.statement).toBe(
      "You've spent £700.00 less than October 2026's £1,000.00 a month over 2 months (November 2026 to December 2026), towards £1,000.00. In January so far (15 days), you've spent £100.00; it counts once the month is over.",
    );
  });

  it("is met, missed or at risk from the same arithmetic", () => {
    expect(goalProgress(goal({ kind: "spend_reduction", target: 50000, by: "2027-02", baselineMonth: "2026-10" }), later)).toMatchObject({ percent: 100, status: "met" });
    expect(goalProgress(goal({ kind: "spend_reduction", target: 100000, by: "2026-12", baselineMonth: "2026-10" }), later)).toMatchObject({ percent: 70, status: "missed" });
    expect(goalProgress(goal({ kind: "spend_reduction", target: 300000, by: "2027-03", baselineMonth: "2026-10" }), later)).toMatchObject({ percent: 23, status: "at_risk" });
  });

  it("shows no progress when spending went up", () => {
    const up = { ...later, txns: [tx("2026-10-01", 10000), tx("2026-11-05", 30000)], today: "2026-12-02" };
    const p = goalProgress(goal({ kind: "spend_reduction", target: 10000, by: "2027-02", baselineMonth: "2026-10" }), up);
    check(p);
    expect(p.percent).toBe(0);
    expect(p.statement).toContain("You've spent £200.00 more than October's £100.00 a month");
  });
});
