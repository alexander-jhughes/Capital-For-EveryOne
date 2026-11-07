// What has happened in the app since the seed, sent with a question so Dial answers from the same account as the
// screens. The client only says what happened. The server checks it and works out every balance itself, so nothing
// sent here can set a figure directly, and every answer still goes through the validator.
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import type { Account, ISODate, Pence, SpendPauseSettings, Transaction } from "../types";
import { seedContext, type FactContext } from "./facts";

const MAX_EVENTS = 50;
const MAX_AMOUNT: Pence = 10_000_000;
const SAFE_ID = /^[a-z0-9-]{1,40}$/i;
/** Plain shop names only. These reach the model as facts, so nothing that could read as markup or code. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 '&.-]{0,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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

/** Everything is optional. Anything missing stays as the seed. */
export interface ClientState {
  spendPause?: SpendPauseSettings;
  purchases?: ClientPurchase[];
  payments?: ClientPayment[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPence = (v: unknown): v is Pence => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_AMOUNT;
const isOptionalPence = (v: unknown) => v === null || isPence(v);
const isDate = (v: unknown, today: ISODate): v is ISODate => {
  if (typeof v !== "string" || !ISO_DATE.test(v) || v > today) return false;
  const parsed = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
};

function isSettings(v: unknown): v is SpendPauseSettings {
  if (!isRecord(v) || typeof v.enabled !== "boolean") return false;
  if (!isOptionalPence(v.singlePurchaseThreshold) || !isOptionalPence(v.monthlyBudget)) return false;
  const quiet = v.quietHours;
  return quiet === null || (isRecord(quiet) && typeof quiet.start === "string" && typeof quiet.end === "string" && TIME.test(quiet.start) && TIME.test(quiet.end));
}

const seedIds = new Set(SEED_TRANSACTIONS.map((t) => t.id));
const isNewId = (v: unknown) => typeof v === "string" && SAFE_ID.test(v) && !seedIds.has(v);

/** The valid state, or null if any part of it isn't. A bad state is refused whole, never half used. */
export function parseClientState(value: unknown, today: ISODate): ClientState | null {
  if (!isRecord(value)) return null;
  const { spendPause, purchases = [], payments = [] } = value;
  if (spendPause !== undefined && !isSettings(spendPause)) return null;
  if (!Array.isArray(purchases) || !Array.isArray(payments) || purchases.length + payments.length > MAX_EVENTS) return null;

  const validPurchases = purchases.every(
    (p) => isRecord(p) && isNewId(p.id) && isDate(p.date, today) && isPence(p.amount) && typeof p.merchant === "string" && SAFE_NAME.test(p.merchant),
  );
  const validPayments = payments.every((p) => isRecord(p) && isNewId(p.id) && isDate(p.date, today) && isPence(p.amount));
  if (!validPurchases || !validPayments) return null;

  const ids = [...purchases, ...payments].map((p: { id: string }) => p.id);
  if (new Set(ids).size !== ids.length) return null;

  const owed = SEED_ACCOUNT.currentBalance + purchases.reduce((sum: Pence, p: ClientPurchase) => sum + p.amount, 0);
  const paid = payments.reduce((sum: Pence, p: ClientPayment) => sum + p.amount, 0);
  if (paid > owed) return null;

  return { ...(spendPause ? { spendPause: spendPause as SpendPauseSettings } : {}), purchases, payments } as ClientState;
}

function accountAfter(state: ClientState): Account {
  const purchases = state.purchases ?? [];
  const payments = [...(state.payments ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const added = purchases.reduce((sum, p) => sum + p.amount, 0);
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  const statementBalance = Math.max(SEED_ACCOUNT.statementBalance - paid, 0);
  const latest = payments.at(-1);
  return {
    ...SEED_ACCOUNT,
    currentBalance: SEED_ACCOUNT.currentBalance + added - paid,
    statementBalance,
    // Nothing more can be owed on a bill than what's left of it.
    minimumPayment: Math.min(SEED_ACCOUNT.minimumPayment, statementBalance),
    lastPayment: latest ? { amount: latest.amount, date: latest.date } : SEED_ACCOUNT.lastPayment,
  };
}

/** The account as the app sees it now. Every figure is worked out here, from the seed and the checked events. */
export function contextFromState(state: ClientState | undefined): FactContext {
  const seed = seedContext();
  if (!state) return seed;
  const purchases: Transaction[] = (state.purchases ?? []).map((p) => ({ id: p.id, date: p.date, merchant: p.merchant, amount: p.amount, category: "Shopping", status: "pending" }));
  const payments: Transaction[] = (state.payments ?? []).map((p) => ({ id: p.id, date: p.date, merchant: "Payment received", amount: -p.amount, category: "Payments", status: "pending" }));
  return { ...seed, account: accountAfter(state), txns: [...seed.txns, ...purchases, ...payments], settings: state.spendPause ?? seed.settings };
}
