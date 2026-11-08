// Payments last for the session, so a refresh keeps them and a new session starts from the seed.
import type { Account, Payment } from "../types";
import { restorePayments } from "./rules";

export const PAYMENTS_KEY = "cfe-payments-session";

type Store = Pick<Storage, "getItem" | "setItem">;

/** sessionStorage, or null where it's blocked. Merely touching it can throw. */
export function paymentStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPayments(store: Store | null, base: Account): Payment[] {
  try {
    const raw = store?.getItem(PAYMENTS_KEY);
    return raw ? restorePayments(JSON.parse(raw), base) : [];
  } catch {
    return [];
  }
}

export function writePayments(store: Store | null, payments: Payment[]): boolean {
  try {
    if (!store) return false;
    store.setItem(PAYMENTS_KEY, JSON.stringify(payments));
    return true;
  } catch {
    return false;
  }
}
