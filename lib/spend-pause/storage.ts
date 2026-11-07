// This tab's Spend Pause state: the purchase waiting for an answer and what was decided this session. Settings,
// activity and approved purchases are the server's (lib/server), so a payment can be checked against them.
// Everything read is checked, because storage can be old, edited or blocked, and the app must still work.
import type { PendingPurchase, Transaction } from "../types";
import type { PauseRecord, SpendPauseState } from "./state";

export const SESSION_KEY = "cfe-spend-pause-session";

type Store = Pick<Storage, "getItem" | "setItem">;
export type SessionState = Pick<SpendPauseState, "pendingPurchase" | "pendingChecked" | "purchases" | "history">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPence = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

const isPurchase = (v: unknown): v is PendingPurchase =>
  isRecord(v) && typeof v.id === "string" && typeof v.merchant === "string" && typeof v.item === "string" && isPence(v.amount) && typeof v.createdAt === "string";

const isTransaction = (v: unknown): v is Transaction =>
  isRecord(v) && typeof v.id === "string" && typeof v.date === "string" && typeof v.merchant === "string" && isPence(v.amount) && v.status === "pending";

const isPauseRecord = (v: unknown): v is PauseRecord =>
  isRecord(v) && isPurchase(v.purchase) && (v.outcome === "go" || v.outcome === "cancel") && typeof v.checked === "boolean";

function read(store: Store | null, key: string): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function write(store: Store | null, key: string, value: unknown): boolean {
  try {
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readSession(store: Store | null): SessionState | undefined {
  const saved = read(store, SESSION_KEY);
  if (!isRecord(saved)) return undefined;
  const { pendingPurchase, pendingChecked, purchases, history } = saved;
  const valid =
    (pendingPurchase === null || isPurchase(pendingPurchase)) &&
    typeof pendingChecked === "boolean" &&
    Array.isArray(purchases) &&
    purchases.every(isTransaction) &&
    Array.isArray(history) &&
    history.every(isPauseRecord);
  return valid ? { pendingPurchase, pendingChecked, purchases, history } as SessionState : undefined;
}

export const writeSession = (store: Store | null, session: SessionState) => write(store, SESSION_KEY, session);

/** Browser storage, or null where it's blocked. Merely touching window.localStorage can throw. */
export function browserStore(name: "localStorage" | "sessionStorage"): Store | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}
