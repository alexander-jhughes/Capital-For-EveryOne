// Finds the things a person names in one request: categories, shops, months, amounts and transactions.
// Pure and deterministic. Every finder returns where it matched, so a self-correction ("food? Actually, groceries")
// can swap one slot without touching the rest of the sentence.
import type { Category, ISODate, Pence } from "../types";
import { MONTH_KEY, type MonthKey } from "./types";

export type SpendCategory = Exclude<Category, "Payments">;

export interface Span {
  start: number;
  end: number;
  text: string;
}

/** Lower case with curly quotes straightened. Same length as the input, so spans index the original text too. */
export const lowerSame = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'");

function spans(re: RegExp, text: string): Span[] {
  const out: Span[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m; m = g.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

// ─── Categories ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Everyday words for each category, checked in this order so the longer phrase wins ("food shopping" is Groceries,
 * "fast food" is Eating out). Travel and Transport follow the data: TfL (tube and bus) is Transport, Trainline (train
 * tickets) is Travel, so "trains" means Travel and "the tube" means Transport.
 *
 * "food" on its own is AMBIGUOUS: it could mean the supermarket or eating out, and both are categories. It is
 * reported as "food" and never resolved to one of them here; the planner shows both, or asks which one.
 */
const CATEGORY_PATTERNS: [SpendCategory | "food", RegExp][] = [
  ["Groceries", /\b(?:groceries|grocery|supermarkets?|food shop(?:ping)?|weekly shop(?:ping)?|big shop)\b/],
  ["Eating out", /\b(?:eating out|eat out|ate out|takeaways?|take ?aways?|take-aways?|restaurants?|dining(?: out)?|meals? out|cafes?|coffee shops?|fast food|food deliver(?:y|ies)|deliver(?:y|ies))\b/],
  ["Transport", /\b(?:public transport|transport|commut\w*|the tube|tube|underground|bus(?:es)?|oyster|taxis?|cabs?)\b/],
  ["Travel", /\b(?:travel(?:ling|ing)?|train tickets?|trains?|rail|holidays?|trips?|flights?)\b/],
  ["Subscriptions", /\b(?:subscriptions?|streaming|memberships?)\b/],
  ["Shopping", /\b(?:online shopping|shopping(?! list)|clothes|clothing)\b/],
  ["food", /\bfood\b/],
];

export interface CategoryMatch extends Span {
  category: SpendCategory | "food";
}

export function findCategories(text: string): CategoryMatch[] {
  const lower = lowerSame(text);
  const found: CategoryMatch[] = [];
  for (const [category, re] of CATEGORY_PATTERNS)
    for (const s of spans(re, lower)) if (!found.some((f) => overlaps(f, s))) found.push({ ...s, text: text.slice(s.start, s.end), category });
  return found.sort((a, b) => a.start - b.start);
}

// ─── Merchants ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Same rule as lib/ai/intent.ts (namedShops): whole word, case-insensitive, "Sainsburys" and "Sainsbury's" both name
 * Sainsbury's, "Tesco's" names Tesco, and a shop's name followed by one of these words is a DIFFERENT business, so
 * "Tesco Mobile" is never read as Tesco. Kept identical so a step and the backend agree about who was named.
 */
const OTHER_BUSINESS = "(?:mobile|bank|insurance|prime|music|express|extra|business|photo|money|card)\\b";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const merchantBase = (name: string) => lowerSame(name).replace(/'/g, "").replace(/s$/, "");
const merchantRe = (name: string) => new RegExp(`(?<![a-z0-9])${esc(merchantBase(name))}(?:'?s|s')?(?![a-z0-9])`, "g");
/** Card payments appear as a "merchant" in the data but are never a shop. */
const NOT_A_MERCHANT = /^payment/i;

export interface MerchantMatch extends Span {
  merchant: string;
}

export function findMerchants(text: string, merchants: readonly string[]): { matches: MerchantMatch[]; otherBusiness: string | null } {
  const lower = lowerSame(text);
  const matches: MerchantMatch[] = [];
  let otherBusiness: string | null = null;
  // Longest names first, so "Sainsbury's Local" (if it existed) would win over "Sainsbury's".
  for (const merchant of [...merchants].filter((m) => m.trim() && !NOT_A_MERCHANT.test(m)).sort((a, b) => b.length - a.length)) {
    for (const s of spans(merchantRe(merchant), lower)) {
      if (matches.some((m) => overlaps(m, s))) continue;
      const rest = lower.slice(s.end);
      const other = rest.match(new RegExp(`^\\s+${OTHER_BUSINESS}`));
      if (other) {
        otherBusiness ??= text.slice(s.start, s.end + other[0].length).trim();
        continue;
      }
      matches.push({ ...s, text: text.slice(s.start, s.end), merchant });
    }
  }
  return { matches: matches.sort((a, b) => a.start - b.start), otherBusiness };
}

// ─── Months ─────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "12": 12 };

export const monthOf = (date: ISODate): MonthKey => date.slice(0, 7);
export function addMonths(key: MonthKey, n: number): MonthKey {
  const [y, m] = key.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
/** Months from a to b inclusive, oldest first. */
export function monthRange(a: MonthKey, b: MonthKey): MonthKey[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const out: MonthKey[] = [];
  for (let k = from; k <= to && out.length < 24; k = addMonths(k, 1)) out.push(k);
  return out;
}

export function monthName(key: MonthKey, today: ISODate): string {
  const [y, m] = key.split("-").map(Number);
  const name = MONTH_NAMES[m - 1].charAt(0).toUpperCase() + MONTH_NAMES[m - 1].slice(1);
  return String(y) === today.slice(0, 4) ? name : `${name} ${y}`;
}

const NAME_ALT = `${MONTH_NAMES.filter((n) => n !== "may").join("|")}|${Object.keys(MONTH_ABBR).join("|")}`;
// "may" is a month only after a word that introduces one ("in May", "by May"), never in "may I".
const MONTH_WORD = `(?:(?:${NAME_ALT})(?![a-z])|(?<=\\b(?:in|by|of|since|for|until|till|before|from|to|and|with|versus|vs|than|between|through) )may(?![a-z]))(?:\\s+(20\\d\\d))?`;

const monthNumber = (word: string) => {
  const w = word.toLowerCase();
  return MONTH_NAMES.indexOf(w) + 1 || MONTH_ABBR[w] || 0;
};

export interface MonthMatch extends Span {
  months: MonthKey[];
  kind: "name" | "range" | "this" | "last" | "lastN" | "next" | "endOfYear";
}

/**
 * Months a request names. `mode: "past"` (questions about spending) resolves a month name to its latest occurrence
 * up to this month: in November 2026, "December" is December 2025. `mode: "future"` (goals and what-ifs) resolves it
 * to the next occurrence after this month: "by January" is January 2027.
 */
export function findMonthMatches(text: string, today: ISODate, mode: "past" | "future" = "past"): MonthMatch[] {
  const lower = lowerSame(text);
  const current = monthOf(today);
  const [cy, cm] = current.split("-").map(Number);
  const resolve = (word: string, year?: string): MonthKey => {
    const n = monthNumber(word);
    const y = year ? Number(year) : mode === "past" ? (n <= cm ? cy : cy - 1) : n > cm ? cy : cy + 1;
    return `${y}-${String(n).padStart(2, "0")}`;
  };
  const found: MonthMatch[] = [];
  const add = (s: Span, months: MonthKey[], kind: MonthMatch["kind"]) => {
    if (!found.some((f) => overlaps(f, s))) found.push({ ...s, text: text.slice(s.start, s.end), months, kind });
  };

  const rangeRe = new RegExp(`\\b(?:(from|between)\\s+)?(${MONTH_WORD})\\s+(?:to|through|until|till|and)\\s+(${MONTH_WORD})`, "g");
  for (let m = rangeRe.exec(lower); m; m = rangeRe.exec(lower)) {
    const joiner = m[0].match(/\s(to|through|until|till|and)\s/)?.[1];
    // "October and September" is two months to compare; only "between X and Y" is a range.
    if (joiner === "and" && m[1] !== "between") continue;
    const [aWord, bWord] = [m[2], m[4]].map((w) => w.replace(/\s+20\d\d$/, ""));
    const a = resolve(aWord.trim(), m[3]);
    const b = resolve(bWord.trim(), m[5]);
    add({ start: m.index, end: m.index + m[0].length, text: m[0] }, monthRange(a, b), "range");
  }
  for (const s of spans(/\b(?:the |my )?(?:last|past|previous) (two|three|four|five|six|twelve|2|3|4|5|6|12) months\b/, lower)) {
    const n = COUNT_WORDS[s.text.match(/(two|three|four|five|six|twelve|\d+) months/)![1]];
    add(s, monthRange(addMonths(current, 1 - n), current), "lastN");
  }
  for (const s of spans(/\b(?:so far this month|this month so far|this month|the current month|month to date|so far)\b/, lower)) add(s, [current], "this");
  for (const s of spans(/\b(?:last month|the previous month|previous month|the month before last)\b/, lower))
    add(s, [addMonths(current, s.text.includes("before last") ? -2 : -1)], "last");
  for (const s of spans(/\b(?:next month|the coming month)\b/, lower)) add(s, [addMonths(current, 1)], "next");
  for (const s of spans(/\b(?:the end of (?:the|this) year|end of (?:the|this) year|christmas|new year)\b/, lower)) add(s, [`${cy}-12`], "endOfYear");
  for (const s of spans(/\b(?:the end of (?:the|this) month|end of (?:the|this) month)\b/, lower)) add(s, [current], "this");

  const nameRe = new RegExp(MONTH_WORD, "g");
  for (let m = nameRe.exec(lower); m; m = nameRe.exec(lower)) {
    const word = m[0].replace(/\s+20\d\d$/, "");
    add({ start: m.index, end: m.index + m[0].length, text: m[0] }, [resolve(word, m[1])], "name");
  }
  return found.sort((a, b) => a.start - b.start).filter((f) => f.months.every((k) => MONTH_KEY.test(k)));
}

/** Past or present months a request names, split into those with data (env.months, or this month) and those without. */
export function findMonths(text: string, env: { today: ISODate; months: readonly MonthKey[] }) {
  const matches = findMonthMatches(text, env.today, "past");
  const current = monthOf(env.today);
  const ok = (k: MonthKey) => k === current || env.months.includes(k);
  const all = matches.flatMap((m) => m.months).filter((k) => k <= current);
  const future = matches.flatMap((m) => m.months).filter((k) => k > current);
  return {
    matches,
    months: [...new Set(all.filter(ok))],
    unavailable: [...new Set([...all.filter((k) => !ok(k)), ...future])],
    lastN: matches.some((m) => m.kind === "lastN" || m.kind === "range"),
  };
}

/** The month a goal or what-if is aimed at ("by January", "next month"), always after today's month or this month. */
export function findTargetMonth(text: string, today: ISODate): MonthKey | null {
  const m = findMonthMatches(text, today, "future").filter((x) => x.kind !== "lastN" && x.kind !== "last");
  const month = m.at(-1)?.months.at(-1);
  return month && month >= monthOf(today) ? month : null;
}

// ─── Amounts ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Amounts are integer pence, at least 1p and below £100,000. The same bound validateStep() enforces. */
export const MAX_PENCE = 10_000_000;
export const validPence = (p: number): p is Pence => Number.isSafeInteger(p) && p > 0 && p < MAX_PENCE;

const UNITS: Record<string, number> = {
  zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const NUMBER_WORD = `(?:${Object.keys(UNITS).join("|")}|hundred|thousand|and)`;

/** "a hundred", "two hundred and fifty", "one thousand five hundred" as a whole number, or null. */
export function wordsToNumber(words: string): number | null {
  const parts = words.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const [i, w] of parts.entries()) {
    if (w === "and") continue;
    if ((w === "a" || w === "an") && i !== 0) return null;
    if (w in UNITS) {
      current += UNITS[w];
      seen = true;
    } else if (w === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (w === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

const digitsToPence = (whole: string, decimals?: string, scale?: string) => {
  const n = Number(whole.replace(/,/g, ""));
  const p = Math.round(n * 100) + (decimals ? Number(decimals.padEnd(2, "0")) : 0);
  return scale && /^(k|thousand|grand)$/i.test(scale) ? p * 1000 : p;
};

export interface AmountMatch extends Span {
  pence: number;
}

const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?";

/**
 * The first amount of money in the text, in pence. "£100", "100 pounds", "a hundred pounds", "£1,250.50", "80 quid",
 * "£1.5k". With `loose`, a bare number counts as pounds too ("spend 100 less"), but never one that is a count of
 * months or days, a year, or part of a transaction reference.
 */
export function findAmount(text: string, { loose = false }: { loose?: boolean } = {}): AmountMatch | null {
  const lower = lowerSame(text);
  const candidates: AmountMatch[] = [];
  const push = (m: RegExpExecArray, pence: number) => candidates.push({ start: m.index, end: m.index + m[0].length, text: text.slice(m.index, m.index + m[0].length), pence });
  const run = (re: RegExp, toPence: (m: RegExpExecArray) => number | null) => {
    for (let m = re.exec(lower); m; m = re.exec(lower)) {
      const p = toPence(m);
      if (p !== null) push(m, p);
    }
  };
  run(new RegExp(`£\\s?${NUM}(?:\\s?(k|thousand|grand)\\b)?`, "g"), (m) => digitsToPence(m[1], m[2], m[3]));
  run(new RegExp(`(?<![£\\w.])${NUM}\\s?(k|thousand|grand)?\\s?(?:pounds?|quid|gbp)\\b`, "g"), (m) => digitsToPence(m[1], m[2], m[3]));
  run(/(?<![£\w.])(\d+)\s?(?:p|pence)\b/g, (m) => Number(m[1]));
  run(new RegExp(`\\b(${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*)\\s+(?:pounds?|quid)\\b`, "g"), (m) => {
    const n = wordsToNumber(m[1]);
    return n === null ? null : n * 100;
  });
  if (candidates.length === 0 && loose) {
    run(new RegExp(`(?<![£\\w.,])${NUM}(?![\\w.,%]|\\s?(?:months?|days?|weeks?|years?|times|percent|per cent|st|nd|rd|th)\\b)`, "g"), (m) =>
      /^20\d\d$/.test(m[1]) && !m[2] ? null : digitsToPence(m[1], m[2]),
    );
    run(new RegExp(`\\b((?:a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+${NUMBER_WORD})*\\s+(?:hundred|thousand)(?:[\\s-]+${NUMBER_WORD})*)\\b`, "g"), (m) => {
      const n = wordsToNumber(m[1].replace(/\s+and$/, ""));
      return n === null ? null : n * 100;
    });
  }
  return candidates.sort((a, b) => a.start - b.start)[0] ?? null;
}

// ─── Transactions ───────────────────────────────────────────────────────────────────────────────────────────────

export interface TxnSummary {
  id: string;
  merchant: string;
  date: ISODate;
  amount: Pence;
}

export type TxnRef =
  /** A transaction that exists. */
  | { kind: "id"; id: string }
  /** A reference that looks like one of ours but doesn't exist. */
  | { kind: "unknown"; id: string }
  /** "the Argos purchase": one shop's purchase, with its id when exactly one matches. */
  | { kind: "merchant"; merchant: string; id?: string };

const TXN_ID = /\bt\d{3}\b/gi;
const REFERENCE_WORD = /\b(transaction|reference|ref|purchase|charge|payment|number)\b/i;
const SINGLE_PURCHASE = "(?:purchase|transaction|charge|order|payment|refund|expense|one)";

/**
 * "transaction t012", "t012" (when it exists) or "the Argos purchase". A plural ("my Amazon purchases") is a list,
 * not one transaction, so it isn't a reference.
 */
export function findTransactionRef(text: string, env: { transactionIds: readonly string[]; merchants: readonly string[]; transactions?: readonly TxnSummary[] }): TxnRef | null {
  const ids = [...text.matchAll(TXN_ID)].map((m) => m[0].toLowerCase());
  if (ids.length === 1) {
    if (env.transactionIds.includes(ids[0])) return { kind: "id", id: ids[0] };
    if (REFERENCE_WORD.test(text)) return { kind: "unknown", id: ids[0] };
  }
  const lower = lowerSame(text);
  for (const m of findMerchants(text, env.merchants).matches) {
    const after = lower.slice(m.end);
    if (!new RegExp(`^\\s+(?:${SINGLE_PURCHASE})(?![a-z])`).test(after)) continue;
    if (!/\b(?:the|that|my|this)\s+$/.test(lower.slice(0, m.start))) continue;
    const own = (env.transactions ?? []).filter((t) => t.merchant.toLowerCase() === m.merchant.toLowerCase() && t.amount > 0);
    return own.length === 1 ? { kind: "merchant", merchant: m.merchant, id: own[0].id } : { kind: "merchant", merchant: m.merchant };
  }
  return null;
}
