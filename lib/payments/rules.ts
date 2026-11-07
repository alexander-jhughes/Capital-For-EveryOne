// Card payment rules. Pure, integer pence, no browser. lib/state/account-context.tsx owns the state; this says how it
// may change. The account is always worked out from events, the same way the backend replays them in lib/ai/live-state.ts.
import { SEED_TRANSACTIONS } from "../data/seed";
import { formatPence } from "../format";
import type { Account, ISODate, Payment, Pence, Transaction } from "../types";

/** The backend refuses anything above this, and nothing on this account can reach it. */
const MAX_AMOUNT: Pence = 10_000_000;
/** The backend's rule for new event IDs. */
const SAFE_ID = /^[a-z0-9-]{1,40}$/i;
const seedIds = new Set(SEED_TRANSACTIONS.map((t) => t.id));

const isDate = (v: unknown): v is ISODate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isAmount = (v: unknown): v is Pence => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_AMOUNT;
export const isNewId = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v) && !seedIds.has(v);

/** The account after these payments, oldest first. Must stay the same as `accountAfter` on the backend. */
export function accountAfterPayments(base: Account, payments: Payment[]): Account {
  const paid = payments.reduce((total, p) => total + p.amount, 0);
  const statementBalance = Math.max(base.statementBalance - paid, 0);
  const latest = payments.at(-1);
  return {
    ...base,
    currentBalance: base.currentBalance - paid,
    statementBalance,
    // Nothing more can be owed on a bill than what's left of it.
    minimumPayment: Math.min(base.minimumPayment, statementBalance),
    lastPayment: latest ? { amount: latest.amount, date: latest.date } : base.lastPayment,
  };
}

/** A payment as the transaction list shows it. Category `Payments` keeps it out of every spending total. */
export const paymentTransaction = (p: Payment): Transaction => ({
  id: p.id,
  date: p.date,
  merchant: "Payment received",
  amount: -p.amount,
  category: "Payments",
  status: "pending",
});

export type AmountResult = { ok: true; amount: Pence } | { ok: false; error: string };

/** A typed amount, to whole pence, without ever holding money in a float. `limit` is the most that can be paid. */
export function parsePaymentAmount(text: string, limit: Pence): AmountResult {
  const typed = text.trim();
  if (typed === "") return { ok: false, error: "Enter an amount, like 50 or 50.25." };
  if (/^[-−]/.test(typed)) return { ok: false, error: "Enter an amount above £0." };
  const match = typed.match(/^£?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?$/);
  if (!match || (match[1] === "" && !match[2])) return { ok: false, error: "Enter numbers only, like 50 or 50.25." };
  if ((match[2] ?? "").length > 2) return { ok: false, error: "Use no more than 2 decimal places." };
  const whole = match[1].replace(/,/g, "") || "0";
  const tooMuch = { ok: false as const, error: `You can pay up to your current balance of ${formatPence(limit)}.` };
  if (whole.replace(/^0+/, "").length > 8) return tooMuch;
  const amount = Number(whole) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (amount <= 0) return { ok: false, error: "Enter an amount above £0." };
  return amount > limit ? tooMuch : { ok: true, amount };
}

export interface PaymentOption {
  id: "statement" | "minimum" | "current";
  /** The frozen `Payment["kind"]` has no value for the full balance, so that one is recorded as `custom`. */
  kind: Payment["kind"];
  amount: Pence;
  label: string;
}

/** Suggested amounts from the live account. Never more than can be paid, and never the same amount twice. */
export function paymentOptions(account: Account): PaymentOption[] {
  const most = account.currentBalance;
  if (most <= 0) return [];
  const all: PaymentOption[] = [
    { id: "statement", kind: "statement", amount: Math.min(account.statementBalance, most), label: "Statement balance" },
    { id: "minimum", kind: "minimum", amount: Math.min(account.minimumPayment, most), label: "Minimum payment" },
    { id: "current", kind: "custom", amount: most, label: "Full current balance" },
  ];
  return all.filter((o, i) => o.amount > 0 && all.findIndex((other) => other.amount === o.amount) === i);
}

export interface PaymentRequest {
  id: string;
  amount: Pence;
  kind: Payment["kind"];
  date: ISODate;
}

export type PaymentResult =
  /** `repeat` means this id was already paid: nothing changed, and the first payment is returned. */
  | { ok: true; payment: Payment; payments: Payment[]; repeat: boolean }
  | { ok: false; message: string };

/** Adds a payment, or says why not. The same id can only ever be paid once, so a double tap can't pay twice. */
export function recordPayment(payments: Payment[], base: Account, request: PaymentRequest): PaymentResult {
  const earlier = payments.find((p) => p.id === request.id);
  if (earlier) return { ok: true, payment: earlier, payments, repeat: true };
  if (!isNewId(request.id) || !isAmount(request.amount)) return { ok: false, message: "That payment couldn't be recorded. Nothing has been paid." };
  const { currentBalance } = accountAfterPayments(base, payments);
  if (request.amount > currentBalance) {
    return { ok: false, message: `That's more than your current balance of ${formatPence(currentBalance)}. Nothing has been paid.` };
  }
  const payment: Payment = { id: request.id, amount: request.amount, date: request.date, kind: request.kind };
  return { ok: true, payment, payments: [...payments, payment], repeat: false };
}

const KINDS: Payment["kind"][] = ["minimum", "statement", "custom"];

/** Saved payments, or [] if any of them can't be trusted. All or nothing, so a balance is never half restored. */
export function restorePayments(saved: unknown, base: Account): Payment[] {
  if (!Array.isArray(saved)) return [];
  const valid = saved.every(
    (p) => typeof p === "object" && p !== null && isNewId(p.id) && isAmount(p.amount) && isDate(p.date) && KINDS.includes(p.kind),
  );
  if (!valid) return [];
  const payments = saved as Payment[];
  const total = payments.reduce((sum, p) => sum + p.amount, 0);
  return new Set(payments.map((p) => p.id)).size === payments.length && total <= base.currentBalance ? payments : [];
}

/** Every payment on the account, newest first. Payments made here come before older ones on the same day. */
export function paymentHistory(transactions: Transaction[]) {
  return transactions
    .map((t, order) => ({ t, order }))
    .filter(({ t }) => t.category === "Payments")
    .sort((a, b) => b.t.date.localeCompare(a.t.date) || b.order - a.order)
    .map(({ t }) => t);
}
