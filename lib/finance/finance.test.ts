import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT as acct, SEED_TRANSACTIONS as txns } from "../data/seed";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import { formatDate, formatPence } from "../format";
import type { PendingPurchase, SpendPauseSettings } from "../types";
import {
  availableCredit,
  biggestItems,
  billSummary,
  evaluatePurchase,
  findPossibleDuplicates,
  inQuietHours,
  monthToDateSpend,
  payoffEstimate,
  spendingSummary,
  totalByMerchant,
} from "./index";

const headphones: PendingPurchase = { id: "p1", merchant: "Northwind Audio", item: "Wireless headphones", amount: 12000, createdAt: DEMO_NOW.toISOString() };

describe("seed + clock", () => {
  it("matches the brief", () => {
    expect(DEMO_TODAY).toBe("2026-11-08");
    expect(txns.length).toBeGreaterThanOrEqual(55);
    expect(acct.statementBalance).toBeGreaterThanOrEqual(40000);
    expect(acct.statementBalance).toBeLessThanOrEqual(60000);
    expect(formatDate(acct.paymentDueDate)).toBe("Friday 13 Nov");
    expect(availableCredit(acct)).toBeGreaterThan(12000);
  });
  it("formats GBP", () => expect(formatPence(48620)).toBe("£486.20"));
});

describe("billSummary", () => {
  it("counts days to due date", () => {
    const b = billSummary(acct, DEMO_TODAY);
    expect(b.daysUntilDue).toBe(5);
    expect(b.availableCredit).toBe(acct.creditLimit - acct.currentBalance);
  });
});

describe("spending", () => {
  it("nets refunds and excludes payments", () => {
    const s = spendingSummary(txns, "2026-10-15", "2026-10-29");
    const manual = txns.filter((t) => t.date >= "2026-10-15" && t.date <= "2026-10-29" && t.category !== "Payments").reduce((a, t) => a + t.amount, 0);
    expect(s.total).toBe(manual);
    expect(s.refunds).toBe(1499);
    expect(s.byCategory.reduce((a, c) => a + c.total, 0)).toBe(s.total);
  });
  it("month to date is ~80% of £500", () => expect(monthToDateSpend(txns, DEMO_TODAY)).toBe(40235));
  it("biggest items", () => {
    const [a, b, c] = biggestItems(txns, 3);
    expect(a.amount).toBeGreaterThanOrEqual(b.amount);
    expect(b.amount).toBeGreaterThanOrEqual(c.amount);
    expect(a.merchant).toBe("Trainline");
  });
  it("totals by merchant case-insensitively", () => {
    const amazon = totalByMerchant(txns, "amazon");
    expect(amazon.total).toBe(1899 + 3450 + 1499 - 1499 + 4599);
  });
});

describe("findPossibleDuplicates", () => {
  it("finds exactly the deliberate Tesco pair", () => {
    const d = findPossibleDuplicates(txns);
    expect(d).toHaveLength(1);
    expect(d[0].first.merchant).toBe("Tesco");
    expect(d[0].first.amount).toBe(3862);
    expect(d[0].daysApart).toBe(1);
  });
  it("ignores pairs more than 3 days apart", () => {
    const x = { ...txns[0], date: "2026-11-01" };
    expect(findPossibleDuplicates([x, { ...x, id: "y", date: "2026-11-05" }])).toHaveLength(0);
    expect(findPossibleDuplicates([x, { ...x, id: "y", date: "2026-11-04" }])).toHaveLength(1);
  });
});

describe("payoffEstimate", () => {
  it("pays off in one month when payment covers it", () => {
    expect(payoffEstimate(10000, 24.9, 20000)).toEqual({ label: "estimate", months: 1, totalInterest: 208 });
  });
  it("returns null when payment never beats interest", () => {
    expect(payoffEstimate(100000, 24.9, 2000).months).toBeNull();
  });
  it("longer payoff costs more interest", () => {
    const fast = payoffEstimate(48620, 24.9, 10000);
    const slow = payoffEstimate(48620, 24.9, 2500);
    expect(slow.months!).toBeGreaterThan(fast.months!);
    expect(slow.totalInterest!).toBeGreaterThan(fast.totalInterest!);
  });
});

describe("evaluatePurchase", () => {
  it("pauses £120 for both threshold and budget on the reset state", () => {
    const d = evaluatePurchase(acct, txns, RESET_SPEND_PAUSE, headphones, DEMO_NOW);
    expect(d.shouldPause).toBe(true);
    expect(d.reasons).toEqual(["over_threshold", "over_budget"]);
    expect(d.balanceAfter).toBe(acct.currentBalance + 12000);
    expect(d.availableCreditAfter).toBe(acct.creditLimit - acct.currentBalance - 12000);
    expect(d.budgetRemainingAfter).toBe(50000 - 40235 - 12000);
  });
  it("never pauses when off", () => {
    const d = evaluatePurchase(acct, txns, { ...RESET_SPEND_PAUSE, enabled: false }, headphones, DEMO_NOW);
    expect(d.shouldPause).toBe(false);
    expect(d.reasons).toEqual([]);
  });
  it("does not pause at exactly the threshold or under budget", () => {
    const s: SpendPauseSettings = { enabled: true, singlePurchaseThreshold: 10000, monthlyBudget: null, quietHours: null };
    const d = evaluatePurchase(acct, txns, s, { ...headphones, amount: 10000 }, DEMO_NOW);
    expect(d.shouldPause).toBe(false);
    expect(d.budgetRemainingAfter).toBeNull();
  });
  it("pauses in quiet hours, wrapping midnight", () => {
    const s: SpendPauseSettings = { enabled: true, singlePurchaseThreshold: null, monthlyBudget: null, quietHours: { start: "22:00", end: "06:00" } };
    expect(evaluatePurchase(acct, txns, s, headphones, new Date("2026-11-08T23:30:00Z")).reasons).toEqual(["quiet_hours"]);
    expect(evaluatePurchase(acct, txns, s, headphones, DEMO_NOW).shouldPause).toBe(false);
  });
  it("quiet hours edges", () => {
    const q = { start: "22:00", end: "06:00" };
    expect(inQuietHours("22:00", q)).toBe(true);
    expect(inQuietHours("05:59", q)).toBe(true);
    expect(inQuietHours("06:00", q)).toBe(false);
    expect(inQuietHours("13:00", { start: "12:00", end: "14:00" })).toBe(true);
  });
});
