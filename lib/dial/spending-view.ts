// What the Spending screen shows for a set of URL filters. Pure: the page, Dial and the tests all get the same rows,
// the same figures (from lib/finance, never recalculated here) and the same words.
import { spendingSummary } from "../finance";
import { daysBetween, formatMonth, formatPence, formatShortDate } from "../format";
import type { ISODate, Transaction } from "../types";
import type { MonthKey, SpendingFilters } from "./types";

export type SortKey = NonNullable<SpendingFilters["sort"]>;

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "highest", label: "Highest amount" },
  { value: "lowest", label: "Lowest amount" },
  { value: "shop", label: "Shop, A to Z" },
];

const SORT_PHRASES: Record<SortKey, string> = {
  newest: "newest first",
  oldest: "oldest first",
  highest: "highest amount first",
  lowest: "lowest amount first",
  shop: "by shop, A to Z",
};

export const sortLabel = (s: SortKey) => SORT_OPTIONS.find((o) => o.value === s)!.label;

export function sortTransactions(txns: Transaction[], key: SortKey): Transaction[] {
  const byDate = (a: Transaction, b: Transaction) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  const cmp: Record<SortKey, (a: Transaction, b: Transaction) => number> = {
    newest: byDate,
    oldest: (a, b) => -byDate(a, b),
    highest: (a, b) => b.amount - a.amount || byDate(a, b),
    lowest: (a, b) => a.amount - b.amount || byDate(a, b),
    shop: (a, b) => a.merchant.localeCompare(b.merchant, "en-GB") || byDate(a, b),
  };
  return [...txns].sort(cmp[key]);
}

const pad = (n: number) => String(n).padStart(2, "0");

export interface MonthRange {
  month: MonthKey;
  /** First day of the month. */
  from: ISODate;
  /** Last day counted: today for the current month, otherwise the last day of the month. */
  to: ISODate;
  /** Last calendar day of the month. */
  end: ISODate;
  /** The month has started but not finished. */
  partial: boolean;
  /** The month hasn't started yet. */
  future: boolean;
  /** Days counted, 0 for a future month. */
  days: number;
}

/** The dates a month filter covers, counted up to today. */
export function monthRange(month: MonthKey, today: ISODate): MonthRange {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const end = `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  const future = from > today;
  const partial = !future && today < end;
  const to = partial ? today : end;
  return { month, from, to, end, partial, future, days: future ? 0 : daysBetween(from, to) + 1 };
}

export function previousMonth(month: MonthKey): MonthKey {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** "October", or "October 2025" when it isn't this year. */
export function monthLabel(month: MonthKey, today?: ISODate): string {
  const name = formatMonth(`${month}-01`);
  return today && month.slice(0, 4) !== today.slice(0, 4) ? `${name} ${month.slice(0, 4)}` : name;
}

/** The merchant as the account spells it ("tesco" becomes "Tesco"), so labels match the list. */
export function resolveFilters(txns: Transaction[], f: SpendingFilters): SpendingFilters {
  if (!f.merchant) return f;
  const m = f.merchant.toLowerCase();
  const known = txns.find((t) => t.merchant.toLowerCase() === m)?.merchant;
  return known ? { ...f, merchant: known } : f;
}

/** True when the filters narrow or reorder the list (not just open or highlight a transaction). */
export const narrowsList = (f: SpendingFilters) => !!(f.category || f.month || f.merchant || f.sort);

/**
 * Spending transactions (purchases and refunds; card payments are never spending) that match the filters.
 * The merchant must match exactly, ignoring case: "Tesco" never matches "Tesco Mobile".
 */
export function filterTransactions(txns: Transaction[], f: SpendingFilters, today: ISODate): Transaction[] {
  const range = f.month ? monthRange(f.month, today) : null;
  const merchant = f.merchant?.trim().toLowerCase();
  return txns.filter(
    (t) =>
      t.category !== "Payments" &&
      (!f.category || t.category === f.category) &&
      (!merchant || t.merchant.toLowerCase() === merchant) &&
      (!range || (t.date >= range.from && t.date <= range.to)),
  );
}

/** "Groceries in October", "Groceries at Tesco", "Spending in November, highest amount first". */
export function describeFilters(f: SpendingFilters, today?: ISODate): string {
  const subject =
    f.category && f.merchant ? `${f.category} at ${f.merchant}` : (f.merchant ?? f.category ?? (f.month ? "Spending" : "All spending"));
  const scoped = f.month ? `${subject} in ${monthLabel(f.month, today)}` : subject;
  return f.sort ? `${scoped}, ${SORT_PHRASES[f.sort]}` : scoped;
}

/** "No Groceries purchases in September." */
export function describeEmpty(f: SpendingFilters, today?: ISODate): string {
  if (f.month && today && monthRange(f.month, today).future) return `${monthLabel(f.month, today)} hasn't started yet, so there's nothing to show.`;
  const when = f.month ? ` in ${monthLabel(f.month, today)}` : "";
  if (f.category && f.merchant) return `No ${f.category} purchases at ${f.merchant}${when}.`;
  if (f.category) return `No ${f.category} purchases${when}.`;
  if (f.merchant) return `No purchases at ${f.merchant}${when}.`;
  return `No purchases${when}.`;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export interface SpendingView {
  filters: SpendingFilters;
  rows: Transaction[];
  /** lib/finance spendingSummary over the rows and the range they cover. */
  summary: ReturnType<typeof spendingSummary>;
  range: MonthRange | null;
  description: string;
  /** For the filter bar's live region: "Showing Groceries in October: 10 purchases, £318.30". */
  status: string;
  /** Honest limits on the figures: a partial month, or a month the records only partly cover. */
  notes: string[];
}

export function spendingView(txns: Transaction[], filters: SpendingFilters, today: ISODate): SpendingView {
  const f = resolveFilters(txns, filters);
  const rows = filterTransactions(txns, f, today);
  const range = f.month ? monthRange(f.month, today) : null;
  const from = range?.from ?? rows.reduce((min, t) => (t.date < min ? t.date : min), today);
  const summary = spendingSummary(rows, from, range?.to ?? today);
  const refunds = summary.refundIds.length;
  const description = describeFilters(f, today);
  const counts = `${plural(summary.count, "purchase")}${refunds ? ` and ${plural(refunds, "refund")}` : ""}`;
  const status =
    rows.length === 0
      ? `Showing ${description}: ${range?.future ? `${monthLabel(range.month, today)} hasn't started yet` : "no purchases"}`
      : `Showing ${description}: ${counts}, ${formatPence(summary.total)}${refunds ? " after refunds" : ""}`;

  const notes: string[] = [];
  if (range?.partial) notes.push(`${monthLabel(range.month, today)} so far: ${plural(range.days, "day")}, ${formatShortDate(range.from)} to ${formatShortDate(range.to)}.`);
  const first = txns.reduce<ISODate | null>((min, t) => (min === null || t.date < min ? t.date : min), null);
  if (range && first && !range.future && range.from < first)
    notes.push(range.to < first ? `Your records start on ${formatShortDate(first)}.` : `Your records start on ${formatShortDate(first)}, so ${monthLabel(range.month, today)} is only partly here.`);
  return { filters: f, rows, summary, range, description, status, notes };
}

/**
 * The Detailed summary cards for one month: that month (to today if it's this month) against the month before.
 * A partial month is compared with the same days of the previous month, like monthOverMonth.
 */
export function monthComparison(txns: Transaction[], month: MonthKey, today: ISODate) {
  const range = monthRange(month, today);
  const prev = monthRange(previousMonth(month), today);
  const prevTo = range.partial ? `${prev.month}-${pad(Math.min(range.days, Number(prev.end.slice(8))))}` : prev.end;
  const first = txns.reduce<ISODate | null>((min, t) => (min === null || t.date < min ? t.date : min), null);
  return {
    range,
    current: spendingSummary(txns, range.from, range.to),
    previous: spendingSummary(txns, prev.from, prevTo),
    previousFull: spendingSummary(txns, prev.from, prev.end),
    previousMonth: prev.month,
    /** The previous month starts before the records do, so its figure is incomplete. */
    previousIncomplete: first !== null && prev.from < first,
    /** The records start after the previous month ended, so there's nothing from it at all. */
    previousBeforeRecords: first !== null && prev.end < first,
    firstRecord: first,
  };
}
