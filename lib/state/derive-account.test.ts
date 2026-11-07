import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { monthToDateSpend } from "../finance";
import type { Payment, Transaction } from "../types";
import { deriveAccount } from "./derive-account";

const purchase: Transaction = { id: "demo-1", date: DEMO_TODAY, merchant: "Northwind Audio", amount: 12000, category: "Shopping", status: "pending" };
const pay = (id: string, amount: number): Payment => ({ id, amount, date: DEMO_TODAY, kind: "custom" });

describe("one account from purchases and payments", () => {
  it("is the seed with nothing added", () => {
    expect(deriveAccount([], [])).toEqual({ account: SEED_ACCOUNT, transactions: SEED_TRANSACTIONS });
  });

  it("a payment after a purchase: the purchase isn't on the bill, and spending counts only the purchase", () => {
    const { account, transactions } = deriveAccount([purchase], [pay("pay-1", 48620)]);
    expect(account.currentBalance).toBe(70369);
    expect(account.statementBalance).toBe(0);
    expect(monthToDateSpend(transactions, DEMO_TODAY)).toBe(40235 + 12000);
  });

  it("the balance can be paid in full with a purchase on it", () => {
    expect(deriveAccount([purchase], [pay("pay-1", SEED_ACCOUNT.currentBalance + 12000)]).account.currentBalance).toBe(0);
  });

  it("the order of events doesn't change the figures", () => {
    const [a, b] = [pay("pay-1", 100), pay("pay-2", 200)];
    expect(deriveAccount([purchase], [a, b]).account.currentBalance).toBe(deriveAccount([purchase], [b, a]).account.currentBalance);
  });

  it("gives every transaction a unique id", () => {
    const { transactions } = deriveAccount([purchase], [pay("pay-1", 100), pay("pay-2", 200)]);
    expect(new Set(transactions.map((t) => t.id)).size).toBe(transactions.length);
  });
});
