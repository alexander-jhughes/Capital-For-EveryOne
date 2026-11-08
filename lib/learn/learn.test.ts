import { describe, expect, it } from "vitest";
import { payoffEstimate } from "../finance";
import { SEED_ACCOUNT } from "../data/seed";
import {
  balanceForUtilisation,
  durationText,
  illustrativeMinimum,
  MAX_MONTHS,
  monthlyInterest,
  repay,
  utilisationPercent,
} from "./credit";
import { QUIZ, quizProgress, sanitizeAnswers, shuffledOptions } from "./quiz";

describe("utilisation", () => {
  it("is the balance as a whole-number share of the limit", () => {
    expect(utilisationPercent(106989, 150000)).toBe(71);
    expect(utilisationPercent(30000, 100000)).toBe(30);
    expect(utilisationPercent(0, 150000)).toBe(0);
  });
  it("handles no limit, a credit balance and going over the limit", () => {
    expect(utilisationPercent(1000, 0)).toBeNull();
    expect(utilisationPercent(1000, -5)).toBeNull();
    expect(utilisationPercent(-500, 1000)).toBe(0);
    expect(utilisationPercent(160000, 150000)).toBe(107);
  });
  it("gives the highest balance under a target, never a fraction of a penny", () => {
    expect(balanceForUtilisation(150000, 30)).toBe(45000);
    expect(balanceForUtilisation(99999, 30)).toBe(29999);
    expect(utilisationPercent(balanceForUtilisation(99999, 30), 99999)).toBeLessThanOrEqual(30);
  });
});

describe("interest and minimum payments", () => {
  it("charges APR / 12 a month, rounded to the penny", () => {
    expect(monthlyInterest(100000, 24)).toBe(2000);
    expect(monthlyInterest(48620, 24.9)).toBe(1009);
    expect(monthlyInterest(0, 24.9)).toBe(0);
    expect(monthlyInterest(-100, 24.9)).toBe(0);
    expect(monthlyInterest(100000, 0)).toBe(0);
  });
  it("uses the £25 floor on small balances and 1% plus interest on large ones, never more than owed", () => {
    expect(illustrativeMinimum(48620, 24.9)).toBe(2500);
    expect(illustrativeMinimum(500000, 24)).toBe(5000 + 10000);
    expect(illustrativeMinimum(1000, 24)).toBe(1000 + 20);
    expect(illustrativeMinimum(0, 24)).toBe(0);
  });
});

describe("repay", () => {
  it("matches the app's payoff estimate for a fixed payment", () => {
    for (const [bal, apr, pay] of [
      [48620, 24.9, 2500],
      [106989, 24.9, 10000],
      [250000, 34.9, 15000],
    ] as const) {
      const a = repay(bal, apr, { kind: "fixed", amount: pay });
      const b = payoffEstimate(bal, apr, pay);
      expect(a.months).toBe(b.months);
      expect(a.totalInterest).toBe(b.totalInterest);
      expect(a.totalPaid).toBe(bal + (a.totalInterest ?? 0));
    }
  });
  it("never clears when the payment doesn't cover the interest", () => {
    const r = repay(100000, 24, { kind: "fixed", amount: 2000 });
    expect(r.neverClears).toBe(true);
    expect(r.months).toBeNull();
  });
  it("pays off at the minimum, and an extra payment clears it sooner for less interest", () => {
    const min = repay(SEED_ACCOUNT.statementBalance, SEED_ACCOUNT.apr, { kind: "minimum" });
    const more = repay(SEED_ACCOUNT.statementBalance, SEED_ACCOUNT.apr, { kind: "minimum", extra: 2500 });
    expect(min.months).not.toBeNull();
    expect(more.months!).toBeLessThan(min.months!);
    expect(more.totalInterest!).toBeLessThan(min.totalInterest!);
    expect(min.firstPayment).toBe(2500);
  });
  it("handles a zero balance, huge balances and the 50-year cap", () => {
    expect(repay(0, 24.9, { kind: "minimum" }).months).toBe(0);
    const huge = repay(1_000_000_00, 99, { kind: "minimum" });
    expect(huge.months === null || huge.months <= MAX_MONTHS).toBe(true);
    const slow = repay(10_000_000, 24, { kind: "fixed", amount: 200_001 });
    expect(slow.months).toBeNull();
    expect(slow.neverClears).toBe(false);
  });
  it("records the balance each year, ending at zero", () => {
    const r = repay(48620, 24.9, { kind: "minimum" });
    expect(r.yearly[0]).toEqual({ month: 0, balance: 48620 });
    expect(r.yearly.at(-1)).toEqual({ month: r.months, balance: 0 });
  });
});

describe("durationText", () => {
  it("reads naturally", () => {
    expect(durationText(23)).toBe("1 year and 11 months");
    expect(durationText(12)).toBe("1 year");
    expect(durationText(1)).toBe("1 month");
    expect(durationText(null)).toBe("more than 50 years");
  });
});

describe("quiz", () => {
  it("has well-formed questions with unique ids", () => {
    expect(new Set(QUIZ.map((q) => q.id)).size).toBe(QUIZ.length);
    for (const q of QUIZ) expect(q.answer).toBeLessThan(q.options.length);
  });
  it("states the seed account's figures correctly", () => {
    expect(SEED_ACCOUNT.creditLimit - SEED_ACCOUNT.currentBalance).toBe(43011);
    expect(QUIZ.find((q) => q.id === "available")!.options[0]).toBe("£430.11");
  });
  it("shows every option once, in a fixed order", () => {
    for (const q of QUIZ) {
      const order = shuffledOptions(q);
      expect(order.map((o) => o.index).sort()).toEqual(q.options.map((_, i) => i));
      expect(shuffledOptions(q)).toEqual(order);
    }
    expect(QUIZ.some((q) => shuffledOptions(q)[0].index !== q.answer)).toBe(true);
  });
  it("keeps only valid saved answers and scores them", () => {
    const saved = sanitizeAnswers({ apr: 0, pending: 1, unknown: 0, utilisation: 9, minimum: "0" });
    expect(saved).toEqual({ apr: 0, pending: 1 });
    expect(quizProgress(saved)).toEqual({ answered: 2, correct: 1, total: QUIZ.length });
    expect(sanitizeAnswers(null)).toEqual({});
    expect(sanitizeAnswers([1])).toEqual({});
  });
});
