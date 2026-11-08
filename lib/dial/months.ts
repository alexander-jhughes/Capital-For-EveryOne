// Calendar months for visuals, what-ifs and goals. Pure: the clock is always passed in.
// A month is partial when it isn't over yet (the demo month) or when the history starts part way through it
// (the seed starts on 28 September). Partial months are always labelled, so nobody compares 8 days with 31.
import { formatMonth } from "../format";
import { periodLabel } from "../insights";
import type { ISODate, Transaction } from "../types";
import { MONTH_KEY, type MonthKey } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const parts = (key: MonthKey) => key.split("-").map(Number) as [number, number];

export const isMonthKey = (v: unknown): v is MonthKey => typeof v === "string" && MONTH_KEY.test(v);

/** "2026-11" for any date in November 2026. */
export const monthKey = (date: ISODate): MonthKey => date.slice(0, 7);

/** Days in the month, 28 to 31. */
export function daysInMonth(key: MonthKey): number {
  const [y, m] = parts(key);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function previousMonth(key: MonthKey): MonthKey {
  const [y, m] = parts(key);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function nextMonth(key: MonthKey): MonthKey {
  const [y, m] = parts(key);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** Every month from `from` to `to`, inclusive, oldest first. Empty if `to` is before `from`. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let k = from; k <= to && out.length < 1200; k = nextMonth(k)) out.push(k);
  return out;
}

/** "October", or "January 2027" when the month isn't in the same year as today. */
export function monthName(key: MonthKey, today: ISODate): string {
  const name = formatMonth(`${key}-01`);
  return key.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${key.slice(0, 4)}`;
}

export interface MonthRange {
  from: ISODate;
  to: ISODate;
  /** True for the month in progress, a month the history only partly covers, and a month that hasn't started. */
  partial: boolean;
  /** Days covered, from `from` to `to` inclusive. 0 for a month with no days to look at. */
  days: number;
  /** "October", "November so far (8 days)" or "September (3 days, 28 to 30 September)". */
  label: string;
}

/**
 * The days of a month there is something to look at, as of `today`.
 * `dataFrom` (optional) is the first day of the history: a month it starts part way through is partial too.
 */
export function monthRange(key: MonthKey, today: ISODate, dataFrom?: ISODate): MonthRange {
  const name = monthName(key, today);
  const first = `${key}-01`;
  const end = `${key}-${pad(daysInMonth(key))}`;
  const current = monthKey(today);
  if (key > current) return { from: first, to: end, partial: true, days: 0, label: `${name} (not started yet)` };
  const to = key === current ? today : end;
  if (dataFrom && dataFrom > to) return { from: first, to, partial: true, days: 0, label: `${name} (before your history starts)` };
  const from = dataFrom && dataFrom > first ? dataFrom : first;
  const days = Number(to.slice(8)) - Number(from.slice(8)) + 1;
  // The month in progress is never complete, even on its last day: more can still be spent today.
  if (key === current) {
    return { from, to, partial: true, days, label: from === first ? `${name} so far (${plural(days, "day")})` : `${name} so far (${plural(days, "day")}, ${periodLabel(from, to)})` };
  }
  if (from !== first) return { from, to, partial: true, days, label: `${name} (${plural(days, "day")}, ${periodLabel(from, to)})` };
  return { from, to, partial: false, days, label: name };
}

/** Months that have any transaction, oldest first. */
export function monthsWithData(txns: Transaction[]): MonthKey[] {
  return [...new Set(txns.map((t) => monthKey(t.date)).filter(isMonthKey))].sort();
}

/** The first day of the history, or undefined when there are no transactions. */
export function historyStart(txns: Transaction[]): ISODate | undefined {
  let first: ISODate | undefined;
  for (const t of txns) if (!first || t.date < first) first = t.date;
  return first;
}
