// Saved Spend Pause state. Settings last between visits; purchases last for the session.
// Everything read is checked, because storage can be old, edited or blocked, and the app must still work.
import type { PendingPurchase, SpendPauseSettings, Transaction } from "../types";
import type { PauseRecord, SpendPauseActivity, SpendPauseState } from "./state";

export const SETTINGS_KEY = "cfe-spend-pause-settings";
export const SESSION_KEY = "cfe-spend-pause-session";
export const ACTIVITY_KEY = "cfe-spend-pause-activity";

type Store = Pick<Storage, "getItem" | "setItem">;
export type SessionState = Pick<SpendPauseState, "pendingPurchase" | "pendingChecked" | "purchases" | "history">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPence = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isTime = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function isSettings(v: unknown): v is SpendPauseSettings {
  if (!isRecord(v) || typeof v.enabled !== "boolean") return false;
  const quiet = v.quietHours;
  return (
    (v.singlePurchaseThreshold === null || isPence(v.singlePurchaseThreshold)) &&
    (v.monthlyBudget === null || isPence(v.monthlyBudget)) &&
    (quiet === null || (isRecord(quiet) && isTime(quiet.start) && isTime(quiet.end)))
  );
}

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

export function readSettings(store: Store | null): SpendPauseSettings | undefined {
  const saved = read(store, SETTINGS_KEY);
  return isSettings(saved) ? saved : undefined;
}

export const writeSettings = (store: Store | null, settings: SpendPauseSettings) => write(store, SETTINGS_KEY, settings);

const isStamp = (v: unknown) => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));

export function readActivity(store: Store | null): SpendPauseActivity | undefined {
  const saved = read(store, ACTIVITY_KEY);
  if (!isRecord(saved) || !isStamp(saved.activatedAt) || !isStamp(saved.deactivatedAt)) return undefined;
  return { activatedAt: saved.activatedAt as string | null, deactivatedAt: saved.deactivatedAt as string | null };
}

export const writeActivity = (store: Store | null, activity: SpendPauseActivity) => write(store, ACTIVITY_KEY, activity);

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
