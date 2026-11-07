const TIME_ZONE = "Europe/London"
const MS_PER_DAY = 86_400_000

const wholePounds = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
})

const shortDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
})

const fullDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
})

const monthYear = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  month: "long",
  year: "numeric",
})

const calendarParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "numeric",
  year: "numeric",
})

/**
 * Formats integer pence as pounds, for example 4783 as "£47.83" and -6800 as
 * "-£68.00". Pounds and pence are split with integer arithmetic so that no
 * float ever holds the money.
 */
export function formatPence(pence: number): string {
  const absolute = Math.abs(pence)
  const pounds = wholePounds.format(Math.trunc(absolute / 100))
  const remainder = String(absolute % 100).padStart(2, "0")
  return `${pence < 0 ? "-" : ""}${pounds}.${remainder}`
}

/** Formats a date as "3 Nov". */
export function formatShortDate(iso: string): string {
  return shortDate.format(new Date(iso))
}

/** Formats a date as "3 November 2026". */
export function formatFullDate(iso: string): string {
  return fullDate.format(new Date(iso))
}

/** Formats the month of a date as "November 2026". */
export function formatMonth(iso: string): string {
  return monthYear.format(new Date(iso))
}

/** Identifies the UK calendar month of a date, for example "2026-11". */
export function monthKey(iso: string): string {
  const { year, month } = ukCalendarDate(new Date(iso))
  return `${year}-${String(month).padStart(2, "0")}`
}

/**
 * Whole UK calendar days from `now` until `iso`. Negative once the date has
 * passed. Compares calendar dates so the clock time and clock changes cannot
 * shift the count by a day.
 */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const target = ukCalendarDate(new Date(iso))
  const today = ukCalendarDate(now)
  const targetDay = Date.UTC(target.year, target.month - 1, target.day)
  const todayDay = Date.UTC(today.year, today.month - 1, today.day)
  return Math.round((targetDay - todayDay) / MS_PER_DAY)
}

/** Describes `daysUntil` in words: "Due today", "3 days left", "2 days overdue". */
export function formatDaysRemaining(days: number): string {
  if (days === 0) return "Due today"
  const count = Math.abs(days)
  const unit = count === 1 ? "day" : "days"
  return days > 0 ? `${count} ${unit} left` : `${count} ${unit} overdue`
}

function ukCalendarDate(date: Date) {
  const parts = calendarParts.formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  return { year: read("year"), month: read("month"), day: read("day") }
}
