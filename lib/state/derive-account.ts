// The account every screen sees, worked out from the seed and what has happened since. Pure, so the tests can compare
// exactly this against the backend's replay in lib/ai/live-state.ts.
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { accountAfterPayments, paymentTransaction } from "../payments/rules";
import { purchasesTotal } from "../spend-pause/state";
import type { Account, Payment, Transaction } from "../types";

// evaluatePurchase promises this balance before the person decides, so an approved purchase has to deliver it.
export const accountWithPurchases = (purchases: Transaction[]): Account => ({ ...SEED_ACCOUNT, currentBalance: SEED_ACCOUNT.currentBalance + purchasesTotal(purchases) });

export const deriveAccount = (purchases: Transaction[], payments: Payment[]) => ({
  account: accountAfterPayments(accountWithPurchases(purchases), payments),
  transactions: [...SEED_TRANSACTIONS, ...purchases, ...payments.map(paymentTransaction)],
});
