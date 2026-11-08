// Goal progress, measured only from real transactions with lib/finance. Pure: the clock is ctx.today.
// Goals track spending on this card. They never claim money was saved anywhere, and never predict.
import { budgetStatus, spendingSummary } from "../finance";
import { formatLongDate, formatPence } from "../format";
import type { InsightContext } from "../insights";
import { historyStart, monthKey, monthName, monthRange, monthsBetween, nextMonth, previousMonth } from "../dial/months";
import type { Goal, GoalProgress, GoalSpec } from "../dial/types";
import type { ISODate, Pence, Transaction } from "../types";
import { balanceForUtilisation, utilisationPercent } from "../learn/credit";
import { isNewId, paymentHistory } from "../payments/rules";
import { daysUntilDue } from "../finance";
import { describeGoal } from "./describe";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const percentOf = (part: number, whole: number) => Math.min(100, Math.max(0, Math.round((part * 100) / whole)));
/** At or past four fifths of a limit counts as "at risk". Whole-number arithmetic, no floats. */
const nearLimit = (spent: number, limit: number) => spent * 5 >= limit * 4;
const NOT_SAVINGS = "This tracks spending on this card, not money in a savings account.";

function pendingLimitation(ctx: InsightContext, ids: string[]) {
  const pending = new Set(ctx.txns.filter((t) => t.status === "pending").map((t) => t.id));
  const n = ids.filter((id) => pending.has(id)).length;
  return n ? [`Includes ${plural(n, "pending item")}, which may still change.`] : [];
}

const soFarLimitation = (ctx: InsightContext) => {
  const r = monthRange(monthKey(ctx.today), ctx.today);
  return `${monthName(monthKey(ctx.today), ctx.today)} so far covers ${plural(r.days, "day")}.`;
};

function categoryCap(spec: Extract<GoalSpec, { kind: "category_cap" }>, ctx: InsightContext): Omit<GoalProgress, "goalId" | "title"> {
  const cat = spec.category.toLowerCase();
  const inCat = (t: Transaction) => t.category === spec.category;
  const now = monthRange(monthKey(ctx.today), ctx.today);
  const s = spendingSummary(ctx.txns.filter(inCat), now.from, now.to);
  const left = spec.monthlyLimit - s.total;
  const last = monthRange(previousMonth(monthKey(ctx.today)), ctx.today, historyStart(ctx.txns));
  const lastSpent = !last.partial && last.days ? spendingSummary(ctx.txns.filter(inCat), last.from, last.to).total : null;
  const lastText = lastSpent === null ? "" : ` In ${last.label}, you spent ${formatPence(lastSpent)}, ${lastSpent > spec.monthlyLimit ? "over" : "within"} the limit.`;
  return {
    percent: percentOf(s.total, spec.monthlyLimit),
    status: left < 0 ? "missed" : nearLimit(s.total, spec.monthlyLimit) ? "at_risk" : "on_track",
    statement:
      (left < 0
        ? `In ${now.label}, you've spent ${formatPence(s.total)} on ${cat}, ${formatPence(-left)} over your ${formatPence(spec.monthlyLimit)} limit.`
        : `In ${now.label}, you've spent ${formatPence(s.total)} of your ${formatPence(spec.monthlyLimit)} limit on ${cat}, leaving ${formatPence(left)}.`) + lastText,
    limitations: [soFarLimitation(ctx), ...pendingLimitation(ctx, s.ids)],
  };
}

function spendReduction(spec: Extract<GoalSpec, { kind: "spend_reduction" }>, ctx: InsightContext): Omit<GoalProgress, "goalId" | "title"> {
  const current = monthKey(ctx.today);
  const base = monthRange(spec.baselineMonth, ctx.today, historyStart(ctx.txns));
  const baseName = monthName(spec.baselineMonth, ctx.today);
  if (base.partial || !base.days) {
    const why = spec.baselineMonth >= current ? `${baseName} isn't over yet` : `your history doesn't cover all of ${baseName}`;
    return { percent: null, status: "not_measurable", statement: `This can't be measured: ${why}, so it can't be the month to compare with.`, limitations: ["The month to compare with needs to be a complete month in your history.", NOT_SAVINGS] };
  }
  const baseline = spendingSummary(ctx.txns, base.from, base.to).total;
  const allMonths = monthsBetween(nextMonth(spec.baselineMonth), spec.by);
  const lastDone = previousMonth(current);
  const done = allMonths.filter((k) => k <= lastDone);
  const counted = done.map((k) => {
    const r = monthRange(k, ctx.today);
    const s = spendingSummary(ctx.txns, r.from, r.to);
    return { k, spent: s.total, ids: s.ids };
  });
  const cumulative = counted.reduce((sum, m) => sum + (baseline - m.spent), 0);
  const inWindow = current > spec.baselineMonth && current <= spec.by;
  const now = monthRange(current, ctx.today);
  const soFar = inWindow ? spendingSummary(ctx.txns, now.from, now.to) : null;
  const soFarText = soFar ? ` In ${now.label}, you've spent ${formatPence(soFar.total)}; it counts once the month is over.` : "";
  const limitations = [
    `Compared with ${baseName}'s spending of ${formatPence(baseline)}. Only complete months count.`,
    ...(soFar ? [soFarLimitation(ctx)] : []),
    NOT_SAVINGS,
    ...pendingLimitation(ctx, [...counted.flatMap((m) => m.ids), ...(soFar?.ids ?? [])]),
  ];
  if (!counted.length) {
    return {
      percent: null,
      status: "not_measurable",
      statement: `Progress starts counting when ${monthName(allMonths[0], ctx.today)} is over, compared with the ${formatPence(baseline)} you spent in ${baseName}.${soFarText}`,
      limitations,
    };
  }
  const span = counted.length === 1 ? monthName(counted[0].k, ctx.today) : `${monthName(counted[0].k, ctx.today)} to ${monthName(counted[counted.length - 1].k, ctx.today)}`;
  const over = done.length === allMonths.length;
  const status: GoalProgress["status"] =
    cumulative >= spec.target ? "met" : over ? "missed" : cumulative * allMonths.length >= spec.target * counted.length ? "on_track" : "at_risk";
  const progressText =
    cumulative >= 0
      ? `You've spent ${formatPence(cumulative)} less than ${baseName}'s ${formatPence(baseline)} a month over ${plural(counted.length, "month")} (${span}), towards ${formatPence(spec.target)}.`
      : `You've spent ${formatPence(-cumulative)} more than ${baseName}'s ${formatPence(baseline)} a month over ${plural(counted.length, "month")} (${span}), so there's no progress towards ${formatPence(spec.target)} yet.`;
  return { percent: percentOf(cumulative, spec.target), status, statement: progressText + soFarText, limitations };
}

function stayInBudget(ctx: InsightContext): Omit<GoalProgress, "goalId" | "title"> {
  const b = budgetStatus(ctx.txns, ctx.settings, ctx.today);
  if (!b) {
    return {
      percent: null,
      status: "not_measurable",
      statement: "You haven't set a monthly budget, so there's nothing to measure against yet.",
      limitations: ["Set a monthly budget in Spend Pause to track this goal."],
    };
  }
  const now = monthRange(monthKey(ctx.today), ctx.today);
  const s = spendingSummary(ctx.txns, now.from, now.to);
  return {
    percent: percentOf(b.spent, b.budget),
    status: b.remaining < 0 ? "missed" : nearLimit(b.spent, b.budget) ? "at_risk" : "on_track",
    statement:
      b.remaining < 0
        ? `In ${now.label}, you've spent ${formatPence(b.spent)}, ${formatPence(-b.remaining)} over your ${formatPence(b.budget)} monthly budget.`
        : `In ${now.label}, you've spent ${formatPence(b.spent)} of your ${formatPence(b.budget)} monthly budget, leaving ${formatPence(b.remaining)}.`,
    limitations: [
      soFarLimitation(ctx),
      ...pendingLimitation(ctx, s.ids),
      ...(ctx.settings.enabled ? [] : ["Spend Pause is off, so purchases aren't checked against this budget."]),
    ],
  };
}

const BALANCE_MOVES = "Your balance goes down with payments and refunds, and up with new spending, including pending items.";

/** Shared by pay_down and utilisation: progress from the balance when the goal was set towards a target balance. */
function towardsBalance(start: Pence, target: Pence, by: string, ctx: InsightContext, lead: string): Omit<GoalProgress, "goalId" | "title"> {
  const now = ctx.account.currentBalance;
  const byName = monthName(by, ctx.today);
  const late = monthKey(ctx.today) > by;
  if (now <= target) return { percent: 100, status: "met", statement: `${lead} Your balance is ${formatPence(now)}, at or under ${formatPence(target)}. Goal reached.`, limitations: [BALANCE_MOVES] };
  const percent = start > target ? percentOf(start - now, start - target) : 0;
  const moved = now < start ? `down ${formatPence(start - now)} from ${formatPence(start)} when you set this goal` : now > start ? `up ${formatPence(now - start)} since you set this goal` : "the same as when you set this goal";
  return {
    percent,
    status: late ? "missed" : now > start ? "at_risk" : "on_track",
    statement: `${lead} Your balance is ${formatPence(now)}, ${moved}. ${formatPence(now - target)} to go to reach ${formatPence(target)} by the end of ${byName}.`,
    limitations: [BALANCE_MOVES],
  };
}

function saveUp(spec: Extract<GoalSpec, { kind: "save_up" }>, ctx: InsightContext): Omit<GoalProgress, "goalId" | "title"> {
  const left = spec.target - spec.saved;
  const current = monthKey(ctx.today);
  const months = monthsBetween(current, spec.by).length;
  const limitations = ["Capital for Everyone can't see your savings account. This uses the amount you entered."];
  if (left <= 0) return { percent: 100, status: "met", statement: `You've saved ${formatPence(spec.saved)}, reaching your ${formatPence(spec.target)} goal.`, limitations };
  if (current > spec.by) return { percent: percentOf(spec.saved, spec.target), status: "missed", statement: `You've saved ${formatPence(spec.saved)} of ${formatPence(spec.target)}. The date you chose has passed; you can set a new one.`, limitations };
  // Whole pence, rounded up, so the monthly figure always gets there.
  const perMonth = Math.ceil(left / Math.max(1, months));
  return {
    percent: percentOf(spec.saved, spec.target),
    status: "on_track",
    statement: `You've saved ${formatPence(spec.saved)} of ${formatPence(spec.target)}. ${formatPence(left)} to go: about ${formatPence(perMonth)} a month until the end of ${monthName(spec.by, ctx.today)}.`,
    limitations,
  };
}

/** Paid towards the current bill: payments made in the app, all of which are after the statement in this demo. */
const paidThisBill = (ctx: InsightContext) => paymentHistory(ctx.txns).filter((t) => isNewId(t.id)).reduce((s, t) => s - t.amount, 0);

function payOnTime(ctx: InsightContext): Omit<GoalProgress, "goalId" | "title"> {
  const a = ctx.account;
  const days = daysUntilDue(a, ctx.today);
  const left = Math.max(0, a.minimumPayment - paidThisBill(ctx));
  const limitations = ["Only the current bill is tracked: earlier bills aren't in this demo's data."];
  if (a.statementBalance === 0 || left === 0)
    return { percent: 100, status: "met", statement: a.statementBalance === 0 ? "This bill is paid in full. Nice work." : "The minimum for this bill is paid, on time.", limitations };
  if (days < 0) return { percent: null, status: "missed", statement: `${formatPence(left)} of this bill's minimum is still to pay. It was due on ${formatLongDate(a.paymentDueDate)}.`, limitations };
  return {
    percent: null,
    status: days <= 3 ? "at_risk" : "on_track",
    statement: `${formatPence(left)} is due by ${formatLongDate(a.paymentDueDate)}, ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}.`,
    limitations,
  };
}

/** How a goal is going, from the same transactions every screen reads. */
export function goalProgress(goal: Goal, ctx: InsightContext): GoalProgress {
  const spec = goal.spec;
  const body = (() => {
    switch (spec.kind) {
      case "category_cap":
        return categoryCap(spec, ctx);
      case "spend_reduction":
        return spendReduction(spec, ctx);
      case "stay_in_budget":
        return stayInBudget(ctx);
      case "pay_down":
        return towardsBalance(spec.startBalance, spec.target, spec.by, ctx, "");
      case "utilisation": {
        const used = utilisationPercent(ctx.account.currentBalance, ctx.account.creditLimit);
        const target = balanceForUtilisation(ctx.account.creditLimit, spec.percent);
        return towardsBalance(spec.startBalance, target, spec.by, ctx, used === null ? "" : `You're using ${used}% of your limit.`);
      }
      case "save_up":
        return saveUp(spec, ctx);
      case "pay_on_time":
        return payOnTime(ctx);
    }
  })();
  return { goalId: goal.id, title: describeGoal(spec, ctx.today), ...body, statement: body.statement.trim() };
}

/** The four milestones on the way to a goal, and which are reached. Only for goals measured in percent. */
export function goalMilestones(percent: number | null) {
  if (percent === null) return [];
  return [25, 50, 75, 100].map((at) => ({ at, reached: percent >= at }));
}

/** What has happened since a goal was set, newest first: payments for balance goals, updates for saving goals. */
export function goalHistory(goal: Goal, ctx: InsightContext): { date: ISODate; text: string }[] {
  const s = goal.spec;
  if (s.kind === "save_up") return [...s.log].reverse().map(([date, saved]) => ({ date, text: `Saved so far: ${formatPence(saved)}` }));
  if (s.kind === "pay_down" || s.kind === "utilisation" || s.kind === "pay_on_time")
    return paymentHistory(ctx.txns)
      .filter((t) => t.date >= goal.createdOn)
      .map((t) => ({ date: t.date, text: `Payment of ${formatPence(-t.amount)}` }));
  return [];
}
