// Credit building, worked out from the card alone. Pure, integer pence, no AI: every figure the credit coach shows or
// says comes from here.
//
// What it does NOT do: predict a credit score. UK credit reference agencies each use their own models and don't publish
// how much each factor weighs, so the coach only explains the habits that are widely agreed to help (paying on time,
// using a small share of the limit, staying under the limit) and shows exactly where this card stands on each.
// The 25% guide follows Experian UK's advice to keep credit use below 25% of the limit.
import type { Account, ISODate, Payment, Pence } from "../types";
import { formatPence } from "../format";
import { daysUntilDue } from "./index";

/** The share of the limit the coach aims for, as a whole percentage. */
export const UTILISATION_GUIDE = 25;

export type HabitStatus = "done" | "on-track" | "to-do" | "needs-attention";

export interface Habit {
  id: "on-time" | "low-use" | "more-than-minimum" | "under-limit";
  title: string;
  status: HabitStatus;
  /** One plain sentence with the figures, for the screen and for Dial to read aloud. */
  detail: string;
  /** What to do next, if anything. */
  next?: string;
}

export interface CreditHealth {
  limit: Pence;
  balance: Pence;
  available: Pence;
  /** Whole percentage of the limit in use now (can exceed 100 if over the limit). */
  usedPercent: number;
  /** Paying this much now would bring use down to the guide. 0 if already there. */
  payToGuide: Pence;
  /** Use after paying the full bill (statement balance). */
  usedAfterBill: number;
  minimum: Pence;
  statementBalance: Pence;
  dueDate: ISODate;
  daysToDue: number;
  /** Paid towards this bill since it was issued (payments made in the app this session). */
  paidThisBill: Pence;
  habits: Habit[];
  /** How many of the habits are done or on track. */
  onTrack: number;
}

/** Whole percentage, rounded half up, never negative. */
export const percentOf = (part: Pence, whole: Pence) => (whole <= 0 ? 0 : Math.max(0, Math.round((100 * part) / whole)));

const money = formatPence;

/**
 * Where this card stands on each credit-building habit. `payments` are the payments made since the statement (the
 * app's Pay screen), so the coach updates the moment someone pays.
 */
export function creditHealth(account: Account, payments: Payment[], today: ISODate): CreditHealth {
  const limit = account.creditLimit;
  const balance = account.currentBalance;
  const usedPercent = percentOf(balance, limit);
  const guideAmount = Math.floor((limit * UTILISATION_GUIDE) / 100);
  const payToGuide = Math.max(0, balance - guideAmount);
  const paidThisBill = payments.reduce((s, p) => s + p.amount, 0);
  const usedAfterBill = percentOf(Math.max(0, balance - Math.max(0, account.statementBalance - paidThisBill)), limit);
  const daysToDue = daysUntilDue(account, today);
  const minimumLeft = Math.max(0, account.minimumPayment - paidThisBill);
  const billLeft = Math.max(0, account.statementBalance - paidThisBill);
  const when = daysToDue === 0 ? "today" : daysToDue === 1 ? "tomorrow" : daysToDue > 0 ? `in ${daysToDue} days` : `${-daysToDue} days ago`;

  const onTime: Habit =
    minimumLeft === 0
      ? { id: "on-time", title: "Pay on time", status: "done", detail: `You've paid at least the minimum for this bill. Paying on time every month is the biggest thing you can do for your credit.` }
      : daysToDue < 0
        ? {
            id: "on-time",
            title: "Pay on time",
            status: "needs-attention",
            detail: `Your minimum payment of ${money(account.minimumPayment)} was due ${when}.`,
            next: `Pay at least ${money(minimumLeft)} as soon as you can. If you're struggling, free help is available.`,
          }
        : {
            id: "on-time",
            title: "Pay on time",
            status: "to-do",
            detail: `Your minimum payment of ${money(account.minimumPayment)} is due ${when}. Paying on time every month is the biggest thing you can do for your credit.`,
            next: `Pay at least ${money(minimumLeft)} before the due date.`,
          };

  const lowUse: Habit =
    usedPercent <= UTILISATION_GUIDE
      ? { id: "low-use", title: "Use a small part of your limit", status: "done", detail: `You're using ${usedPercent}% of your ${money(limit)} limit. Staying under ${UTILISATION_GUIDE}% can help your credit.` }
      : {
          id: "low-use",
          title: "Use a small part of your limit",
          status: usedPercent > 75 ? "needs-attention" : "to-do",
          detail: `You're using ${usedPercent}% of your ${money(limit)} limit. Keeping it under ${UTILISATION_GUIDE}% can help your credit.`,
          next:
            billLeft > 0
              ? `Paying your full bill of ${money(billLeft)} would bring it to ${usedAfterBill}%. Paying ${money(payToGuide)} would bring it to ${UTILISATION_GUIDE}%.`
              : `Paying ${money(payToGuide)} would bring it to ${UTILISATION_GUIDE}%.`,
        };

  const moreThanMinimum: Habit =
    account.statementBalance > 0 && billLeft === 0
      ? { id: "more-than-minimum", title: "Pay more than the minimum", status: "done", detail: "You've paid this bill in full, so there's no interest on it." }
      : paidThisBill > account.minimumPayment
        ? { id: "more-than-minimum", title: "Pay more than the minimum", status: "on-track", detail: `You've paid ${money(paidThisBill)}, more than the minimum. The more you pay, the less interest you're charged.` }
        : {
            id: "more-than-minimum",
            title: "Pay more than the minimum",
            status: "to-do",
            detail: `Paying only the minimum means interest (${account.apr}% a year) on the rest. The more you pay, the less it costs you.`,
            next: billLeft > 0 ? `Your full bill is ${money(billLeft)}. Any amount over ${money(account.minimumPayment)} helps.` : undefined,
          };

  const underLimit: Habit =
    balance <= limit
      ? { id: "under-limit", title: "Stay under your limit", status: "on-track", detail: `You have ${money(Math.max(0, limit - balance))} of your limit left.` }
      : {
          id: "under-limit",
          title: "Stay under your limit",
          status: "needs-attention",
          detail: `You're ${money(balance - limit)} over your limit, which can harm your credit.`,
          next: `Paying ${money(balance - limit)} would bring you back under it.`,
        };

  const habits = [onTime, lowUse, moreThanMinimum, underLimit];
  return {
    limit,
    balance,
    available: Math.max(0, limit - balance),
    usedPercent,
    payToGuide,
    usedAfterBill,
    minimum: account.minimumPayment,
    statementBalance: account.statementBalance,
    dueDate: account.paymentDueDate,
    daysToDue,
    paidThisBill,
    habits,
    onTrack: habits.filter((h) => h.status === "done" || h.status === "on-track").length,
  };
}

/** What Dial says when asked about credit building. Only figures from creditHealth. */
export function creditSummary(h: CreditHealth): string {
  const todo = h.habits.find((x) => x.status === "needs-attention" || x.status === "to-do");
  const lead = `You're on track with ${h.onTrack} of ${h.habits.length} credit-building habits.`;
  return todo ? `${lead} Next: ${todo.next ?? todo.detail}` : `${lead} Keep it up: paying on time each month is what counts most.`;
}

const CREDIT_QUESTION = / (build(ing)? (my )?credit|credit build(ing|er)|improve (my )?credit|credit (score|rating|file|history|health)|how('s| is) my credit|how am i doing with (my )?credit|utili[sz]ation|how much of my limit) /;

/** "How can I build my credit?", "how's my credit": answered on the device. "What's my credit limit" is not one. */
export const isCreditBuildingQuestion = (q: string) => CREDIT_QUESTION.test(` ${q.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `);
