// Pay and Dial's backend must never disagree. Sends what the app sends (`liveState`) through the backend's own parser
// and replay, and compares every figure with the account the screens show.
import { describe, expect, it } from "vitest";
import { contextFromState, parseClientState } from "../ai/live-state";
import { liveState } from "../assistant/live-state";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import { monthToDateSpend } from "../finance";
import type { Payment } from "../types";
import { accountAfterPayments, paymentTransaction, recordPayment } from "./rules";

const pay = (id: string, amount: number): Payment => ({ id, amount, date: DEMO_TODAY, kind: "custom" });

function agree(payments: Payment[]) {
  const account = accountAfterPayments(SEED_ACCOUNT, payments);
  const transactions = [...SEED_TRANSACTIONS, ...payments.map(paymentTransaction)];
  const parsed = parseClientState(JSON.parse(JSON.stringify(liveState(transactions, RESET_SPEND_PAUSE))), DEMO_TODAY);
  expect(parsed, "the backend refused what the app sends").not.toBeNull();
  const backend = contextFromState(parsed!);
  expect(backend.account).toEqual(account);
  expect(backend.txns.map((t) => JSON.stringify(t)).sort()).toEqual(transactions.map((t) => JSON.stringify(t)).sort());
  expect(monthToDateSpend(backend.txns, DEMO_TODAY)).toBe(40235);
}

describe("Pay and Dial's backend agree", () => {
  it("with no payment", () => agree([]));
  it("after a partial payment", () => agree([pay("pay-1", 10000)]));
  it("after the minimum, which stays £25", () => agree([pay("pay-1", 2500)]));
  it("after the statement: £583.69 left, statement and minimum £0", () => agree([pay("pay-1", 48620)]));
  it("when the statement drops below the minimum", () => agree([pay("pay-1", 47620)]));
  it("after paying everything", () => agree([pay("pay-1", 106989)]));
  it("after several payments, the last one latest", () => agree([pay("pay-1", 100), pay("pay-2", 2000), pay("pay-3", 301)]));

  it("at every step of 1,000 random histories with undo", () => {
    let seed = 8112026;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    for (let run = 0; run < 1000; run++) {
      let payments: Payment[] = [];
      for (let step = 0; step < 10; step++) {
        if (rand(4) === 0 && payments.length) payments = payments.filter((_, i) => i !== rand(payments.length));
        else {
          const left = accountAfterPayments(SEED_ACCOUNT, payments).currentBalance;
          const result = recordPayment(payments, SEED_ACCOUNT, { id: `pay-${run}-${step}`, amount: 1 + rand(Math.max(left, 1)), kind: "custom", date: DEMO_TODAY });
          if (result.ok) payments = result.payments;
        }
        agree(payments);
      }
    }
  });
});
