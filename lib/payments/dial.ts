// What Dial says about payments, from live state. No AI, and nothing here can make or change a payment.
import { DEMO_TODAY } from "../demo-clock";
import { monthToDateSpend } from "../finance";
import { formatLongDate, formatPence } from "../format";
import type { Account, Payment, Transaction } from "../types";
import { paymentHistory } from "./rules";

type PaymentRequest = "last_payment" | "recorded" | "spending_effect";

function matchPaymentRequest(text: string): PaymentRequest | null {
  const q = text.toLowerCase().replace(/[’']/g, "").replace(/[?.!]+$/, "").trim();
  if (/\bpayments?\b/.test(q) && /\b(spending|spend)\b/.test(q) && /\b(did|does|do|has|have|will|is)\b/.test(q)) return "spending_effect";
  if (/\b(been|was|is|get|got) (it |my payment )?(recorded|received|processed|through)\b/.test(q) && /\b(payment|it)\b/.test(q)) return "recorded";
  if (/\bdid (it|my payment) go through\b/.test(q)) return "recorded";
  if (/^how much (did|have) i (just )?(pay|paid)$/.test(q) || /\b(last|latest|most recent) payment\b/.test(q) || /\bwhat did i (just )?pay\b$/.test(q)) return "last_payment";
  return null;
}

/** Dial's answer about payments, or null when the question isn't one of these. */
export function paymentReply(question: string, state: { account: Account; transactions: Transaction[]; payments: Payment[] }): string | null {
  const request = matchPaymentRequest(question);
  if (!request) return null;
  const { account, transactions, payments } = state;
  const latest = paymentHistory(transactions)[0];
  const when = (date: string) => formatLongDate(date);
  const last = `${formatPence(account.lastPayment.amount)} on ${when(account.lastPayment.date)}`;
  switch (request) {
    case "last_payment":
      return `Your last payment was ${last}${latest?.status === "pending" ? ". It's pending" : ""}.`;
    case "recorded":
      return payments.length > 0
        ? `Yes. Your simulated payment of ${last} is recorded and pending. Your balance is now ${formatPence(account.currentBalance)}.`
        : `You haven't made a payment in this session. Your last payment was ${last}.`;
    case "spending_effect":
      return `No. Payments aren't spending, so they don't change your spending total. You've spent ${formatPence(monthToDateSpend(transactions, DEMO_TODAY))} this month.`;
  }
}
