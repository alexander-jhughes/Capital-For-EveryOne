// Spend Pause state transitions. Pure, so every rule here is tested without a browser.
// lib/state/account-context.tsx owns the state; this file only says how it may change.
import type { Pence, PendingPurchase, SpendPauseSettings, Transaction } from "../types";

export type PauseOutcome = "go" | "cancel";

/** One finished purchase, kept for the session so the person can see what they decided. */
export interface PauseRecord {
  purchase: PendingPurchase;
  outcome: PauseOutcome;
  /** True if Dial stopped to check first. False if the purchase simply went through. */
  checked: boolean;
}

export interface SpendPauseState {
  settings: SpendPauseSettings;
  /** The purchase waiting for an answer. At most one at a time. */
  pendingPurchase: PendingPurchase | null;
  /** Whether the waiting purchase needs the check, as opposed to going straight through. */
  pendingChecked: boolean;
  /** Purchases the person went ahead with, as transactions. Seed transactions are never edited. */
  purchases: Transaction[];
  history: PauseRecord[];
}

export type SpendPauseAction =
  | { type: "restore"; settings?: SpendPauseSettings; session?: Pick<SpendPauseState, "pendingPurchase" | "pendingChecked" | "purchases" | "history"> }
  | { type: "update-settings"; settings: SpendPauseSettings }
  | { type: "hold-purchase"; purchase: PendingPurchase; checked: boolean }
  | { type: "resolve-purchase"; id: string; outcome: PauseOutcome };

export const initialSpendPauseState = (settings: SpendPauseSettings): SpendPauseState => ({
  settings,
  pendingPurchase: null,
  pendingChecked: false,
  purchases: [],
  history: [],
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const toTransaction = (purchase: PendingPurchase): Transaction => ({
  id: purchase.id,
  date: purchase.createdAt.slice(0, 10),
  merchant: purchase.merchant,
  amount: purchase.amount,
  category: "Shopping",
  status: "pending",
});

/** Every transition is safe to repeat: a double tap can't charge twice or flip a setting back. */
export function spendPauseReducer(state: SpendPauseState, action: SpendPauseAction): SpendPauseState {
  switch (action.type) {
    case "restore":
      return { ...state, ...action.session, settings: action.settings ?? state.settings };
    case "update-settings":
      return same(state.settings, action.settings) ? state : { ...state, settings: action.settings };
    case "hold-purchase":
      return state.pendingPurchase ? state : { ...state, pendingPurchase: action.purchase, pendingChecked: action.checked };
    case "resolve-purchase": {
      const purchase = state.pendingPurchase;
      if (!purchase || purchase.id !== action.id) return state;
      return {
        ...state,
        pendingPurchase: null,
        pendingChecked: false,
        purchases: action.outcome === "go" ? [...state.purchases, toTransaction(purchase)] : state.purchases,
        history: [{ purchase, outcome: action.outcome, checked: state.pendingChecked }, ...state.history],
      };
    }
  }
}

/** What approved purchases add to the balance. A cancelled or waiting purchase adds nothing. */
export const purchasesTotal = (purchases: Transaction[]): Pence => purchases.reduce((total, t) => total + t.amount, 0);
