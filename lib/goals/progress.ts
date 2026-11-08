// Goal progress, measured only from real transactions with lib/finance. Pure: the clock is ctx.today.
// Goals track spending on this card. They never claim money was saved anywhere, and never predict.
import { budgetStatus, spendingSummary } from "../finance";
import { formatPence } from "../format";
import type { InsightContext } from "../insights";
import { historyStart, monthKey, monthName, monthRange, monthsBetween, nextMonth, previousMonth } from "../dial/months";
import type { Goal, GoalProgress, GoalSpec } from "../dial/types";
import type { Transaction } from "../types";
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

/** How a goal is going, from the same transactions every screen reads. */
export function goalProgress(goal: Goal, ctx: InsightContext): GoalProgress {
  const spec = goal.spec;
  const body =
    spec.kind === "category_cap" ? categoryCap(spec, ctx) : spec.kind === "spend_reduction" ? spendReduction(spec, ctx) : stayInBudget(ctx);
  return { goalId: goal.id, title: describeGoal(spec, ctx.today), ...body };
}
