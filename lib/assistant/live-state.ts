// Builds the ClientState sent with each /api/ask question (docs/AI-UI-CONTRACT.md, "Live app state").
// It sends what happened since the seed, never balances: the server works out every figure itself.
import { SEED_TRANSACTIONS } from "../data/seed";
import type { SpendPauseSettings, Transaction } from "../types";

const seedIds = new Set(SEED_TRANSACTIONS.map((t) => t.id));

export interface ClientStateBody {
  spendPause: SpendPauseSettings;
  purchases: { id: string; date: string; merchant: string; amount: number }[];
  payments: { id: string; date: string; amount: number }[];
}

/** A missing threshold or budget is null, never 0 (the server only accepts amounts above 0). */
const amountOrNull = (v: number | null) => (v && v > 0 ? v : null);

export function liveState(transactions: Transaction[], settings: SpendPauseSettings): ClientStateBody {
  const added = transactions.filter((t) => !seedIds.has(t.id));
  const isPayment = (t: Transaction) => t.category === "Payments" || t.amount < 0;
  return {
    spendPause: {
      ...settings,
      singlePurchaseThreshold: amountOrNull(settings.singlePurchaseThreshold),
      monthlyBudget: amountOrNull(settings.monthlyBudget),
    },
    purchases: added.filter((t) => !isPayment(t)).map(({ id, date, merchant, amount }) => ({ id, date, merchant, amount })),
    payments: added
      .filter(isPayment)
      .map(({ id, date, amount }) => ({ id, date, amount: Math.abs(amount) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}
