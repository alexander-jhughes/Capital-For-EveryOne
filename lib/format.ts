import type { ISODate, Pence } from "./types";

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export const formatPence = (p: Pence) => gbp.format(p / 100);

// Dates are calendar days; parse at UTC noon so no timezone can shift the day.
const day = (d: ISODate) => new Date(`${d}T12:00:00Z`);

/** "Friday 13 Nov" */
export const formatDate = (d: ISODate) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(day(d));

/** "13 Nov" */
export const formatShortDate = (d: ISODate) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(day(d));

/** Whole days from a to b. */
export const daysBetween = (a: ISODate, b: ISODate) => Math.round((day(b).getTime() - day(a).getTime()) / 86_400_000);

/** "Friday 13 November" (Simple mode: no abbreviations) */
export const formatLongDate = (d: ISODate) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(day(d));

/** "November" */
export const formatMonth = (d: ISODate) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(day(d));
