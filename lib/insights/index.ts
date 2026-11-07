// Financial intelligence: deterministic, evidence-backed observations built only from the account and transactions.
// Pure (the clock is ctx.today), so the server and the browser derive exactly the same insight for the same id.
// Sums come from lib/finance; this layer only compares them and words what changed, never why.
import { availableCredit, budgetStatus, daysUntilDue, monthOverMonth, spendingSummary } from "../finance";
import { daysBetween, formatLongDate, formatMonth, formatPence } from "../format";
import type { Category, ISODate, Pence, Transaction } from "../types";
import {
  INSIGHT_ID,
  INSIGHT_KINDS,
  type Insight,
  type InsightContext,
  type InsightFigure,
  type InsightKind,
  type InsightPeriod,
  type InsightReport,
} from "./types";

export * from "./types";

/** Same rule as lib/finance: card payments are never spending. */
const isSpending = (t: Transaction) => t.category !== "Payments";
const DAY = 86_400_000;
const ESTIMATE = "Based on past charges; Dial can't see future bills.";
/** Earlier charges needed before anything can be called larger than usual. */
const MIN_HISTORY = 3;
/** Shops and categories the saving observations look at. Factual only: they never say what to do. */
const DISCRETIONARY: Category[] = ["Eating out", "Shopping"];
const PATTERNS = [
  { unit: "month", min: 26, max: 35, minCharges: 2 },
  // Two charges a week apart is too weak a pattern, so weekly needs three.
  { unit: "week", min: 6, max: 8, minCharges: 3 },
] as const;

const addDays = (d: ISODate, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Same day next month, or that month's last day. */
function nextMonth(d: ISODate): ISODate {
  const [y, m, day] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10);
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const sum = (xs: Pence[]) => xs.reduce((s, x) => s + x, 0);
const median = (xs: Pence[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const money = (label: string, value: Pence): InsightFigure => ({ label, display: formatPence(value), value, unit: "pence" });
const day = (label: string, value: ISODate): InsightFigure => ({ label, display: formatLongDate(value), value, unit: "date" });
const count = (label: string, value: number, display: string): InsightFigure => ({ label, display, value, unit: "count" });

const skip = (reason: string): InsightReport => ({ insights: [], cannotEstablish: [reason] });
// Merchant names become ids; one that can't travel safely between server and browser is left out rather than mangled.
const report = (insights: Insight[], cannotEstablish: string[] = []): InsightReport => ({
  insights: insights.filter((i) => INSIGHT_ID.test(i.id)),
  cannotEstablish,
});

function pendingNote(ctx: InsightContext, ids: string[]) {
  const pending = new Set(ctx.txns.filter((t) => t.status === "pending").map((t) => t.id));
  const n = ids.filter((id) => pending.has(id)).length;
  return n ? [`Includes ${plural(n, "pending item")}.`] : [];
}

// ---- Periods ----

/** "1 to 8 November", "28 September to 4 October", or "8 November" for a single day. */
export function periodLabel(from: ISODate, to: ISODate): string {
  const end = `${Number(to.slice(8))} ${formatMonth(to)}`;
  if (from === to) return end;
  return from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8))} to ${end}` : `${Number(from.slice(8))} ${formatMonth(from)} to ${end}`;
}
const period = (from: ISODate, to: ISODate): InsightPeriod => ({ from, to, label: periodLabel(from, to) });

/** This month to date, the same days of last month (as monthOverMonth compares them), and last month in full. */
export function monthPeriods(today: ISODate) {
  const m = monthOverMonth([], today); // only its dates are used
  return {
    current: period(m.thisMonth.from, m.thisMonth.to),
    previous: period(m.lastMonthSamePeriod.from, m.lastMonthSamePeriod.to),
    previousMonth: period(m.lastMonth.from, m.lastMonth.to),
  };
}

/** Spending in each full Monday to Sunday week, from the first Monday of the history to today. */
export function weekBuckets(ctx: InsightContext) {
  const first = ctx.txns.map((t) => t.date).sort()[0];
  const weeks: { period: InsightPeriod; total: Pence; ids: string[] }[] = [];
  if (!first) return weeks;
  // Start on a Monday we can see, so the first week isn't missing days from before the history.
  const startDay = new Date(`${first}T12:00:00Z`).getUTCDay();
  for (let from = addDays(first, (8 - startDay) % 7); addDays(from, 6) <= ctx.today; from = addDays(from, 7)) {
    const s = spendingSummary(ctx.txns, from, addDays(from, 6));
    weeks.push({ period: period(from, s.to), total: s.total, ids: s.ids });
  }
  return weeks;
}

function comparison(ctx: InsightContext) {
  const p = monthPeriods(ctx.today);
  const days = (x: InsightPeriod) => daysBetween(x.from, x.to) + 1;
  const partial = addDays(ctx.today, 1).slice(0, 7) === ctx.today.slice(0, 7);
  return {
    p,
    now: spendingSummary(ctx.txns, p.current.from, p.current.to),
    before: spendingSummary(ctx.txns, p.previous.from, p.previous.to),
    partial,
    soFar: partial ? [`${formatMonth(ctx.today)} so far covers ${plural(days(p.current), "day")}.`] : [],
    shorter: days(p.previous) < days(p.current) ? [`${formatMonth(p.previous.from)} has only ${days(p.previous)} days.`] : [],
    covered: ctx.txns.some((t) => t.date <= p.previous.from),
  };
}

/** "; most of the increase came from Groceries (£124.72 more)": what moved, as contribution, never as cause. */
function contributions(diff: Pence, parts: { name: string; diff: Pence }[]) {
  if (diff === 0) return { text: "", figures: [] };
  const [word, more] = diff > 0 ? ["increase", "more"] : ["decrease", "less"];
  const movers = parts
    .filter((x) => x.diff * diff > 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name));
  if (movers.length === 1 && parts.every((x) => x === movers[0] || x.diff === 0)) return { text: `; all of the ${word} came from ${movers[0].name}`, figures: [] };
  const share = (k: number) => 2 * Math.abs(sum(movers.slice(0, k).map((x) => x.diff))) > Math.abs(diff);
  let k = 1;
  while (k < Math.min(3, movers.length) && !share(k)) k++;
  const top = movers.slice(0, k);
  const named = list(top.map((x) => `${x.name} (${formatPence(Math.abs(x.diff))} ${more})`));
  return {
    text: share(k) ? `; most of the ${word} came from ${named}` : `; the biggest ${word}s were in ${named}`,
    figures: top.map((x) => money(`${x.name}, ${more} than before`, Math.abs(x.diff))),
  };
}

// ---- Spending ----

function change(ctx: InsightContext, category?: Category): InsightReport {
  const c = comparison(ctx);
  const [cur, prev] = [c.p.current.label, c.p.previous.label];
  const pick = (s: typeof c.now) => (category ? (s.byCategory.find((x) => x.category === category) ?? { total: 0, ids: [] }) : s);
  const [now, before] = [pick(c.now), pick(c.before)];
  if (!now.ids.length && !before.ids.length) return skip(`There's no ${category ? `${category} ` : ""}spending from ${cur} or ${prev} to compare.`);
  if (!c.covered) return skip(`There's no history from ${prev} to compare with.`);

  // Shops explain a category; categories explain the total.
  const [nowIds, beforeIds] = [new Set(now.ids), new Set(before.ids)];
  const moved = new Map<string, Pence>();
  for (const t of ctx.txns.filter((t) => nowIds.has(t.id) || beforeIds.has(t.id))) {
    const name = category ? t.merchant : t.category;
    moved.set(name, (moved.get(name) ?? 0) + (nowIds.has(t.id) ? t.amount : -t.amount));
  }
  const diff = now.total - before.total;
  const parts = contributions(diff, [...moved].map(([name, d]) => ({ name, diff: d })));
  const on = category ? ` on ${category}` : "";
  const isNew = before.ids.length === 0;
  const statement = isNew
    ? `You've spent ${formatPence(now.total)}${on} from ${cur}, and nothing${category ? " on it" : ""} from ${prev}.`
    : `You've spent ${formatPence(now.total)}${on} from ${cur}, ${diff === 0 ? "the same as" : `${formatPence(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than`} the ${formatPence(before.total)} you spent from ${prev}${parts.text}.`;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "the same";
  const evidenceIds = [...now.ids, ...before.ids];
  return report([
    {
      id: category ? `category_change:${category}` : "spending_change",
      kind: category ? "category_change" : "spending_change",
      ...(category && { subject: category }),
      title: category ? (isNew ? `New spending on ${category}` : `${category} spending is ${direction}`) : `Spending is ${direction}`,
      statement,
      figures: [
        money(`Spent${on} from ${cur}`, now.total),
        ...(isNew ? [] : [...(diff === 0 ? [] : [money(diff > 0 ? "More than before" : "Less than before", Math.abs(diff))]), money(`Spent${on} from ${prev}`, before.total)]),
        ...(isNew ? [] : parts.figures),
      ],
      evidenceIds,
      confidence: c.partial ? "medium" : "high",
      periods: { current: c.p.current, previous: c.p.previous },
      limitations: [...c.soFar, ...c.shorter, ...pendingNote(ctx, evidenceIds)],
    },
  ]);
}

/** All spending this month so far against the same days last month, with the categories that moved most. */
export const spendingChange = (ctx: InsightContext) => change(ctx);

/** One category this month so far against the same days last month, with the shops that moved most. */
export const categoryChange = (ctx: InsightContext, category: Category) =>
  category === "Payments" ? skip("Card payments aren't counted as spending.") : change(ctx, category);

/** The categories most of this month's spending went on. */
export function topCategories(ctx: InsightContext): InsightReport {
  const c = comparison(ctx);
  const cur = c.p.current.label;
  const top = c.now.byCategory.filter((x) => x.total > 0).slice(0, 3);
  if (!top.length) return skip(`There's no spending from ${cur} yet.`);
  return report([
    {
      id: "top_categories",
      kind: "top_categories",
      title: "Where your money went",
      statement: `Of the ${formatPence(c.now.total)} you've spent from ${cur}, the most went on ${list(top.map((x) => `${x.category} (${formatPence(x.total)})`))}.`,
      figures: [money(`Spent from ${cur}`, c.now.total), ...top.map((x) => money(`${x.category} from ${cur}`, x.total))],
      evidenceIds: c.now.ids,
      confidence: "high",
      periods: { current: c.p.current },
      limitations: [...c.soFar, ...pendingNote(ctx, c.now.ids)],
    },
  ]);
}

// ---- Patterns ----

/** Shops that charge a similar amount (within 25%) at a regular interval, and are still doing so. Soonest next first. */
function regularCharges(ctx: InsightContext) {
  const byShop = new Map<string, Transaction[]>();
  for (const t of ctx.txns) if (isSpending(t) && t.amount > 0) byShop.set(t.merchant, [...(byShop.get(t.merchant) ?? []), t]);
  const out: { merchant: string; charges: Transaction[]; unit: "month" | "week"; next: ISODate }[] = [];
  for (const [merchant, all] of byShop) {
    const charges = [...all].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const gaps = charges.slice(1).map((t, i) => daysBetween(charges[i].date, t.date));
    const amounts = charges.map((t) => t.amount);
    const pattern = PATTERNS.find((p) => charges.length >= p.minCharges && gaps.every((g) => g >= p.min && g <= p.max));
    const last = charges[charges.length - 1];
    if (!pattern || Math.max(...amounts) * 4 > Math.min(...amounts) * 5 || daysBetween(last.date, ctx.today) > pattern.max) continue;
    out.push({ merchant, charges, unit: pattern.unit, next: pattern.unit === "month" ? nextMonth(last.date) : addDays(last.date, 7) });
  }
  return out.sort((a, b) => a.next.localeCompare(b.next) || a.merchant.localeCompare(b.merchant));
}

/** Regular charges, any price change at the latest charge, and when the next one may come (an estimate). */
export function recurring(ctx: InsightContext): InsightReport {
  const regular = regularCharges(ctx);
  if (!regular.length) return skip("No regular charges were found.");
  return report(
    regular.map(({ merchant, charges, unit, next }): Insight => {
      const [prev, last] = charges.slice(-2);
      const changed = last.amount !== prev.amount;
      const way = last.amount > prev.amount ? "up" : "down";
      const ids = charges.map((t) => t.id);
      return {
        id: `recurring:${merchant}`,
        kind: "recurring",
        subject: merchant,
        title: changed ? `${merchant} price went ${way}` : `${merchant} is a regular charge`,
        statement: `${merchant} charges ${formatPence(last.amount)} about once a ${unit}${changed ? `, ${way} from ${formatPence(prev.amount)}` : ""} (${charges.length} charges so far); the next charge is estimated around ${formatLongDate(next)}.`,
        figures: [
          money("Latest charge", last.amount),
          ...(changed ? [money("Charge before that", prev.amount)] : []),
          count("Charges so far", charges.length, `${charges.length} charges`),
          day("Next charge, estimated", next),
        ],
        evidenceIds: ids,
        confidence: "medium",
        limitations: [ESTIMATE, ...pendingNote(ctx, ids)],
      };
    }),
  );
}

/** A charge at least 3 times (and £10 more than) this person's own usual at that shop, or else in that category. */
export function unusual(ctx: InsightContext): InsightReport {
  const charges = ctx.txns.filter((t) => isSpending(t) && t.amount > 0);
  let judged = 0;
  const largest = new Map<string, { t: Transaction; basis: Transaction[]; where: string; usual: Pence }>();
  for (const t of charges) {
    const others = (same: (o: Transaction) => boolean) => charges.filter((o) => o.id !== t.id && same(o));
    const shop = others((o) => o.merchant === t.merchant);
    const [basis, where] = shop.length >= MIN_HISTORY ? [shop, `at ${t.merchant}`] : [others((o) => o.category === t.category), `in ${t.category}`];
    if (basis.length < MIN_HISTORY) continue;
    judged++;
    const usual = median(basis.map((o) => o.amount));
    if (t.amount < 3 * usual || t.amount - usual < 1000) continue;
    const best = largest.get(t.merchant)?.t;
    if (!best || t.amount > best.amount || (t.amount === best.amount && t.date > best.date)) largest.set(t.merchant, { t, basis, where, usual });
  }
  if (!judged) return skip("There isn't enough history yet to tell what's usual for you.");
  return report(
    [...largest.values()]
      .sort((a, b) => b.t.date.localeCompare(a.t.date) || a.t.id.localeCompare(b.t.id))
      .map(({ t, basis, where, usual }): Insight => ({
        id: `unusual:${t.merchant}`,
        kind: "unusual",
        subject: t.merchant,
        title: `A larger charge at ${t.merchant}`,
        statement: `The ${formatPence(t.amount)} charge at ${t.merchant} on ${formatLongDate(t.date)} is larger than your usual ${where} (about ${formatPence(usual)}).`,
        figures: [money("This charge", t.amount), day("Date of the charge", t.date), money(`Your usual ${where}, the middle of ${basis.length} other charges`, usual)],
        evidenceIds: [t.id, ...basis.map((o) => o.id)],
        confidence: "medium",
        limitations: [`Compared only with your own ${basis.length} other charges ${where}.`, ...(t.status === "pending" ? ["This charge is still pending."] : [])],
      })),
  );
}

/** The latest full week against the week before, and the range over every full week. */
export function weeklyTrend(ctx: InsightContext): InsightReport {
  const weeks = weekBuckets(ctx);
  if (weeks.length < 2) return skip("There isn't enough history yet for a week-by-week view.");
  const [prev, last] = weeks.slice(-2);
  const diff = last.total - prev.total;
  const totals = weeks.map((w) => w.total);
  const [low, high] = [Math.min(...totals), Math.max(...totals)];
  const ids = weeks.flatMap((w) => w.ids);
  return report([
    {
      id: "weekly_trend",
      kind: "weekly_trend",
      title: `Weekly spending is ${diff > 0 ? "up" : diff < 0 ? "down" : "the same"}`,
      statement: `You spent ${formatPence(last.total)} from ${last.period.label}, ${diff === 0 ? "the same as" : `${formatPence(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than`} the week before (${formatPence(prev.total)}); over the last ${weeks.length} weeks, your weekly spending ranged from ${formatPence(low)} to ${formatPence(high)}.`,
      figures: [
        money(`Spent from ${last.period.label}`, last.total),
        ...(diff === 0 ? [] : [money(diff > 0 ? "More than the week before" : "Less than the week before", Math.abs(diff))]),
        money(`Spent from ${prev.period.label}`, prev.total),
        count("Full weeks", weeks.length, `${weeks.length} weeks`),
        money("Lowest week", low),
        money("Highest week", high),
      ],
      evidenceIds: ids,
      confidence: "high",
      periods: { current: last.period, previous: prev.period },
      limitations: ["Weeks run Monday to Sunday, and only full weeks are counted.", ...pendingNote(ctx, ids)],
    },
  ]);
}

// ---- Budget and the bill ----

/** Spending this month so far against the monthly budget set in Spend Pause. */
export function budgetProgress(ctx: InsightContext): InsightReport {
  const b = budgetStatus(ctx.txns, ctx.settings, ctx.today);
  if (!b) return skip("You haven't set a monthly budget.");
  const c = comparison(ctx);
  const cur = c.p.current.label;
  const over = b.remaining < 0;
  const percent = b.budget > 0 ? Math.round((b.spent * 100) / b.budget) : null;
  return report([
    {
      id: "budget_progress",
      kind: "budget_progress",
      title: over ? "Over your monthly budget" : "Your monthly budget",
      statement: over
        ? `You've spent ${formatPence(b.spent)} from ${cur}, ${formatPence(-b.remaining)} over your ${formatPence(b.budget)} monthly budget.`
        : `You've spent ${formatPence(b.spent)} of your ${formatPence(b.budget)} monthly budget from ${cur}${percent === null ? "" : ` (${percent}%)`}, leaving ${formatPence(b.remaining)}.`,
      figures: [
        money(`Spent from ${cur}`, b.spent),
        ...(over
          ? [money("Over the budget", -b.remaining), money("Monthly budget", b.budget)]
          : [
              money("Monthly budget", b.budget),
              ...(percent === null ? [] : [{ label: "Share of the budget spent", display: `${percent}%`, value: percent, unit: "percent" as const }]),
              money("Left in the budget", b.remaining),
            ]),
      ],
      evidenceIds: c.now.ids,
      confidence: "high",
      periods: { current: c.p.current },
      limitations: [
        ...c.soFar,
        ...pendingNote(ctx, c.now.ids),
        ...(ctx.settings.enabled ? [] : ["Spend Pause is off, so purchases aren't checked against this budget."]),
      ],
    },
  ]);
}

/** Balances as they stand after the payments made (the account already includes them). Payments are never spending. */
export function positionAfterPayments(ctx: InsightContext): InsightReport {
  const a = ctx.account;
  const credit = availableCredit(a);
  const paid = a.lastPayment.amount > 0;
  const payment = ctx.txns.filter((t) => t.category === "Payments" && t.date === a.lastPayment.date && t.amount === -a.lastPayment.amount).at(-1);
  const evidenceIds = payment ? [payment.id] : [];
  return report([
    {
      id: "position_after_payments",
      kind: "position_after_payments",
      title: "Your balance after payments",
      statement: `Your balance is ${formatPence(a.currentBalance)}, ${credit >= 0 ? `with ${formatPence(credit)} of credit available` : `which is ${formatPence(-credit)} over your credit limit`}; ${a.statementBalance > 0 ? `${formatPence(a.statementBalance)} of your statement balance is left to pay` : "your statement balance is paid in full"}${paid ? `, and your last payment was ${formatPence(a.lastPayment.amount)} on ${formatLongDate(a.lastPayment.date)}` : ""}.`,
      figures: [
        money("Current balance", a.currentBalance),
        money(credit >= 0 ? "Available credit" : "Over the credit limit", Math.abs(credit)),
        ...(a.statementBalance > 0 ? [money("Statement balance left to pay", a.statementBalance)] : []),
        ...(paid ? [money("Last payment", a.lastPayment.amount), day("Last payment date", a.lastPayment.date)] : []),
      ],
      evidenceIds,
      confidence: "high",
      limitations: pendingNote(ctx, evidenceIds),
    },
  ]);
}

/** The bill and its minimum, then regular charges expected before it is due (estimates). */
export function upcomingObligations(ctx: InsightContext): InsightReport {
  const a = ctx.account;
  const days = daysUntilDue(a, ctx.today);
  const due = formatLongDate(a.paymentDueDate);
  const inDays = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  const owed = a.statementBalance > 0;
  const bill: Insight = {
    id: "upcoming_obligation",
    kind: "upcoming_obligation",
    title: "Your next bill",
    statement: owed
      ? `Your statement balance of ${formatPence(a.statementBalance)} ${days < 0 ? `was due on ${due}` : `is due on ${due}, ${inDays}`}, and the minimum payment is ${formatPence(a.minimumPayment)}.`
      : `Your statement balance is paid, so nothing more is due on ${due}.`,
    figures: [
      ...(owed ? [money("Statement balance", a.statementBalance)] : []),
      day("Payment due date", a.paymentDueDate),
      ...(owed && days >= 0 ? [count("Days until due", days, inDays)] : []),
      ...(owed ? [money("Minimum payment", a.minimumPayment)] : []),
    ],
    evidenceIds: [],
    confidence: "high",
    limitations: [],
  };
  const expected = regularCharges(ctx).filter((r) => r.next >= ctx.today && r.next <= a.paymentDueDate);
  return report([
    bill,
    ...expected.map(({ merchant, charges, next }): Insight => {
      const last = charges[charges.length - 1];
      return {
        id: `upcoming_obligation:${merchant}`,
        kind: "upcoming_obligation",
        subject: merchant,
        title: `${merchant} expected before your bill`,
        statement: `From past charges, ${merchant} may charge about ${formatPence(last.amount)} around ${formatLongDate(next)}, before your bill is due on ${due}.`,
        figures: [money("Expected charge", last.amount), day("Expected around", next), day("Payment due date", a.paymentDueDate)],
        evidenceIds: charges.map((t) => t.id),
        confidence: "medium",
        limitations: [ESTIMATE],
      };
    }),
  ]);
}

/** Facts that may help someone spend less: what regular charges add up to, and discretionary categories that rose. */
export function savingObservations(ctx: InsightContext): InsightReport {
  const out: Insight[] = [];
  const monthly = regularCharges(ctx).filter((r) => r.unit === "month");
  if (monthly.length) {
    const total = sum(monthly.map((r) => r.charges[r.charges.length - 1].amount));
    const names = list(monthly.map((r) => r.merchant));
    const ids = monthly.flatMap((r) => r.charges.map((t) => t.id));
    out.push({
      id: "saving_observation:Regular charges",
      kind: "saving_observation",
      subject: "Regular charges",
      title: "Your regular charges",
      statement:
        monthly.length === 1
          ? `Your regular monthly charge from ${names} is ${formatPence(total)} a month.`
          : `Your ${monthly.length} regular monthly charges, from ${names}, come to ${formatPence(total)} a month.`,
      figures: [
        ...(monthly.length === 1 ? [] : [count("Regular monthly charges", monthly.length, `${monthly.length} regular monthly charges`)]),
        money("Regular charges a month", total),
      ],
      evidenceIds: ids,
      confidence: "medium",
      limitations: [ESTIMATE, ...pendingNote(ctx, ids)],
    });
  }
  const c = comparison(ctx);
  for (const category of DISCRETIONARY) {
    const [now, before] = [c.now, c.before].map((s) => s.byCategory.find((x) => x.category === category));
    if (!c.covered || !now || !before || now.total <= before.total) continue;
    const ids = [...now.ids, ...before.ids];
    out.push({
      id: `saving_observation:${category}`,
      kind: "saving_observation",
      subject: category,
      title: `${category} is up`,
      statement: `${category} comes to ${formatPence(now.total)} from ${c.p.current.label}, ${formatPence(now.total - before.total)} more than the same days in ${formatMonth(c.p.previous.from)}.`,
      figures: [money(`${category} from ${c.p.current.label}`, now.total), money("More than the same days last month", now.total - before.total)],
      evidenceIds: ids,
      confidence: c.partial ? "medium" : "high",
      periods: { current: c.p.current, previous: c.p.previous },
      limitations: [...c.soFar, ...c.shorter, ...pendingNote(ctx, ids)],
    });
  }
  return report(out);
}

// ---- Everything ----

/** Every insight the data supports, in INSIGHT_KINDS order, and why anything else was left out. */
export function buildInsights(ctx: InsightContext): InsightReport {
  const c = comparison(ctx);
  const total = (s: typeof c.now, cat: Category) => s.byCategory.find((x) => x.category === cat)?.total ?? 0;
  const moved = (cat: Category) => Math.abs(total(c.now, cat) - total(c.before, cat));
  const categories = [...new Set([...c.now.byCategory, ...c.before.byCategory].map((x) => x.category))].sort(
    (a, b) => moved(b) - moved(a) || a.localeCompare(b),
  );
  const parts = [
    spendingChange(ctx),
    ...categories.map((cat) => categoryChange(ctx, cat)),
    topCategories(ctx),
    recurring(ctx),
    unusual(ctx),
    weeklyTrend(ctx),
    budgetProgress(ctx),
    positionAfterPayments(ctx),
    upcomingObligations(ctx),
    savingObservations(ctx),
  ];
  return { insights: parts.flatMap((p) => p.insights), cannotEstablish: [...new Set(parts.flatMap((p) => p.cannotEstablish))] };
}

const BY_KIND: Record<InsightKind, (ctx: InsightContext, subject: string) => InsightReport> = {
  spending_change: spendingChange,
  category_change: (ctx, subject) => categoryChange(ctx, subject as Category),
  top_categories: topCategories,
  recurring,
  unusual,
  weekly_trend: weeklyTrend,
  budget_progress: budgetProgress,
  position_after_payments: positionAfterPayments,
  upcoming_obligation: upcomingObligations,
  saving_observation: savingObservations,
};

/** The same insight the server explained, re-derived from the same data. null for an id the data doesn't support. */
export function insightById(ctx: InsightContext, id: string): Insight | null {
  const [kind, subject = ""] = id.split(/:(.*)/);
  // Only builds the one kind asked for, so a card re-derives its insight without building the whole report.
  if (!INSIGHT_ID.test(id) || !(INSIGHT_KINDS as readonly string[]).includes(kind)) return null;
  return BY_KIND[kind as InsightKind](ctx, subject).insights.find((i) => i.id === id) ?? null;
}
