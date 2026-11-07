// The screens and Dial's backend must never disagree. This sends exactly what the app sends (`liveState`) through the
// backend's own parser and replay, and compares every figure with the account the screens show.
import { describe, expect, it } from "vitest";
import { contextFromState, parseClientState } from "../ai/live-state";
import { liveState } from "../assistant/live-state";
import { DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE, RESET_SPEND_PAUSE } from "../demo-config";
import { budgetStatus, monthToDateSpend, spendingSummary } from "../finance";
import { paymentOptions, recordPayment } from "../payments/rules";
import type { Payment, SpendPauseSettings, Transaction } from "../types";
import { accountWithPurchases, deriveAccount } from "./derive-account";

const key = (t: Transaction) => `${t.id}|${t.date}|${t.merchant}|${t.amount}|${t.category}|${t.status}`;
const purchase = (n: number, amount = 12000): Transaction => ({ id: `demo-${n}`, date: DEMO_TODAY, merchant: "Northwind Audio", amount, category: "Shopping", status: "pending" });
const pay = (id: string, amount: number): Payment => ({ id, amount, date: DEMO_TODAY, kind: "custom" });

function agree(purchases: Transaction[], payments: Payment[], settings: SpendPauseSettings = RESET_SPEND_PAUSE) {
  const screens = deriveAccount(purchases, payments);
  const sent = JSON.parse(JSON.stringify(liveState(screens.transactions, settings)));
  const parsed = parseClientState(sent, DEMO_TODAY);
  expect(parsed, "the backend refused what the app sends").not.toBeNull();
  const backend = contextFromState(parsed!);
  expect(backend.account).toEqual(screens.account);
  expect(backend.txns.map(key).sort()).toEqual(screens.transactions.map(key).sort());
  expect(backend.settings).toEqual(settings);
  expect(monthToDateSpend(backend.txns, DEMO_TODAY)).toBe(monthToDateSpend(screens.transactions, DEMO_TODAY));
  expect(spendingSummary(backend.txns, "2026-11-01", DEMO_TODAY)).toEqual(spendingSummary(screens.transactions, "2026-11-01", DEMO_TODAY));
  expect(budgetStatus(backend.txns, settings, DEMO_TODAY)).toEqual(budgetStatus(screens.transactions, settings, DEMO_TODAY));
}

describe("the screens and Dial's backend agree", () => {
  it("with no payment", () => agree([], []));
  it("after a partial payment", () => agree([], [pay("pay-1", 10000)]));
  it("after paying the minimum", () => agree([], [pay("pay-1", 2500)]));
  it("after paying the statement", () => agree([], [pay("pay-1", 48620)]));
  it("when the statement drops below the minimum", () => agree([], [pay("pay-1", 47620)]));
  it("after paying more than the statement", () => agree([], [pay("pay-1", 60000)]));
  it("after paying everything", () => agree([], [pay("pay-1", 106989)]));
  it("after several payments", () => agree([], [pay("pay-1", 100), pay("pay-2", 2000), pay("pay-3", 48620)]));
  it("after a payment then a purchase", () => agree([purchase(1)], [pay("pay-1", 48620)]));
  it("after paying everything, a purchase included", () => agree([purchase(1)], [pay("pay-1", 118989)]));
  it("with Spend Pause off", () => agree([], [pay("pay-1", 100)], INITIAL_SPEND_PAUSE));
  it("with nothing for Spend Pause to check", () => agree([], [], { enabled: false, singlePurchaseThreshold: null, monthlyBudget: null, quietHours: null }));
  it("after an undo, as if it never happened", () => agree([], [pay("pay-1", 100), pay("pay-2", 200)].filter((p) => p.id !== "pay-1")));

  it("both refuse paying more than is owed", () => {
    const over = 106989 + 1;
    expect(recordPayment([], accountWithPurchases([]), { id: "pay-1", amount: over, kind: "custom", date: DEMO_TODAY }).ok).toBe(false);
    expect(parseClientState({ payments: [{ id: "pay-1", date: DEMO_TODAY, amount: over }] }, DEMO_TODAY)).toBeNull();
  });

  it("at every step of 2,000 random histories", () => {
    let seed = 20261108;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    let steps = 0;
    for (let run = 0; run < 2000; run++) {
      let purchases: Transaction[] = [];
      let payments: Payment[] = [];
      let settings: SpendPauseSettings = rand(2) ? RESET_SPEND_PAUSE : INITIAL_SPEND_PAUSE;
      let next = 0;
      for (let step = 0; step < 16; step++) {
        const action = rand(10);
        if (action < 2) purchases = [...purchases, purchase(purchases.length + 1, 1 + rand(30000))];
        else if (action < 3 && payments.length) payments = payments.filter((_, i) => i !== rand(payments.length));
        else if (action < 4) settings = { ...settings, enabled: !settings.enabled };
        else {
          const { account } = deriveAccount(purchases, payments);
          const options = paymentOptions(account);
          const amount = rand(2) && options.length ? options[rand(options.length)].amount : 1 + rand(Math.max(account.currentBalance, 1));
          const result = recordPayment(payments, accountWithPurchases(purchases), { id: `pay-${run}-${next++}`, amount, kind: "custom", date: DEMO_TODAY });
          if (result.ok) payments = result.payments;
        }
        agree(purchases, payments, settings);
        steps++;
      }
    }
    expect(steps).toBe(32000);
  });
});
