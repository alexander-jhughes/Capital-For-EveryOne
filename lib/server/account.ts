// What a session means for the account, and how it may change. Pure: no HTTP, no storage. Every balance is worked out
// from the seed and the session's events with the same code the screens use, so the server and the screens can't disagree.
import { seedContext, type FactContext } from "../ai/facts";
import { isSpendPauseSettings } from "../ai/live-state";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE } from "../demo-config";
import type { Goal } from "../dial/types";
import { MAX_GOALS, sanitizeGoals } from "../goals/store";
import { isNewId, recordPayment } from "../payments/rules";
import { initialSpendPauseState, purchaseTransaction, spendPauseReducer, type SpendPauseActivity } from "../spend-pause/state";
import { accountWithPurchases, deriveAccount } from "../state/derive-account";
import type { Account, Payment, PendingPurchase, Pence, SpendPauseSettings, Transaction } from "../types";
import { MAX_EVENTS, type Session } from "./session";

/** What every account route returns. The client replaces its copy with this whole. */
export interface AccountStateBody {
  account: Account;
  transactions: Transaction[];
  settings: SpendPauseSettings;
  spendPauseActivity: SpendPauseActivity;
  payments: Payment[];
  purchases: Transaction[];
  goals: Goal[];
  /** Always true from the server. The client sets false itself when the server can't be reached. */
  saved: true;
}

export const settingsOf = (session: Session): SpendPauseSettings => session.settings ?? INITIAL_SPEND_PAUSE;

export function deriveState(session: Session): AccountStateBody {
  const { account, transactions } = deriveAccount(session.purchases, session.payments);
  return { account, transactions, settings: settingsOf(session), spendPauseActivity: session.activity, payments: session.payments, purchases: session.purchases, goals: session.goals, saved: true };
}

/** The facts Dial answers from when the request carries a session. Same shape as contextFromState builds from a client state. */
export function contextFromSession(session: Session): FactContext {
  const { account, transactions } = deriveAccount(session.purchases, session.payments);
  return { ...seedContext(), account, txns: transactions, settings: settingsOf(session) };
}

/** A changed session, with anything else the route should report (such as `repeat`), or a friendly reason it was refused. */
export type Change<T extends object = object> = ({ ok: true; session: Session } & T) | { ok: false; message: string };

const MESSAGES = {
  full: `This demo keeps up to ${MAX_EVENTS} payments and purchases. Undo one to make room.`,
  payment: "That payment couldn't be recorded. Nothing has been paid.",
  purchase: "That purchase couldn't be recorded.",
  settings: "Those Spend Pause choices couldn't be saved. Please check them and try again.",
  goals: "One of those goals can't be tracked, so nothing was saved.",
};

const PAYMENT_KINDS: Payment["kind"][] = ["minimum", "statement", "custom"];
const isKind = (v: unknown): v is Payment["kind"] => PAYMENT_KINDS.includes(v as Payment["kind"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const eventCount = (s: Session) => s.purchases.length + s.payments.length;

export interface PaymentBody {
  id: string;
  amount: Pence;
  kind: Payment["kind"];
}

/** The payment request if it has the right shape. The amount and id are judged by recordPayment, which owns those rules. */
export const parsePaymentBody = (v: unknown): PaymentBody | null =>
  isRecord(v) && typeof v.id === "string" && typeof v.amount === "number" && isKind(v.kind) ? { id: v.id, amount: v.amount, kind: v.kind } : null;

/** Records a payment, dated today. Safe to repeat: the same id is paid once, and the first result is returned again. */
export function applyPayment(session: Session, body: PaymentBody): Change<{ payment: Payment; repeat: boolean }> {
  // Purchase and payment ids share one space, so Dial's evidence ids stay unambiguous.
  if (session.purchases.some((p) => p.id === body.id)) return { ok: false, message: MESSAGES.payment };
  const result = recordPayment(session.payments, accountWithPurchases(session.purchases), { ...body, date: DEMO_TODAY });
  if (!result.ok) return { ok: false, message: result.message };
  if (!result.repeat && eventCount(session) >= MAX_EVENTS) return { ok: false, message: MESSAGES.full };
  return { ok: true, session: { ...session, payments: result.payments }, payment: result.payment, repeat: result.repeat };
}

/** Removes a payment made in this session. Every figure goes back, because nothing else was stored. Unknown ids change nothing. */
export const removePayment = (session: Session, id: string): Session => ({ ...session, payments: session.payments.filter((p) => p.id !== id) });

/** Saves the choices and stamps when Spend Pause was turned on or off, exactly as the screen's reducer does. */
export function applySettings(session: Session, settings: unknown): Change {
  if (!isSpendPauseSettings(settings)) return { ok: false, message: MESSAGES.settings };
  const before = { ...initialSpendPauseState(settingsOf(session)), activity: session.activity };
  const after = spendPauseReducer(before, { type: "update-settings", settings, at: DEMO_NOW.toISOString() });
  return { ok: true, session: { ...session, settings: after.settings, activity: after.activity } };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 '&.-]{0,39}$/;

/** The approved purchase if it has the right shape. The date it carries must be real and not after the demo date. */
export function parsePurchaseBody(v: unknown): PendingPurchase | null {
  if (!isRecord(v) || !isNewId(v.id) || typeof v.merchant !== "string" || !SAFE_NAME.test(v.merchant) || typeof v.item !== "string" || v.item.length > 80) return null;
  if (!Number.isInteger(v.amount) || (v.amount as number) <= 0 || (v.amount as number) > 10_000_000) return null;
  if (typeof v.createdAt !== "string" || Number.isNaN(Date.parse(v.createdAt))) return null;
  const date = v.createdAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > DEMO_TODAY || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return null;
  return { id: v.id, merchant: v.merchant, item: v.item, amount: v.amount as Pence, createdAt: v.createdAt };
}

/** Adds a purchase the person went ahead with. Safe to repeat: the same id is added once. */
export function applyPurchase(session: Session, purchase: PendingPurchase): Change<{ repeat: boolean }> {
  if (session.purchases.some((p) => p.id === purchase.id)) return { ok: true, session, repeat: true };
  if (session.payments.some((p) => p.id === purchase.id)) return { ok: false, message: MESSAGES.purchase };
  if (eventCount(session) >= MAX_EVENTS) return { ok: false, message: MESSAGES.full };
  return { ok: true, session: { ...session, purchases: [...session.purchases, purchaseTransaction(purchase)] }, repeat: false };
}

/** Replaces the goals. Refused whole if any goal is invalid or there are too many, so nothing is silently dropped. */
export function applyGoals(session: Session, goals: unknown): Change {
  if (!Array.isArray(goals) || goals.length > MAX_GOALS) return { ok: false, message: MESSAGES.goals };
  const clean = sanitizeGoals(goals);
  if (clean.length !== goals.length) return { ok: false, message: MESSAGES.goals };
  return { ok: true, session: { ...session, goals: clean } };
}
