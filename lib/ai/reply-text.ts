// Reading figures and dates out of a sentence. Shared by the guard and the claims check.

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

export const dateWords = { MONTHS, WEEKDAYS, SHORT_MONTHS, SHORT_WEEKDAYS };

export const AMOUNT_PATTERN = /£\s?\d[\d,]*(?:\.\d+)?/g;

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "£1,069.89", "£ 1069.89" and "-£1,069.89" all compare as "£1069.89". */
export const plainAmount = (text: string) => text.replace(/[\s,-]/g, "").replace(/\.$/, "");

export const amounts = (text: string) => (text.match(AMOUNT_PATTERN) ?? []).map(plainAmount);

/** Rewrites short month and day names, and "5th of" forms, so one date only has one spelling. */
export function normaliseDates(text: string): string {
  return text
    .replace(/\b(Mon|Tues?|Wed|Thu|Thurs?|Fri|Sat|Sun)\b\.?/g, (m) => SHORT_WEEKDAYS[m.replace(".", "")] ?? m)
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b\.?/g, (m) => SHORT_MONTHS[m.replace(".", "")] ?? m)
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(new RegExp(`\\b(\\d{1,2}) of (${MONTHS}|may)\\b`, "g"), "$1 $2")
    .replace(new RegExp(`\\b(${MONTHS}|may) (\\d{1,2})\\b`, "g"), "$2 $1");
}

export const dayMonths = (text: string) => text.match(new RegExp(`\\b\\d{1,2} (${MONTHS}|may)\\b`, "g")) ?? [];
