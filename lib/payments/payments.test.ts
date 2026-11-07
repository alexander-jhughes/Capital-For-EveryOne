import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import { biggestItems, budgetStatus, dailySpend, evaluatePurchase, findPossibleDuplicates, flagTransactions, monthOverMonth, monthToDateSpend, spendingSummary, totalByMerchant } from "../finance";
import type { Payment } from "../types";
import { newPaymentId } from "./client";
import { accountAfterPayments, isNewId, parsePaymentAmount, paymentHistory, paymentOptions, paymentTransaction, recordPayment, restorePayments, type PaymentRequest } from "./rules";
import { PAYMENTS_KEY, readPayments, writePayments } from "./storage";

const BILL = SEED_ACCOUNT.statementBalance;
const pay = (id: string, amount: number, kind: Payment["kind"] = "custom"): Payment => ({ id, amount, date: DEMO_TODAY, kind });
const request = (id: string, amount: number): PaymentRequest => ({ id, amount, kind: "custom", date: DEMO_TODAY });
const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("the account after payments", () => {
  it("is unchanged with no payments, and the seed is never edited", () => {
    const before = structuredClone(SEED_ACCOUNT);
    expect(accountAfterPayments(SEED_ACCOUNT, [])).toEqual(SEED_ACCOUNT);
    accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", 100)]);
    expect(SEED_ACCOUNT).toEqual(before);
  });

  it("pays the statement: the brief's worked example", () => {
    const after = accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", 48620, "statement")]);
    expect(after.currentBalance).toBe(58369);
    expect(after.statementBalance).toBe(0);
    expect(after.minimumPayment).toBe(0);
    expect(after.lastPayment).toEqual({ amount: 48620, date: DEMO_TODAY });
    expect(after.paymentDueDate).toBe(SEED_ACCOUNT.paymentDueDate);
  });

  it("pays part of it, and the minimum stays until the bill is below it", () => {
    const after = accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", 2500, "minimum")]);
    expect(after.currentBalance).toBe(SEED_ACCOUNT.currentBalance - 2500);
    expect(after.statementBalance).toBe(BILL - 2500);
    expect(after.minimumPayment).toBe(2500);
    expect(accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", BILL - 1000)]).minimumPayment).toBe(1000);
  });

  it("pays everything, and more than the statement leaves it at £0", () => {
    const after = accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", SEED_ACCOUNT.currentBalance)]);
    expect(after.currentBalance).toBe(0);
    expect(after.statementBalance).toBe(0);
    expect(accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", BILL + 5000)]).statementBalance).toBe(0);
  });

  it("adds up several payments, and the last one is the latest", () => {
    const after = accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", 1000), pay("pay-2", 2000), pay("pay-3", 301)]);
    expect(after.currentBalance).toBe(SEED_ACCOUNT.currentBalance - 3301);
    expect(after.lastPayment.amount).toBe(301);
  });

  it("stays exact where floats wouldn't", () => {
    const after = accountAfterPayments({ ...SEED_ACCOUNT, currentBalance: 30 }, [pay("pay-1", 10), pay("pay-2", 20)]);
    expect(after.currentBalance).toBe(0);
  });
});

describe("typed amounts", () => {
  const LIMIT = SEED_ACCOUNT.currentBalance;
  const ok = (text: string, amount: number) => expect(parsePaymentAmount(text, LIMIT)).toEqual({ ok: true, amount });
  const bad = (text: string, error: RegExp) => {
    const result = parsePaymentAmount(text, LIMIT);
    expect(result.ok, text).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  };

  it("reads whole pence", () => {
    ok("50", 5000);
    ok("50.2", 5020);
    ok("50.25", 5025);
    ok("486.20", 48620);
    ok("£486.20", 48620);
    ok("1,069.89", LIMIT);
    ok(" 12 ", 1200);
    ok(".5", 50);
    ok("0.01", 1);
    ok("19.99", 1999);
    ok("4.35", 435);
    ok("1.10", 110);
  });

  it("refuses empty, zero and negative amounts", () => {
    bad("", /Enter an amount/);
    bad("   ", /Enter an amount/);
    bad("0", /above £0/);
    bad("0.00", /above £0/);
    bad("-5", /above £0/);
    bad("-0.01", /above £0/);
  });

  it("refuses malformed amounts", () => {
    for (const text of ["abc", "12abc", "1e3", "NaN", "Infinity", "1.2.3", ".", "£", "5.", "1,23", "12,34.50", "0x10", "+5", "£-5", "1 000"]) bad(text, /numbers only/);
  });

  it("refuses more than 2 decimal places", () => {
    bad("10.123", /2 decimal/);
    bad("10.000", /2 decimal/);
  });

  it("refuses more than can be paid, even an absurd amount", () => {
    bad("1069.90", /up to your current balance of £1,069\.89/);
    bad("99999999999999999999", /up to your current balance/);
  });
});

describe("suggested amounts", () => {
  const ids = (a = SEED_ACCOUNT) => paymentOptions(a).map((o) => [o.id, o.amount]);

  it("come from the account", () => {
    expect(ids()).toEqual([["statement", BILL], ["minimum", 2500], ["current", SEED_ACCOUNT.currentBalance]]);
  });

  it("follow the live account after a payment", () => {
    expect(ids(accountAfterPayments(SEED_ACCOUNT, [pay("pay-1", BILL)]))).toEqual([["current", 58369]]);
  });

  it("never repeat an amount", () => {
    expect(ids({ ...SEED_ACCOUNT, currentBalance: BILL })).toEqual([["statement", BILL], ["minimum", 2500]]);
    expect(ids({ ...SEED_ACCOUNT, statementBalance: 2000, minimumPayment: 2000 })).toEqual([["statement", 2000], ["current", SEED_ACCOUNT.currentBalance]]);
  });

  it("are never more than the balance, and there are none at £0", () => {
    expect(ids({ ...SEED_ACCOUNT, currentBalance: 1000 })).toEqual([["statement", 1000]]);
    expect(ids({ ...SEED_ACCOUNT, currentBalance: 0, statementBalance: 0, minimumPayment: 0 })).toEqual([]);
  });

  it("record the kinds the frozen type allows", () => {
    expect(paymentOptions(SEED_ACCOUNT).map((o) => o.kind)).toEqual(["statement", "minimum", "custom"]);
  });
});

describe("recording a payment", () => {
  it("adds one payment with the given id", () => {
    const result = recordPayment([], SEED_ACCOUNT, request("pay-1", 5000));
    expect(result).toMatchObject({ ok: true, repeat: false, payment: { id: "pay-1", amount: 5000 } });
  });

  it("can't pay the same id twice", () => {
    const first = recordPayment([], SEED_ACCOUNT, request("pay-1", 5000));
    if (!first.ok) throw new Error("expected a payment");
    const second = recordPayment(first.payments, SEED_ACCOUNT, request("pay-1", 5000));
    expect(second).toMatchObject({ ok: true, repeat: true });
    if (second.ok) expect(second.payments).toBe(first.payments);
  });

  it("can't pay more than is left, counting earlier payments", () => {
    const result = recordPayment([pay("pay-1", SEED_ACCOUNT.currentBalance - 100)], SEED_ACCOUNT, request("pay-2", 101));
    expect(result).toEqual({ ok: false, message: "That's more than your current balance of £1.00. Nothing has been paid." });
    expect(recordPayment([pay("pay-1", SEED_ACCOUNT.currentBalance)], SEED_ACCOUNT, request("pay-2", 1)).ok).toBe(false);
  });

  it("refuses amounts and ids the backend would refuse", () => {
    for (const amount of [0, -1, 10.5, Number.NaN, Infinity]) expect(recordPayment([], SEED_ACCOUNT, request("pay-1", amount)).ok).toBe(false);
    for (const id of ["t001", "has space", "a".repeat(41), ""]) expect(recordPayment([], SEED_ACCOUNT, request(id, 100)).ok).toBe(false);
  });

  it("makes ids the backend accepts, and doesn't repeat them", () => {
    const ids = Array.from({ length: 500 }, newPaymentId);
    expect(new Set(ids).size).toBe(500);
    expect(ids.every(isNewId)).toBe(true);
  });
});

describe("financial integrity", () => {
  const paid = [pay("pay-1", BILL, "statement"), pay("pay-2", 2500, "minimum")];
  const txns = [...SEED_TRANSACTIONS, ...paid.map(paymentTransaction)];
  const FROM = "2026-11-01";

  it("a payment is its own kind of transaction", () => {
    expect(paymentTransaction(paid[0])).toEqual({ id: "pay-1", date: DEMO_TODAY, merchant: "Payment received", amount: -BILL, category: "Payments", status: "pending" });
    const flags = flagTransactions(txns).get("pay-1");
    expect(flags).toMatchObject({ payment: true, refund: false, pending: true });
  });

  it("leaves purchase spending at £402.35", () => {
    expect(monthToDateSpend(txns, DEMO_TODAY)).toBe(40235);
    expect(monthToDateSpend(txns, DEMO_TODAY)).toBe(monthToDateSpend(SEED_TRANSACTIONS, DEMO_TODAY));
  });

  it("leaves every other total alone", () => {
    expect(spendingSummary(txns, FROM, DEMO_TODAY)).toEqual(spendingSummary(SEED_TRANSACTIONS, FROM, DEMO_TODAY));
    expect(spendingSummary(txns, FROM, DEMO_TODAY).byCategory.map((c) => c.category)).not.toContain("Payments");
    expect(monthOverMonth(txns, DEMO_TODAY)).toEqual(monthOverMonth(SEED_TRANSACTIONS, DEMO_TODAY));
    expect(dailySpend(txns, FROM, DEMO_TODAY)).toEqual(dailySpend(SEED_TRANSACTIONS, FROM, DEMO_TODAY));
    expect(biggestItems(txns, 5)).toEqual(biggestItems(SEED_TRANSACTIONS, 5));
    expect(findPossibleDuplicates(txns)).toEqual(findPossibleDuplicates(SEED_TRANSACTIONS));
    expect(totalByMerchant(txns, "Payment received")).toEqual({ merchant: "Payment received", total: 0, count: 0 });
    expect(budgetStatus(txns, RESET_SPEND_PAUSE, DEMO_TODAY)).toEqual(budgetStatus(SEED_TRANSACTIONS, RESET_SPEND_PAUSE, DEMO_TODAY));
  });

  it("two equal payments aren't flagged as a duplicate purchase", () => {
    const same = [...SEED_TRANSACTIONS, paymentTransaction(pay("pay-1", 5000)), paymentTransaction(pay("pay-2", 5000))];
    expect(flagTransactions(same).get("pay-2")?.possibleDuplicate).toBe(false);
  });

  it("a payment doesn't change what a purchase is checked against", () => {
    const purchase = { id: "p1", merchant: "Shop", item: "Thing", amount: 12000, createdAt: DEMO_NOW.toISOString() };
    const before = evaluatePurchase(SEED_ACCOUNT, SEED_TRANSACTIONS, RESET_SPEND_PAUSE, purchase, DEMO_NOW);
    const after = evaluatePurchase(accountAfterPayments(SEED_ACCOUNT, paid), txns, RESET_SPEND_PAUSE, purchase, DEMO_NOW);
    expect(after.reasons).toEqual(before.reasons);
    expect(after.budgetRemainingAfter).toBe(before.budgetRemainingAfter);
    expect(after.balanceAfter).toBe(before.balanceAfter - BILL - 2500);
  });

  it("history lists every payment, newest first, and no purchases", () => {
    expect(paymentHistory(txns).map((t) => t.id)).toEqual(["pay-2", "pay-1", SEED_TRANSACTIONS.find((t) => t.category === "Payments")?.id]);
  });
});

describe("saved payments", () => {
  const list = [pay("pay-1", 5000), pay("pay-2", 2500)];

  it("survive a refresh, in order", () => {
    const store = memory();
    expect(writePayments(store, list)).toBe(true);
    expect(readPayments(store, SEED_ACCOUNT)).toEqual(list);
  });

  it("are all ignored if anything is wrong, so a balance is never half restored", () => {
    const damaged: unknown[] = [
      "nope",
      null,
      { a: 1 },
      [...list, null],
      [...list, list[0]],
      [pay("t001", 100)],
      [pay("pay-1", 0)],
      [pay("pay-1", -5)],
      [pay("pay-1", 1.5)],
      [{ ...list[0], kind: "other" }],
      [{ ...list[0], date: "soon" }],
      [pay("pay-1", SEED_ACCOUNT.currentBalance + 1)],
    ];
    for (const value of damaged) expect(restorePayments(value, SEED_ACCOUNT)).toEqual([]);
  });

  it("start empty when storage is damaged or blocked", () => {
    expect(readPayments(memory({ [PAYMENTS_KEY]: "{oops" }), SEED_ACCOUNT)).toEqual([]);
    expect(readPayments(null, SEED_ACCOUNT)).toEqual([]);
    expect(readPayments(broken, SEED_ACCOUNT)).toEqual([]);
    expect(writePayments(broken, list)).toBe(false);
    expect(writePayments(null, list)).toBe(false);
  });
});
