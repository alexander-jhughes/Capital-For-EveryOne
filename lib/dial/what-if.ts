// What-if simulator: deterministic arithmetic on the person's own figures, every assumption stated.
// Results are hypothetical, always labelled "This is an estimate, not a forecast", and never move money,
// change a balance or make a payment. Whole pence throughout; anything rounded is rounded against the person
// (a reduction needed per month is rounded up).
import { payoffEstimate, spendingSummary } from "../finance";
import { formatPence } from "../format";
import type { InsightContext } from "../insights";
import type { Pence } from "../types";
import { historyStart, monthKey, monthName, monthRange, monthsBetween, nextMonth, previousMonth, isMonthKey } from "./months";
import type { WhatIfResult, WhatIfScenario } from "./types";

export const ESTIMATE_LINE = "This is an estimate, not a forecast.";
/** A reduction of up to a fifth of last month's spending counts as "fits"; more than that is a "stretch". */
const FITS_SHARE = 5;

type Figure = WhatIfResult["figures"][number];
const money = (label: string, value: Pence): Figure => ({ label, value, display: formatPence(value) });
const count = (label: string, value: number, word: string): Figure => ({ label, value, display: `${value} ${word}${value === 1 ? "" : "s"}` });

const COMMON = [
  "Card payments aren't counted as spending, and refunds are taken off it.",
  "Nothing is changed: no money is moved and your balance stays as it is.",
];

function result(scenario: WhatIfScenario, title: string, statement: string, figures: Figure[], assumptions: string[], outcome: WhatIfResult["outcome"]): WhatIfResult {
  return { scenario, hypothetical: true, title, statement, figures, assumptions: [...new Set([...assumptions, ...COMMON])], outcome };
}

/** The last complete month before the demo month, if the history covers all of it. */
function lastFullMonth(ctx: InsightContext) {
  const key = previousMonth(monthKey(ctx.today));
  const r = monthRange(key, ctx.today, historyStart(ctx.txns));
  if (r.partial || !r.days) return null;
  return { key, name: monthName(key, ctx.today), ...r };
}

const valid = (p: number) => Number.isFinite(p) && p > 0;
/** Pence as given, rounded up to a whole penny if a fraction slipped in. */
const whole = (p: number) => Math.ceil(p);

function spendLess(s: Extract<WhatIfScenario, { kind: "spend_less" }>, ctx: InsightContext): WhatIfResult {
  const cat = s.category;
  const on = cat ? ` on ${cat.toLowerCase()}` : "";
  const title = `Spending ${valid(s.amount) ? formatPence(whole(s.amount)) : "less"} less${on}`;
  const base = lastFullMonth(ctx);
  const nextName = monthName(nextMonth(monthKey(ctx.today)), ctx.today);
  if (!base) {
    return result(s, title, "There isn't a full month of history yet to start from.", [], ["Needs a complete month of spending to compare with."], "not_enough_data");
  }
  const txns = cat ? ctx.txns.filter((t) => t.category === cat) : ctx.txns;
  const baseline = spendingSummary(txns, base.from, base.to).total;
  const assumptions = [
    `Starts from ${base.name}'s spending${on} of ${formatPence(baseline)}, the last full month.`,
    `Assumes your spending${on} in ${nextName} would otherwise be the same as in ${base.name}.`,
  ];
  if (!valid(s.amount)) return result(s, title, "The amount needs to be more than £0.", [], assumptions, "not_possible");
  const amount = whole(s.amount);
  if (baseline <= 0) {
    return result(s, title, `You spent ${formatPence(baseline)}${on} in ${base.name}, so there's nothing to spend less than.`, [money(`Spent${on} in ${base.name}`, baseline)], assumptions, "not_possible");
  }
  if (amount > baseline) {
    return result(
      s,
      title,
      `Spending ${formatPence(amount)} less${on} isn't possible from ${base.name}'s ${formatPence(baseline)}: it's more than you spent.`,
      [money("Spending less by", amount), money(`Spent${on} in ${base.name}`, baseline)],
      assumptions,
      "not_possible",
    );
  }
  const after = baseline - amount;
  return result(
    s,
    title,
    `If you spend ${formatPence(amount)} less${on} than ${base.name}'s ${formatPence(baseline)}, you'd spend ${formatPence(after)}${on} in ${nextName}.`,
    [money("Spending less by", amount), money(`Spent${on} in ${base.name}`, baseline), money(`Spending${on} in ${nextName}`, after)],
    assumptions,
    amount * FITS_SHARE <= baseline ? "fits" : "stretch",
  );
}

function saveBy(s: Extract<WhatIfScenario, { kind: "save_by" }>, ctx: InsightContext): WhatIfResult {
  const current = monthKey(ctx.today);
  const byName = isMonthKey(s.by) ? monthName(s.by, ctx.today) : "that month";
  const title = `${valid(s.target) ? formatPence(whole(s.target)) : "An amount"} by ${byName}`;
  const notSavings = "This is about spending less on your card, not money in a savings account: Dial can't see or move savings.";
  if (!isMonthKey(s.by) || s.by <= current) {
    const why = isMonthKey(s.by) && s.by === current ? `${byName} has already started, so there are no full months left before it ends.` : `${byName} has already passed.`;
    return result(s, title, why, [], [notSavings, "Counts whole months from next month."], "not_possible");
  }
  const months = monthsBetween(nextMonth(current), s.by);
  const span = months.length === 1 ? monthName(months[0], ctx.today) : `${monthName(months[0], ctx.today)} to ${monthName(months[months.length - 1], ctx.today)}`;
  const base = lastFullMonth(ctx);
  const assumptions = [notSavings, `Counts ${months.length === 1 ? "1 month" : `${months.length} months`}: ${span}.`, "The amount needed each month is rounded up to the next penny."];
  if (!valid(s.target)) return result(s, title, "The amount needs to be more than £0.", [], assumptions, "not_possible");
  const target = whole(s.target);
  const perMonth = Math.ceil(target / months.length);
  const figures = [money("Amount to reach", target), money("Less each month", perMonth), count("Months", months.length, "month")];
  const needed = `To reach ${formatPence(target)} by the end of ${byName}, you'd need to spend ${formatPence(perMonth)} less each month for ${figures[2].display}`;
  if (!base) return result(s, title, `${needed}. There isn't a full month of history yet to compare that with.`, figures, assumptions, "not_enough_data");
  const baseline = spendingSummary(ctx.txns, base.from, base.to).total;
  assumptions.splice(1, 0, `Compared with ${base.name}'s spending of ${formatPence(baseline)}, the last full month, as if each month were the same.`);
  figures.push(money(`Spent in ${base.name}`, baseline));
  if (perMonth > baseline) {
    return result(s, title, `${needed}, which is more than the ${formatPence(baseline)} you spent in ${base.name}.`, figures, assumptions, "not_possible");
  }
  return result(
    s,
    title,
    `${needed}, compared with the ${formatPence(baseline)} you spent in ${base.name}. That's spending less, not money set aside in savings.`,
    figures,
    assumptions,
    perMonth * FITS_SHARE <= baseline ? "fits" : "stretch",
  );
}

function payMonthly(s: Extract<WhatIfScenario, { kind: "pay_monthly" }>, ctx: InsightContext): WhatIfResult {
  const a = ctx.account;
  const title = `Paying ${valid(s.amount) ? formatPence(whole(s.amount)) : "an amount"} a month`;
  const assumptions = [
    `Starts from your current balance of ${formatPence(a.currentBalance)}.`,
    `Interest at your ${a.apr}% APR, worked out each month as a twelfth of it.`,
    "No new spending on the card.",
    "The same payment every month, on time, with no fees and no change to your rate.",
    "This doesn't make a payment. Payments are only made on the Pay screen, after you confirm.",
  ];
  if (!valid(s.amount)) return result(s, title, "The payment needs to be more than £0.", [], assumptions, "not_possible");
  const amount = whole(s.amount);
  if (a.currentBalance <= 0) {
    return result(s, title, `Your balance is ${formatPence(a.currentBalance)}, so there's nothing to pay off.`, [money("Current balance", a.currentBalance)], assumptions, "not_possible");
  }
  const est = payoffEstimate(a.currentBalance, a.apr, amount);
  // The same first-month interest payoffEstimate works out, so the two can't disagree.
  const firstInterest = Math.round(a.currentBalance * (a.apr / 100 / 12));
  const minimum = amount < a.minimumPayment ? ` It's also less than your current minimum payment of ${formatPence(a.minimumPayment)}.` : "";
  const minFigure = minimum ? [money("Minimum payment", a.minimumPayment)] : [];
  if (est.months === null) {
    const why =
      amount <= firstInterest
        ? `${formatPence(amount)} a month wouldn't cover the interest on your ${formatPence(a.currentBalance)} balance, about ${formatPence(firstInterest)} in the first month, so the balance wouldn't go down.`
        : `${formatPence(amount)} a month wouldn't clear your ${formatPence(a.currentBalance)} balance within 50 years.`;
    return result(
      s,
      title,
      why + minimum,
      [money("Monthly payment", amount), money("Current balance", a.currentBalance), ...(amount <= firstInterest ? [money("Interest in the first month", firstInterest)] : []), ...minFigure],
      assumptions,
      "not_possible",
    );
  }
  const months = count("Months to clear it", est.months, "month");
  return result(
    s,
    title,
    `If you paid ${formatPence(amount)} a month, you'd clear your ${formatPence(a.currentBalance)} balance in about ${months.display}, paying about ${formatPence(est.totalInterest)} in interest.${minimum}`,
    [money("Monthly payment", amount), money("Current balance", a.currentBalance), months, money("Interest in total", est.totalInterest), ...minFigure],
    assumptions,
    "fits",
  );
}

/** A hypothetical, worked out from the person's own figures. Never changes anything. */
export function simulate(s: WhatIfScenario, ctx: InsightContext): WhatIfResult {
  switch (s.kind) {
    case "spend_less":
      return spendLess(s, ctx);
    case "save_by":
      return saveBy(s, ctx);
    case "pay_monthly":
      return payMonthly(s, ctx);
  }
}
