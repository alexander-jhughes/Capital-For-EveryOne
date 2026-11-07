// Where the current bill stands, in words, for Home's Payments section. Pure, so it is tested without a screen.
import { formatPence } from "../format";
import type { Pence } from "../types";

/** "today", "tomorrow", "in 5 days", "1 day ago", "3 days ago". */
export function whenText(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 0) return `in ${days} days`;
  return days === -1 ? "1 day ago" : `${-days} days ago`;
}

/**
 * `paid` is what was paid since the statement (payments made in the app), because the account's minimum stays at the
 * original amount until the statement balance drops below it.
 */
export function paymentStatus(statement: Pence, minimum: Pence, paid: Pence, days: number): { state: "paid" | "due" | "late"; text: string } {
  const minimumLeft = Math.max(0, minimum - paid);
  if (statement === 0) return { state: "paid", text: "Your bill is paid in full." };
  if (minimumLeft === 0) return { state: "paid", text: `Minimum paid. ${formatPence(statement)} of the bill is still to pay.` };
  if (days < 0) return { state: "late", text: `${formatPence(minimumLeft)} of the minimum was due ${whenText(days)} and hasn't been paid.` };
  return {
    state: "due",
    text: paid > 0 ? `${formatPence(paid)} paid. ${formatPence(minimumLeft)} more is needed to cover the minimum, due ${whenText(days)}.` : `Not paid yet. At least ${formatPence(minimumLeft)} is due ${whenText(days)}.`,
  };
}
