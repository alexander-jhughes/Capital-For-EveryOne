// Browser side of the account API (app/api/*, logic in lib/server). The server is the source of truth: every call
// returns the whole derived state and the caller replaces its copy. Nothing here works out a balance.
import type { AccountStateBody } from "../server/account";
import type { Goal } from "../dial/types";
import type { Payment, PendingPurchase, SpendPauseSettings } from "../types";

export type ApiResult = { ok: true; state: AccountStateBody } | { ok: false; status: number; message: string };

const FAILED = "Your changes couldn't be saved. They'll last until you reload.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPence = (v: unknown) => Number.isInteger(v);

/** The server's state if it has the right shape. The figures themselves are the server's to get right. */
export function parseAccountState(v: unknown): AccountStateBody | null {
  if (!isRecord(v) || !isRecord(v.account) || !isRecord(v.settings) || !isRecord(v.spendPauseActivity)) return null;
  const { account } = v;
  if (!isPence(account.currentBalance) || !isPence(account.statementBalance) || !isPence(account.minimumPayment)) return null;
  if (![v.transactions, v.payments, v.purchases, v.goals].every(Array.isArray)) return null;
  return v as unknown as AccountStateBody;
}

async function call(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<ApiResult> {
  try {
    const res = await fetchImpl(path, { ...init, headers: { "Content-Type": "application/json", ...init.headers }, cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = isRecord(body) && typeof body.error === "string" ? body.error : FAILED;
      return { ok: false, status: res.status, message };
    }
    const state = parseAccountState(body);
    return state ? { ok: true, state } : { ok: false, status: 0, message: FAILED };
  } catch {
    return { ok: false, status: 0, message: FAILED };
  }
}

const jsonBody = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs calls one after another. Every change rewrites the one session cookie, so two in flight at once would each
 * start from the same cookie and the second would wipe out the first. Reads queue too, so they see the latest write.
 */
export function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export const accountApi = {
  load: () => enqueue(() => call("/api/account")),
  pay: (payment: Pick<Payment, "id" | "amount" | "kind">) => enqueue(() => call("/api/payments", jsonBody("POST", payment))),
  undo: (id: string) => enqueue(() => call(`/api/payments/${encodeURIComponent(id)}`, { method: "DELETE" })),
  settings: (settings: SpendPauseSettings) => enqueue(() => call("/api/spend-pause", jsonBody("PUT", { settings }))),
  purchase: (purchase: PendingPurchase) => enqueue(() => call("/api/purchases", jsonBody("POST", { purchase }))),
  loadGoals: () => enqueue(() => call("/api/goals")),
  /** The goals are read when the call runs, not when it is queued, so it always sends the newest list. */
  goals: (goals: () => Goal[]) => enqueue(() => call("/api/goals", jsonBody("PUT", { goals: goals() }))),
};

export type AccountApi = typeof accountApi;
