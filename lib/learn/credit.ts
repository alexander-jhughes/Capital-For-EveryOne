// Credit Learning Lab arithmetic. Deterministic, whole pence, no floats kept between steps, and no AI.
// Everything here is ILLUSTRATIVE: a lender works interest out daily, from its own terms. The screens say so.
import type { Pence } from "../types";

/** Fifty years. A plan that hasn't cleared the balance by then is shown as "more than 50 years". */
export const MAX_MONTHS = 600;

/**
 * The minimum payment rule used for illustration only: the greater of £25 or 1% of the balance plus that month's
 * interest, never more than what's owed. Many UK cards use a rule like this; the card's own terms decide the real one.
 */
export const MINIMUM_RULE = { floor: 2500, percentOfBalance: 1 } as const;
export const MINIMUM_RULE_TEXT = "the greater of £25, or 1% of the balance plus that month's interest";
export const ILLUSTRATIVE =
  "Illustrative only. It assumes the same APR, no new spending, no fees and interest worked out monthly. Your lender's figures will differ.";

/** Balance as a whole-number share of the limit, 0 to any size (over the limit is over 100). null without a limit. */
export function utilisationPercent(balance: Pence, limit: Pence): number | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.round((Math.max(0, balance) * 100) / limit);
}

/** The highest balance that keeps utilisation at or under `percent` of the limit. */
export const balanceForUtilisation = (limit: Pence, percent: number): Pence => Math.max(0, Math.floor((limit * percent) / 100));

/** One month's interest at APR / 12, rounded to the penny. Same arithmetic as lib/finance's payoffEstimate. */
export const monthlyInterest = (balance: Pence, apr: number): Pence => (balance > 0 && apr > 0 ? Math.round(balance * (apr / 100 / 12)) : 0);

/** This month's illustrative minimum on a balance (see MINIMUM_RULE). */
export function illustrativeMinimum(balance: Pence, apr: number): Pence {
  if (balance <= 0) return 0;
  const interest = monthlyInterest(balance, apr);
  const rule = Math.round((balance * MINIMUM_RULE.percentOfBalance) / 100) + interest;
  return Math.min(balance + interest, Math.max(MINIMUM_RULE.floor, rule));
}

export type RepaymentPlan = { kind: "fixed"; amount: Pence } | { kind: "minimum"; extra?: Pence };

export interface RepaymentResult {
  /** Months to clear the balance. null when it never clears, or not within MAX_MONTHS. */
  months: number | null;
  totalInterest: Pence | null;
  totalPaid: Pence | null;
  /** The first month's payment. */
  firstPayment: Pence;
  /** True when a fixed payment doesn't cover the interest, so the balance never goes down. */
  neverClears: boolean;
  /** Balance at the end of each year (and the last month), for a chart or table. */
  yearly: { month: number; balance: Pence }[];
}

/** Paying a balance off month by month with no new spending. */
export function repay(balance: Pence, apr: number, plan: RepaymentPlan): RepaymentResult {
  const start = Math.max(0, Math.round(balance));
  const extra = plan.kind === "minimum" ? Math.max(0, Math.round(plan.extra ?? 0)) : 0;
  const pay = (bal: Pence) => {
    const owed = bal + monthlyInterest(bal, apr);
    return Math.min(owed, plan.kind === "fixed" ? Math.max(0, Math.round(plan.amount)) : illustrativeMinimum(bal, apr) + extra);
  };
  const firstPayment = pay(start);
  if (start === 0) return { months: 0, totalInterest: 0, totalPaid: 0, firstPayment: 0, neverClears: false, yearly: [] };
  if (plan.kind === "fixed" && firstPayment <= monthlyInterest(start, apr)) {
    return { months: null, totalInterest: null, totalPaid: null, firstPayment, neverClears: true, yearly: [{ month: 0, balance: start }] };
  }
  let bal = start;
  let interest = 0;
  let paid = 0;
  const yearly: RepaymentResult["yearly"] = [{ month: 0, balance: start }];
  for (let month = 1; month <= MAX_MONTHS; month++) {
    const i = monthlyInterest(bal, apr);
    const p = pay(bal);
    bal = bal + i - p;
    interest += i;
    paid += p;
    if (bal <= 0) {
      yearly.push({ month, balance: 0 });
      return { months: month, totalInterest: interest, totalPaid: paid, firstPayment, neverClears: false, yearly };
    }
    if (month % 12 === 0) yearly.push({ month, balance: bal });
  }
  return { months: null, totalInterest: null, totalPaid: null, firstPayment, neverClears: false, yearly };
}

/** "1 year and 11 months", "8 months", "more than 50 years". */
export function durationText(months: number | null): string {
  if (months === null) return "more than 50 years";
  if (months === 0) return "no time: there's nothing to pay";
  const y = Math.floor(months / 12);
  const m = months % 12;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [y && part(y, "year"), m && part(m, "month")].filter(Boolean).join(" and ");
}
