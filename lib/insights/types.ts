// CONTRACT (Phase 0, owned by the lead; changes need agreeing with the insights, AI and frontend owners).
//
// The financial intelligence layer: deterministic, evidence-backed observations about spending, built only from the
// account and transactions. It runs identically on the server (lib/ai uses it as facts for Dial's answers) and in
// the browser (cards and Home re-derive the same insight by id), so an explanation and its figures can never drift.
//
// Rules every insight follows:
// - Every figure in `statement` comes from lib/finance or this layer, formatted with lib/format, and is in `figures`.
// - Payments ("Payments" category) are never spending. Refunds reduce spending. Pending items are labelled pending.
// - Comparisons are like for like (same number of days), and the limitation says so when a period is partial.
// - Describes what changed and which transactions changed it. Never says why a person spent, never predicts credit
//   eligibility, never calls anything fraud. "Unusual" means "larger than this person's own usual", nothing more.
// - When the data can't support an observation, it is left out and the reason goes in `cannotEstablish`.
import type { Account, ISODate, Pence, SpendPauseSettings, Transaction } from "../types";

export const INSIGHT_KINDS = [
  /** Total spending this period against the comparable previous period, with the categories that moved most. */
  "spending_change",
  /** One category this period against the comparable previous period. */
  "category_change",
  /** Where most of this period's spending went. */
  "top_categories",
  /** Charges that repeat at a regular interval from the same shop (subscriptions and other regular costs). */
  "recurring",
  /** A charge much larger than this person's own usual amount at that shop or in that category. */
  "unusual",
  /** Spending week by week over the available history. */
  "weekly_trend",
  /** Spending this month against the monthly budget the person set in Spend Pause. */
  "budget_progress",
  /** Balances after the payments made, and what is still owed on the bill. */
  "position_after_payments",
  /** Dated things coming up: the bill and its minimum, and recurring charges expected from their past pattern. */
  "upcoming_obligation",
  /** Factual observations that may help reduce spending, e.g. total of regular subscriptions. Never advice. */
  "saving_observation",
] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

/**
 * high: exact arithmetic on complete data (e.g. a total, a due date).
 * medium: a comparison or pattern on partial or short data (e.g. 8 days of a month, 2 occurrences).
 * low: a weak pattern; shown only when asked about directly, with its limitation.
 */
export type InsightConfidence = "high" | "medium" | "low";

export interface InsightPeriod {
  from: ISODate;
  to: ISODate;
  /** Plain label, e.g. "1 to 8 November". */
  label: string;
}

export interface InsightFigure {
  /** e.g. "Groceries this period". */
  label: string;
  /** Exactly as it appears in `statement` (formatted with lib/format), so validators can match it. */
  display: string;
  /** Machine value: pence for money, an ISO date, a count or a whole-number percentage. */
  value: Pence | ISODate | number;
  unit: "pence" | "date" | "count" | "percent";
}

export interface Insight {
  /** Stable, deterministic id: `${kind}` or `${kind}:${subject}`, e.g. "category_change:Groceries". */
  id: string;
  kind: InsightKind;
  /** The category or shop the insight is about, when there is one. */
  subject?: string;
  /** Short heading, e.g. "Groceries are up". */
  title: string;
  /** One plain-English sentence stating the observation. Every figure in it is in `figures`. */
  statement: string;
  figures: InsightFigure[];
  /** Transactions behind the statement. Empty only for account-level facts (bill, balances). */
  evidenceIds: string[];
  confidence: InsightConfidence;
  periods?: { current: InsightPeriod; previous?: InsightPeriod };
  /** What this cannot establish, in plain English. e.g. "November so far covers 8 days." */
  limitations: string[];
}

export interface InsightContext {
  account: Account;
  /** All transactions the app knows about, including payments, purchases made in the app and pending items. */
  txns: Transaction[];
  settings: SpendPauseSettings;
  today: ISODate;
}

export interface InsightReport {
  insights: Insight[];
  /** Observations that were checked but the data could not support, in plain English. */
  cannotEstablish: string[];
}

/** Insight ids are safe to pass between server and browser: letters, digits, spaces and ' & . - after the colon. */
export const INSIGHT_ID = /^[a-z_]{3,30}(?::[A-Za-z0-9][A-Za-z0-9 '&.-]{0,39})?$/;
