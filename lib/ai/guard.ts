// Output guard. Any reply that fails here is thrown away and the template sentence is used instead.
import type { FactSet } from "../types";

export const MAX_SENTENCES = 2;
export const CANT_TELL = "I can't tell that from your transactions.";

export type GuardResult = { ok: true } | { ok: false; reason: string };

const pass: GuardResult = { ok: true };
const fail = (reason: string): GuardResult => ({ ok: false, reason });

const MONTHS = "january|february|march|april|june|july|august|september|october|november|december";
const SHORT_MONTHS: Record<string, string> = {
  jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july",
  aug: "august", sep: "september", sept: "september", oct: "october", nov: "november", dec: "december",
};
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const SHORT_WEEKDAYS: Record<string, string> = {
  Mon: "monday", Tue: "tuesday", Tues: "tuesday", Wed: "wednesday", Thu: "thursday", Thur: "thursday",
  Thurs: "thursday", Fri: "friday", Sat: "saturday", Sun: "sunday",
};

const ADVICE =
  /\b(should|shouldn't|ought|recommend\w*|suggest\w*|advis\w*|advice|consider\w*|you (could|might|may) want|try to|make sure|i'd|i would|better to|best to|need to|have to|must|invest\w*|consolidat\w*|pay off|paying off|contact|dispute|save money|cut back|cut down|reduce|worth)\b/i;
const OTHER_MONEY = /%|\b(pounds?|quid|pence|p|gbp|percent|per cent|euros?|dollars?)\b/i;
const NUMBER_WORDS =
  /\b(three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|quarter)\b/i;
const RELATIVE_DATES = /\b(tomorrow|yesterday|tonight|next week|last week|next month|this week|weekend|fortnight)\b/i;

/** Capitalised words that are not names. Any other capitalised word must be in the facts, so a shop can't be invented. */
const ORDINARY_WORDS = new Set(
  `a an and at both but by dial each for from i i'm in it it's looks no none not nothing on one over pause right since so spend
  that that's the there these they this those today two you you're you've your yes`.split(/\s+/),
);

const clean = (text: string) => text.replace(/[’‘]/g, "'");

/** Rewrites short month and day names, and "5th of" forms, so one date only has one spelling. */
function normaliseDates(text: string): string {
  return text
    .replace(/\b(Mon|Tues?|Wed|Thu|Thurs?|Fri|Sat|Sun)\b\.?/g, (m) => SHORT_WEEKDAYS[m.replace(".", "")] ?? m)
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b\.?/g, (m) => SHORT_MONTHS[m.replace(".", "")] ?? m)
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(new RegExp(`\\b(\\d{1,2}) of (${MONTHS}|may)\\b`, "g"), "$1 $2")
    .replace(new RegExp(`\\b(${MONTHS}|may) (\\d{1,2})\\b`, "g"), "$2 $1");
}

const amounts = (text: string) => (text.match(/£\s?\d[\d,]*(?:\.\d+)?/g) ?? []).map((a) => a.replace(/[\s,]/g, ""));
const numbers = (text: string) => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
const months = (text: string) => text.match(new RegExp(`\\b(${MONTHS})\\b`, "g")) ?? [];
const weekdays = (text: string) => text.match(new RegExp(`\\b(${WEEKDAYS})\\b`, "g")) ?? [];
const dayMonths = (text: string) => text.match(new RegExp(`\\b\\d{1,2} (${MONTHS}|may)\\b`, "g")) ?? [];
const fullDates = (text: string) => text.match(new RegExp(`\\b(${WEEKDAYS})(?: the)? \\d{1,2} (${MONTHS}|may)\\b`, "g")) ?? [];

/** "1 to 8 November" states both dates, but only spells the month once. */
const expandRanges = (text: string) =>
  text.replace(new RegExp(`\\b(\\d{1,2}) to (\\d{1,2}) (${MONTHS})\\b`, "g"), "$1 $3 to $2 $3");

const factText = (facts: FactSet) => facts.facts.map((f) => `${f.label}: ${f.value}`).join("\n");

/** Lowers every month and day name so the name check skips them. */
const normaliseProperDates = (text: string) =>
  text.replace(new RegExp(`\\b(${MONTHS}|${WEEKDAYS}|may|${Object.keys(SHORT_MONTHS).join("|")}|${Object.keys(SHORT_WEEKDAYS).join("|")})\\b`, "gi"), (m) => m.toLowerCase());

const capitalised = (text: string) => text.match(/\b[A-Z][A-Za-z'-]*/g) ?? [];

const sentenceCount = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "").length;

export const isCantTell = (text: string) => clean(text).toLowerCase().includes("can't tell that from your transactions");

/** Checks one reply against one fact set. Every amount and date must appear in the facts, exactly. */
export function checkAnswer(answer: string, facts: FactSet): GuardResult {
  const reply = clean(answer).trim();
  if (reply === "") return fail("empty");
  if (/[\r\n]/.test(reply)) return fail("more than one line");
  if (sentenceCount(reply) > MAX_SENTENCES) return fail("too many sentences");
  if (ADVICE.test(reply)) return fail("advice wording");

  const source = factText(facts);
  const sourceDates = expandRanges(normaliseDates(source));
  const replyDates = normaliseDates(reply);

  const allowedAmounts = new Set(amounts(source));
  if (amounts(reply).some((a) => !allowedAmounts.has(a))) return fail("amount not in facts");

  const allowedNumbers = new Set(numbers(sourceDates));
  if (numbers(replyDates).some((n) => !allowedNumbers.has(n))) return fail("number not in facts");

  if (OTHER_MONEY.test(reply) && !OTHER_MONEY.test(source)) return fail("amount not in facts");
  if (NUMBER_WORDS.test(reply)) return fail("spelled-out number");
  if (RELATIVE_DATES.test(reply) && !RELATIVE_DATES.test(source)) return fail("relative date");
  if (/\bMay\b/.test(reply) && !/\bMay\b/.test(source)) return fail("date not in facts");

  const within = (found: string[], allowed: string[]) => found.every((d) => allowed.includes(d));
  if (!within(months(replyDates), months(sourceDates))) return fail("date not in facts");
  if (!within(weekdays(replyDates), weekdays(sourceDates))) return fail("date not in facts");
  if (!within(dayMonths(replyDates), dayMonths(sourceDates))) return fail("date not in facts");
  if (!within(fullDates(replyDates), fullDates(sourceDates))) return fail("date not in facts");

  // Dates are settled above, so their names don't count as unknown words here.
  const known = new Set(source.toLowerCase().match(/[a-z][a-z'-]*/g));
  const isName = (word: string) => !known.has(word.toLowerCase()) && !ORDINARY_WORDS.has(word.toLowerCase());
  if (capitalised(normaliseProperDates(reply)).some(isName)) return fail("name not in facts");

  return pass;
}
