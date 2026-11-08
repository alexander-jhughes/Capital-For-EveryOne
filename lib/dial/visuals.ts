// Visual responses, built only from verified data. Every total comes from lib/finance (spendingSummary,
// biggestItems, budgetStatus); this file only picks the period, groups the same transactions and words it.
// Payments are never spending, refunds reduce spending, pending items are counted and labelled, and partial
// months are always labelled. Nothing here says why someone spent or what they should do.
//
// Series convention (read by components/dial/visual-card.tsx): a series named TOTALS holds headline figures. It
// is shown as figures above the chart, never drawn as marks. Every other series is drawn.
import { biggestItems, budgetStatus, spendingSummary } from "../finance";
import { formatLongDate, formatPence } from "../format";
import { periodLabel, type InsightContext } from "../insights";
import type { Category, ISODate, Pence, Transaction } from "../types";
import { historyStart, monthKey, monthName, monthRange, monthsBetween, monthsWithData, previousMonth, isMonthKey, type MonthRange } from "./months";
import { spendingHref } from "./spending-filters";
import type { MonthKey, SpendingFilters, Visual, VisualDatum, VisualRequest, VisualSeries } from "./types";

export const TOTALS = "Totals";

type SpendCategory = Exclude<Category, "Payments">;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pad = (n: number) => String(n).padStart(2, "0");
const lower = (c: SpendCategory) => c.toLowerCase();

const money = (label: string, value: Pence, extra: Partial<VisualDatum> = {}): VisualDatum => ({ label, value, display: formatPence(value), ...extra });

function pendingIn(ctx: InsightContext, ids: string[]) {
  const pending = new Set(ctx.txns.filter((t) => t.status === "pending").map((t) => t.id));
  return ids.filter((id) => pending.has(id)).length;
}
const pendingNote = (n: number) => (n ? `includes ${plural(n, "pending item")}` : undefined);
const pendingLimitation = (ctx: InsightContext, ids: string[]) => {
  const n = pendingIn(ctx, ids);
  return n ? [`Includes ${plural(n, "pending item")}, which may still change.`] : [];
};

/** Net spending in a period, optionally one category, grouped by category (or by shop within one category). */
function grouped(ctx: InsightContext, from: ISODate, to: ISODate, category?: SpendCategory) {
  const txns = category ? ctx.txns.filter((t) => t.category === category) : ctx.txns;
  const s = spendingSummary(txns, from, to);
  const byId = new Map(ctx.txns.map((t) => [t.id, t]));
  const groups = new Map<string, { total: Pence; ids: string[] }>();
  for (const id of s.ids) {
    const t = byId.get(id) as Transaction;
    const name = category ? t.merchant : t.category;
    const g = groups.get(name) ?? { total: 0, ids: [] };
    g.total += t.amount;
    g.ids.push(id);
    groups.set(name, g);
  }
  return {
    summary: s,
    groups: [...groups].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

/** The reading-order text equivalent: title, headline figures, each drawn series, then what it can't show. */
function describe(v: Omit<Visual, "textAlternative">): string {
  const ordered = [...v.series.filter((s) => s.name === TOTALS), ...v.series.filter((s) => s.name !== TOTALS)];
  const parts = [v.title];
  if (!v.series.some((s) => s.data.length)) parts.push(v.summary);
  for (const s of ordered) {
    if (!s.data.length) continue;
    const rows = s.data.map((d) => `${d.label} ${d.display}${d.note ? ` (${d.note})` : ""}`).join(", ");
    parts.push(s.name === TOTALS ? rows : `${s.name}: ${rows}`);
  }
  parts.push(...v.limitations);
  return parts.map((p) => p.replace(/[.\s]+$/, "")).join(". ") + ".";
}

function finish(v: Omit<Visual, "textAlternative" | "evidenceIds">): Visual {
  const ids = [...new Set(v.series.flatMap((s) => s.data.flatMap((d) => d.evidenceIds ?? [])))];
  const base = { ...v, evidenceIds: ids, limitations: [...new Set(v.limitations)] };
  return { ...base, textAlternative: describe(base) };
}

function empty(kind: Visual["kind"], chart: Visual["chart"], title: string, summary: string, limitations: string[] = [], link?: Visual["link"]): Visual {
  return finish({ kind, chart, title, series: [], summary, limitations, ...(link && { link }) });
}

const spendingLink = (label: string, filters: SpendingFilters): Visual["link"] => ({ label, to: "/account/spending", filters });

/** Only months the contract allows; anything else falls back to the default. */
const requested = (req: VisualRequest) => (req.months ?? []).filter(isMonthKey);

function partialLimitation(r: MonthRange, today: ISODate, dataFrom?: ISODate): string[] {
  if (!r.partial || !r.days) return [];
  if (monthKey(r.to) === monthKey(today) && r.to === today && r.from.endsWith("-01")) return [`${monthName(monthKey(today), today)} so far covers ${plural(r.days, "day")}.`];
  if (dataFrom && r.from === dataFrom) return [`Your history starts on ${formatLongDate(dataFrom)}, so ${monthName(monthKey(r.from), today)} only covers ${plural(r.days, "day")}.`];
  return [`This covers ${plural(r.days, "day")}.`];
}

// ---- category_breakdown ----

function categoryBreakdown(req: VisualRequest, ctx: InsightContext): Visual {
  const dataFrom = historyStart(ctx.txns);
  const key = requested(req)[0] ?? monthKey(ctx.today);
  const r = monthRange(key, ctx.today, dataFrom);
  const cat = req.category;
  const title = cat ? `Where your ${lower(cat)} money went, ${r.label}` : `Where your money went, ${r.label}`;
  const link = spendingLink(`See ${monthName(key, ctx.today)}'s spending`, { month: key, ...(cat && { category: cat }) });
  if (!r.days) return empty("category_breakdown", "bars", title, `There's no spending to show for ${r.label}.`, [], link);
  const { summary: s, groups } = grouped(ctx, r.from, r.to, cat);
  if (!s.ids.length) return empty("category_breakdown", "bars", title, `There's no ${cat ? `${lower(cat)} ` : ""}spending to show for ${r.label}.`, partialLimitation(r, ctx.today, dataFrom), link);

  const rows = groups.map((g) => money(g.name, g.total, { evidenceIds: g.ids, ...(pendingNote(pendingIn(ctx, g.ids)) && { note: pendingNote(pendingIn(ctx, g.ids)) }) }));
  const spentLabel = cat ? `Spent on ${lower(cat)}, ${r.label}` : `Spent, ${r.label}`;
  const totals: VisualSeries = {
    name: TOTALS,
    data: [money(spentLabel, s.total, { evidenceIds: s.ids }), ...(s.refunds > 0 ? [money("Refunds taken off", s.refunds, { evidenceIds: s.refundIds })] : [])],
  };
  const top = groups.find((g) => g.total > 0);
  const on = cat ? ` on ${lower(cat)}` : "";
  const summary =
    s.total <= 0
      ? `In ${r.label}, refunds${on} came to as much as your purchases or more, so your net spending${on} was ${formatPence(s.total)}.`
      : `In ${r.label}, you spent ${formatPence(s.total)}${on}, with the most ${cat ? "at" : "on"} ${top!.name} (${formatPence(top!.total)}).`;
  return finish({
    kind: "category_breakdown",
    chart: "bars",
    title,
    series: [totals, { name: cat ? `By shop, ${r.label}` : `By category, ${r.label}`, data: rows }],
    summary,
    limitations: [...partialLimitation(r, ctx.today, dataFrom), ...(s.refunds > 0 ? ["Refunds are taken off the category they came from."] : []), ...pendingLimitation(ctx, s.ids)],
    link,
  });
}

// ---- month_comparison ----

/** Same days of both months when either is partial; whole months when both are complete. null if they don't overlap. */
function likeForLike(a: MonthKey, b: MonthKey, today: ISODate, dataFrom?: ISODate) {
  const [ra, rb] = [monthRange(a, today, dataFrom), monthRange(b, today, dataFrom)];
  if (!ra.days || !rb.days) return null;
  if (!ra.partial && !rb.partial) {
    const differ = ra.days !== rb.days ? [`${ra.label} has ${ra.days} days and ${rb.label} has ${rb.days}.`] : [];
    return { a: ra, b: rb, names: [ra.label, rb.label], sameDays: false, limitations: differ };
  }
  const day = (d: ISODate) => Number(d.slice(8));
  const start = Math.max(day(ra.from), day(rb.from));
  const end = Math.min(day(ra.to), day(rb.to));
  if (start > end) return null;
  const win = (k: MonthKey) => ({ from: `${k}-${pad(start)}`, to: `${k}-${pad(end)}` });
  const [wa, wb] = [win(a), win(b)];
  const reasons: string[] = [];
  if (ra.to === today || rb.to === today) reasons.push(`${monthName(monthKey(today), today)} so far covers ${plural(day(today), "day")}`);
  if (dataFrom && (ra.from === dataFrom || rb.from === dataFrom)) reasons.push(`your history starts on ${formatLongDate(dataFrom)}`);
  const days = end - start + 1;
  return {
    a: { ...ra, ...wa, days },
    b: { ...rb, ...wb, days },
    names: [periodLabel(wa.from, wa.to), periodLabel(wb.from, wb.to)],
    sameDays: true,
    limitations: [`Both months are compared over the same ${plural(days, "day")} (${start === end ? `day ${start}` : `days ${start} to ${end}`}), because ${reasons.join(" and ") || "one month is only partly covered"}.`],
  };
}

function monthComparison(req: VisualRequest, ctx: InsightContext): Visual {
  const dataFrom = historyStart(ctx.txns);
  const [askA, askB] = requested(req);
  const a = askA ?? monthKey(ctx.today);
  const b = askB && askB !== a ? askB : previousMonth(a);
  const cat = req.category;
  const on = cat ? ` on ${lower(cat)}` : "";
  const title = `${cat ? `${cat}: ` : ""}${monthName(a, ctx.today)} and ${monthName(b, ctx.today)} compared`;
  const link = spendingLink(`See ${monthName(a, ctx.today)}'s spending`, { month: a, ...(cat && { category: cat }) });
  const w = likeForLike(a, b, ctx.today, dataFrom);
  if (!w) {
    const [ra, rb] = [monthRange(a, ctx.today, dataFrom), monthRange(b, ctx.today, dataFrom)];
    const why = !ra.days ? ra.label : !rb.days ? `there's no history from ${rb.label.replace(/ \(.*\)$/, "")}` : "the two months don't cover the same days";
    return empty("month_comparison", "columns", title, `There's nothing to compare: ${why}.`, [], link);
  }
  const [ga, gb] = [grouped(ctx, w.a.from, w.a.to, cat), grouped(ctx, w.b.from, w.b.to, cat)];
  const [na, nb] = w.names;
  if (!ga.summary.ids.length && !gb.summary.ids.length) return empty("month_comparison", "columns", title, `There's no spending${on} from ${na} or ${nb} to compare.`, w.limitations, link);

  const names = [...new Set([...ga.groups, ...gb.groups].map((g) => g.name))];
  const of = (g: typeof ga, name: string) => g.groups.find((x) => x.name === name) ?? { total: 0, ids: [] as string[] };
  names.sort((x, y) => of(ga, y).total - of(ga, x).total || of(gb, y).total - of(gb, x).total || x.localeCompare(y));
  const row = (g: typeof ga, name: string) => {
    const x = of(g, name);
    const note = x.ids.length ? pendingNote(pendingIn(ctx, x.ids)) : "nothing spent";
    return money(name, x.total, { evidenceIds: x.ids, ...(note && { note }) });
  };
  const [ta, tb] = [ga.summary.total, gb.summary.total];
  const diff = ta - tb;
  const totals: VisualSeries = {
    name: TOTALS,
    data: [
      money(`Spent${on}, ${na}`, ta, { evidenceIds: ga.summary.ids }),
      money(`Spent${on}, ${nb}`, tb, { evidenceIds: gb.summary.ids }),
      ...(diff === 0 ? [] : [money(diff > 0 ? `More than ${nb}` : `Less than ${nb}`, Math.abs(diff))]),
    ],
  };
  const summary = `You spent ${formatPence(ta)}${on} from ${na}, ${diff === 0 ? "the same as" : `${formatPence(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than`} the ${formatPence(tb)} from ${nb}.`;
  return finish({
    kind: "month_comparison",
    chart: "columns",
    title,
    series: [totals, { name: na, data: names.map((n) => row(ga, n)) }, { name: nb, data: names.map((n) => row(gb, n)) }],
    summary,
    limitations: [...w.limitations, ...pendingLimitation(ctx, [...ga.summary.ids, ...gb.summary.ids])],
    link,
  });
}

// ---- biggest_purchases ----

function biggestPurchases(req: VisualRequest, ctx: InsightContext): Visual {
  const dataFrom = historyStart(ctx.txns);
  const key = requested(req)[0] ?? monthKey(ctx.today);
  const r = monthRange(key, ctx.today, dataFrom);
  const limit = Math.min(10, Math.max(1, Math.floor(req.limit ?? 5)));
  const cat = req.category;
  const title = `Your biggest ${cat ? `${lower(cat)} ` : ""}purchases, ${r.label}`;
  const inRange = ctx.txns.filter((t) => t.date >= r.from && t.date <= r.to && (!cat || t.category === cat));
  const items = r.days ? biggestItems(inRange, limit) : [];
  const link = spendingLink("See them in Spending", { month: key, sort: "highest", ...(cat && { category: cat }), ...(items.length && { highlight: items.map((t) => t.id) }) });
  if (!items.length) return empty("biggest_purchases", "list", title, `There are no ${cat ? `${lower(cat)} ` : ""}purchases to show for ${r.label}.`, partialLimitation(r, ctx.today, dataFrom), link);

  // A purchase with a matching refund (same shop, same amount, on or after it) is labelled, never hidden.
  const refunds = ctx.txns.filter((t) => t.category !== "Payments" && t.amount < 0);
  const used = new Set<string>();
  const refundOf = (t: Transaction) => {
    const r = refunds.find((x) => !used.has(x.id) && x.merchant === t.merchant && x.amount === -t.amount && x.date >= t.date);
    if (r) used.add(r.id);
    return r;
  };
  const rows = items.map((t) => {
    const refund = refundOf(t);
    const note = [t.category, formatLongDate(t.date), ...(t.status === "pending" ? ["pending"] : []), ...(refund ? [refund.status === "pending" ? "refund pending" : "refunded"] : [])].join(", ");
    return money(t.merchant, t.amount, { note, evidenceIds: [t.id, ...(refund ? [refund.id] : [])] });
  });
  const hasRefunds = inRange.some((t) => t.category !== "Payments" && t.amount < 0);
  return finish({
    kind: "biggest_purchases",
    chart: "list",
    title,
    series: [{ name: `Largest first, ${r.label}`, data: rows }],
    summary: `Your biggest ${cat ? `${lower(cat)} ` : ""}purchase in ${r.label} was ${formatPence(items[0].amount)} at ${items[0].merchant}.`,
    limitations: [
      ...partialLimitation(r, ctx.today, dataFrom),
      ...(items.length < limit ? [`There ${items.length === 1 ? "is only 1 purchase" : `are only ${items.length} purchases`} in this period.`] : []),
      ...(hasRefunds ? ["Refunds aren't listed here, but they are taken off your spending totals."] : []),
      ...pendingLimitation(ctx, items.map((t) => t.id)),
    ],
    link,
  });
}

// ---- budget_progress ----

function budgetVisual(req: VisualRequest, ctx: InsightContext): Visual {
  const key = monthKey(ctx.today);
  const r = monthRange(key, ctx.today);
  const link = { label: "Open Spend Pause", to: "/account/spend-pause" as const };
  const other = requested(req).some((k) => k !== key) ? ["Budget progress is only shown for this month."] : [];
  const b = budgetStatus(ctx.txns, ctx.settings, ctx.today);
  if (!b) {
    return empty(
      "budget_progress",
      "progress",
      "Your monthly budget",
      "You haven't set a monthly budget, so there's nothing to measure against yet.",
      [...other, "You can set a monthly budget in Spend Pause."],
      { label: "Set a budget in Spend Pause", to: "/account/spend-pause" },
    );
  }
  const s = spendingSummary(ctx.txns, r.from, r.to);
  const over = b.remaining < 0;
  const percent = b.budget > 0 ? Math.round((b.spent * 100) / b.budget) : null;
  const data: VisualDatum[] = [
    money(`Spent, ${r.label}`, b.spent, { evidenceIds: s.ids }),
    money("Monthly budget", b.budget),
    money(over ? "Over the budget" : "Left in the budget", Math.abs(b.remaining)),
    ...(percent === null ? [] : [{ label: "Share of the budget spent", value: percent, display: `${percent}%` }]),
  ];
  const summary = over
    ? `In ${r.label}, you've spent ${formatPence(b.spent)}, ${formatPence(-b.remaining)} over your ${formatPence(b.budget)} monthly budget.`
    : `In ${r.label}, you've spent ${formatPence(b.spent)} of your ${formatPence(b.budget)} monthly budget${percent === null ? "" : ` (${percent}%)`}, leaving ${formatPence(b.remaining)}.`;
  return finish({
    kind: "budget_progress",
    chart: "progress",
    title: over ? "Over your monthly budget" : "Your monthly budget",
    series: [{ name: `Budget, ${r.label}`, data }],
    summary,
    limitations: [
      ...other,
      ...partialLimitation(r, ctx.today),
      ...pendingLimitation(ctx, s.ids),
      ...(ctx.settings.enabled ? [] : ["Spend Pause is off, so purchases aren't checked against this budget."]),
    ],
    link,
  });
}

// ---- monthly_trend and category_trend ----

function trend(req: VisualRequest, ctx: InsightContext, kind: "monthly_trend" | "category_trend"): Visual {
  const cat = kind === "category_trend" ? req.category : undefined;
  if (kind === "category_trend" && !cat) {
    return empty(kind, "columns", "Spending in one category by month", "Name a category, like groceries, to see how it changed month by month.", [], spendingLink("See all spending", {}));
  }
  const dataFrom = historyStart(ctx.txns);
  const known = monthsWithData(ctx.txns).filter((k) => k <= monthKey(ctx.today));
  const asked = [...new Set(requested(req))].filter((k) => k <= monthKey(ctx.today)).sort();
  // From the first month of the history up to this month: a month with nothing spent is a real zero.
  const months = asked.length > 1 ? asked : known.length ? monthsBetween(known[0], monthKey(ctx.today)) : [];
  const title = cat ? `${cat} by month` : "Your spending by month";
  const link = spendingLink(cat ? `See ${lower(cat)} in Spending` : "See all spending", cat ? { category: cat } : {});
  const ranges = months.map((k) => ({ k, r: monthRange(k, ctx.today, dataFrom) })).filter((x) => x.r.days > 0);
  const rows = ranges.map(({ k, r }) => {
    const s = spendingSummary(cat ? ctx.txns.filter((t) => t.category === cat) : ctx.txns, r.from, r.to);
    const note = r.partial ? (k === monthKey(ctx.today) ? `${plural(r.days, "day")} so far` : `${plural(r.days, "day")}, ${periodLabel(r.from, r.to)}`) : undefined;
    const pend = pendingNote(pendingIn(ctx, s.ids));
    return { r, s, datum: money(monthName(k, ctx.today), s.total, { evidenceIds: s.ids, ...((note || pend) && { note: [note, pend].filter(Boolean).join(", ") }) }) };
  });
  if (!rows.some((x) => x.s.ids.length)) return empty(kind, "columns", title, `There's no ${cat ? `${lower(cat)} ` : ""}spending in your history to show.`, [], link);

  const partial = rows.filter((x) => x.r.partial).map((x) => monthName(monthKey(x.r.from), ctx.today));
  const on = cat ? ` on ${lower(cat)}` : "";
  return finish({
    kind,
    chart: "columns",
    title,
    series: [{ name: cat ? `${cat} each month` : "Spending each month", data: rows.map((x) => x.datum) }],
    summary: `Your spending${on} by month: ${rows.map((x) => `${x.r.label} ${formatPence(x.s.total)}`).join(", ")}.`,
    limitations: [
      ...(partial.length
        ? [`${partial.length === 1 ? partial[0] : `${partial.slice(0, -1).join(", ")} and ${partial.at(-1)}`} ${partial.length === 1 ? "is a partial month" : "are partial months"}, so ${partial.length === 1 ? "its total covers" : "their totals cover"} fewer days than a full month.`]
        : []),
      ...pendingLimitation(ctx, rows.flatMap((x) => x.s.ids)),
    ],
    link,
  });
}

/** One visual, built from the same transactions every other screen reads. Never throws for a valid request. */
export function buildVisual(req: VisualRequest, ctx: InsightContext): Visual {
  switch (req.kind) {
    case "category_breakdown":
      return categoryBreakdown(req, ctx);
    case "month_comparison":
      return monthComparison(req, ctx);
    case "biggest_purchases":
      return biggestPurchases(req, ctx);
    case "budget_progress":
      return budgetVisual(req, ctx);
    case "monthly_trend":
    case "category_trend":
      return trend(req, ctx, req.kind);
  }
}

/** Where a visual's link goes, as an href. */
export function visualHref(link: NonNullable<Visual["link"]>): string {
  return link.to === "/account/spending" ? spendingHref(link.filters) : link.to;
}
