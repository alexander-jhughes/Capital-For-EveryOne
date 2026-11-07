import type { ISODate } from "./types";

// Fixed demo "today" so dates never drift on the day. November is GMT, so Z = London time.
export const DEMO_NOW = new Date("2026-11-08T10:00:00Z");

/** YYYY-MM-DD for an instant, in Europe/London. */
export function londonDate(d: Date): ISODate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
}

/** "HH:MM" (24h) for an instant, in Europe/London. */
export function londonTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export const DEMO_TODAY: ISODate = londonDate(DEMO_NOW);
