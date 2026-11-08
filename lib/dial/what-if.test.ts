import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE } from "../demo-config";
import { payoffEstimate, spendingSummary } from "../finance";
import { formatPence } from "../format";
import type { InsightContext } from "../insights";
import type { Transaction } from "../types";
import type { WhatIfResult, WhatIfScenario } from "./types";
import { ESTIMATE_LINE, simulate } from "./what-if";

const seed: InsightContext = { account: SEED_ACCOUNT, txns: SEED_TRANSACTIONS, settings: INITIAL_SPEND_PAUSE, today: DEMO_TODAY };
const OCTOBER = spendingSummary(SEED_TRANSACTIONS, "2026-10-01", "2026-10-31").total;
const MONEY = /-?£[\d,]+\.\d{2}/g;

function check(r: WhatIfResult) {
  expect(r.hypothetical).toBe(true);
  expect(r.assumptions.length).toBeGreaterThan(0);
  const displays = r.figures.map((f) => f.display);
  for (const fig of r.statement.match(MONEY) ?? []) expect(displays, `"${fig}" in figures`).toContain(fig);
  for (const f of r.figures) {
    expect(Number.isInteger(f.value), f.label).toBe(true);
    expect(r.statement).toContain(f.display);
  }
  for (const text of [r.title, r.statement, ...r.assumptions]) expect(text).not.toMatch(/[\u2013\u2014]/);
  // Never advice or a promise.
  expect(r.statement).not.toMatch(/\b(should|guarantee|will be approved|eligib)/i);
}

describe("spend_less", () => {
  it("starts from October, the last full month", () => {
    const r = simulate({ kind: "spend_less", amount: 10000 }, seed);
    check(r);
    expect(OCTOBER).toBe(85327);
    expect(r.statement).toBe(`If you spend £100.00 less than October's ${formatPence(OCTOBER)}, you'd spend ${formatPence(OCTOBER - 10000)} in December.`);
    expect(r.figures.map((f) => f.value)).toEqual([10000, OCTOBER, OCTOBER - 10000]);
    expect(r.outcome).toBe("fits");
    expect(r.assumptions.join(" ")).toContain("Card payments aren't counted as spending");
  });

  it("works for one category, and calls a big cut a stretch", () => {
    const eating = spendingSummary(SEED_TRANSACTIONS.filter((t) => t.category === "Eating out"), "2026-10-01", "2026-10-31").total;
    const r = simulate({ kind: "spend_less", amount: 5000, category: "Eating out" }, seed);
    check(r);
    expect(r.figures[1].value).toBe(eating);
    expect(r.outcome).toBe(5000 * 5 <= eating ? "fits" : "stretch");
    expect(r.statement).toContain("on eating out");
  });

  it("is not possible when the cut is more than the spending", () => {
    const r = simulate({ kind: "spend_less", amount: OCTOBER + 1 }, seed);
    check(r);
    expect(r.outcome).toBe("not_possible");
    const none = simulate({ kind: "spend_less", amount: 100, category: "Travel" }, { ...seed, txns: SEED_TRANSACTIONS.filter((t) => t.category !== "Travel") });
    check(none);
    expect(none.outcome).toBe("not_possible");
    expect(simulate({ kind: "spend_less", amount: 0 }, seed).outcome).toBe("not_possible");
    expect(simulate({ kind: "spend_less", amount: -500 }, seed).outcome).toBe("not_possible");
  });

  it("needs a full month of history", () => {
    const short: Transaction[] = SEED_TRANSACTIONS.filter((t) => t.date >= "2026-10-10");
    const r = simulate({ kind: "spend_less", amount: 1000 }, { ...seed, txns: short });
    check(r);
    expect(r.outcome).toBe("not_enough_data");
  });
});

describe("save_by", () => {
  it("spreads the target over whole months from next month, rounded up", () => {
    const r = simulate({ kind: "save_by", target: 50001, by: "2027-01" }, seed);
    check(r);
    expect(r.figures.map((f) => [f.label, f.value])).toEqual([
      ["Amount to reach", 50001],
      ["Less each month", 25001],
      ["Months", 2],
      ["Spent in October", OCTOBER],
    ]);
    expect(r.statement).toContain("not money set aside in savings");
    expect(r.assumptions.join(" ")).toContain("not money in a savings account");
    expect(r.assumptions).toContain("Counts 2 months: December to January 2027.");
    expect(r.outcome).toBe("stretch"); // £250.01 a month is more than a fifth of October's £853.27
  });

  it("fits when the monthly amount is small against October", () => {
    const r = simulate({ kind: "save_by", target: 10000, by: "2026-12" }, seed);
    check(r);
    expect(r.figures[1].value).toBe(10000);
    expect(r.outcome).toBe("fits");
  });

  it("is not possible when the month is past or more than October's spending is needed", () => {
    for (const by of ["2026-10", "2026-11", "junk"]) {
      const r = simulate({ kind: "save_by", target: 10000, by } as WhatIfScenario, seed);
      check(r);
      expect(r.outcome, by).toBe("not_possible");
    }
    const big = simulate({ kind: "save_by", target: OCTOBER * 2 + 2, by: "2027-01" }, seed);
    check(big);
    expect(big.outcome).toBe("not_possible");
    expect(simulate({ kind: "save_by", target: 0, by: "2027-01" }, seed).outcome).toBe("not_possible");
  });
});

describe("pay_monthly", () => {
  it("uses payoffEstimate on the current balance and APR", () => {
    const r = simulate({ kind: "pay_monthly", amount: 20000 }, seed);
    check(r);
    const est = payoffEstimate(SEED_ACCOUNT.currentBalance, SEED_ACCOUNT.apr, 20000);
    expect(r.figures.find((f) => f.label === "Months to clear it")?.value).toBe(est.months);
    expect(r.figures.find((f) => f.label === "Interest in total")?.value).toBe(est.totalInterest);
    expect(r.outcome).toBe("fits");
    expect(r.assumptions).toContain("No new spending on the card.");
    expect(r.assumptions.join(" ")).toContain("doesn't make a payment");
  });

  it("is not possible when the payment doesn't cover the interest", () => {
    const r = simulate({ kind: "pay_monthly", amount: 500 }, seed);
    check(r);
    expect(r.outcome).toBe("not_possible");
    expect(r.statement).toContain("wouldn't cover the interest");
    expect(r.statement).toContain("less than your current minimum payment of £25.00");
  });

  it("is not possible with nothing to pay off", () => {
    const r = simulate({ kind: "pay_monthly", amount: 5000 }, { ...seed, account: { ...SEED_ACCOUNT, currentBalance: 0 } });
    check(r);
    expect(r.outcome).toBe("not_possible");
  });
});

it("every result is labelled as an estimate", () => {
  expect(ESTIMATE_LINE).toBe("This is an estimate, not a forecast.");
});
