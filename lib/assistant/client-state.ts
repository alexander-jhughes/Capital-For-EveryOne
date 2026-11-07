// What has happened in the app since the seed, sent with each question so Dial answers from the same account as the
// screens. Events only, never balances: the server works out every figure itself. Matches the `ClientState` proposal in
// docs/AI-UI-CONTRACT.md (lib/ai/live-state.ts on the backend). `spendPauseActivity` is an additive proposal on top of it.
import type { SpendPauseActivity } from "../spend-pause/state";
import type { ISODate, Pence, SpendPauseSettings, Transaction } from "../types";

export interface ClientPurchase {
  id: string;
  date: ISODate;
  merchant: string;
  amount: Pence;
}

export interface ClientPayment {
  id: string;
  date: ISODate;
  amount: Pence;
}

export interface ClientState {
  spendPause: SpendPauseSettings;
  /** Not read by the backend yet, and safely ignored until it is. */
  spendPauseActivity: SpendPauseActivity;
  purchases: ClientPurchase[];
  payments: ClientPayment[];
}

export function toClientState({
  settings,
  activity,
  purchases,
  payments = [],
}: {
  settings: SpendPauseSettings;
  activity: SpendPauseActivity;
  purchases: Transaction[];
  /** Oldest first: the backend treats the last one as the latest. */
  payments?: ClientPayment[];
}): ClientState {
  return {
    spendPause: settings,
    spendPauseActivity: activity,
    purchases: purchases.map(({ id, date, merchant, amount }) => ({ id, date, merchant, amount })),
    payments: payments.map(({ id, date, amount }) => ({ id, date, amount })),
  };
}
