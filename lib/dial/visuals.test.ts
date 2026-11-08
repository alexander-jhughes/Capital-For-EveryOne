import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE } from "../demo-config";
import { biggestItems, budgetStatus, monthOverMonth, spendingSummary } from "../finance";
import type { InsightContext } from "../insights";
import type { Category, Transaction } from "../types";
import { spendingHref } from "./spending-filters";
import { DIAL_ROUTES, VISUAL_KINDS, type Visual, type VisualRequest } from "./types";
import { TOTALS, buildVisual, visualHref } from "./visuals";

const seed: InsightContext = { account: SEED_ACCOUNT, txns: SEED_TRANSACTIONS, settings: INITIAL_SPEND_PAUSE, today: DEMO_TODAY };
const MONEY = /-?£[\d,]+\.\d{2}/g;
const PERCENT = /\d+%/g;

let n = 0;
const tx = (date: string, merchant: string, amount: number, category: Category = "Shopping", status: Transaction["status"] = "posted"): Transaction => ({
  id: `v${++n}`,
  date,
  merchant,
  amount,
  category,
  status,
});
const ctxOf = (txns: Transaction[], over: Partial<InsightContext> = {}): InsightContext => ({ ...seed, txns, ...over });
const drawn = (v: Visual) => v.series.filter((s) => s.name !== TOTALS);
const totals = (v: Visual) => v.series.find((s) => s.name === TOTALS)?.data ?? [];
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** The rules every visual follows, whatever the data. */
function checkVisual(v: Visual, ctx: InsightContext) {
  const displays = v.series.flatMap((s) => s.data.map((d) => d.display));
  for (const fig of [...(v.summary.match(MONEY) ?? []), ...(v.summary.match(PERCENT) ?? [])]) expect(displays, `${v.kind}: "${fig}" from the summary`).toContain(fig);
  for (const d of displays) expect(v.textAlternative, `${v.kind}: ${d} read out`).toContain(d);
  for (const s of v.series) for (const d of s.data) {
    expect(Number.isInteger(d.value), `${d.label} is whole`).toBe(true);
    if (d.note) expect(v.textAlternative).toContain(d.note);
  }
  for (const l of v.limitations) expect(v.textAlternative).toContain(l.replace(/\.$/, ""));
  const byId = new Map(ctx.txns.map((t) => [t.id, t]));
  for (const id of v.evidenceIds) {
    expect(byId.has(id), `${v.kind}: evidence ${id} exists`).toBe(true);
    expect(byId.get(id)!.category, "payments are never evidence of spending").not.toBe("Payments");
  }
  expect(v.summary.length).toBeGreaterThan(0);
  expect(v.textAlternative.startsWith(v.title)).toBe(true);
  expect(v.link && (DIAL_ROUTES as readonly string[]).includes(v.link.to)).toBe(true);
  for (const text of [v.title, v.summary, v.textAlternative, ...v.limitations]) expect(text).not.toMatch(/[\u2013\u2014]/);
}

describe("every visual, on the seed and on no data", () => {
  const requests: VisualRequest[] = VISUAL_KINDS.flatMap((kind) => [
    { kind },
    { kind, category: "Groceries" as const },
    { kind, months: ["2026-10"] },
    { kind, months: ["2026-10", "2026-09"] },
  ]);
  it.each(requests.map((r) => [JSON.stringify(r), r] as const))("%s", (_, req) => {
    checkVisual(buildVisual(req, seed), seed);
    const none = ctxOf([]);
    const v = buildVisual(req, none);
    checkVisual(v, none);
    if (req.kind === "budget_progress") {
      // A budget is a real setting, so £0 spent against it is a real figure.
      expect(v.summary).toBe("In November so far (8 days), you've spent £0.00 of your £500.00 monthly budget (0%), leaving £500.00.");
      return;
    }
    // Nothing to show is said plainly, never drawn as zeros.
    expect(v.series.flatMap((s) => s.data)).toEqual([]);
    expect(v.summary).toMatch(/no |nothing|Name a category/);
  });

  it("only allows real months; junk falls back to the default", () => {
    const v = buildVisual({ kind: "category_breakdown", months: ["2026-13", "Oct"] }, seed);
    expect(v.title).toContain("November so far (8 days)");
  });
});

describe("category_breakdown", () => {
  it("matches lib/finance for November so far, labelled as partial", () => {
    const v = buildVisual({ kind: "category_breakdown" }, seed);
    const s = spendingSummary(SEED_TRANSACTIONS, "2026-11-01", "2026-11-08");
    expect(totals(v)[0]).toMatchObject({ value: s.total, display: "£402.35" });
    expect(sum(drawn(v)[0].data.map((d) => d.value))).toBe(s.total);
    expect(drawn(v)[0].data.map((d) => [d.label, d.value])).toEqual(s.byCategory.map((c) => [c.category, c.total]));
    expect(v.title).toBe("Where your money went, November so far (8 days)");
    expect(v.summary).toBe("In November so far (8 days), you spent £402.35, with the most on Groceries (£183.53).");
    expect(v.limitations).toContain("November so far covers 8 days.");
    expect(v.limitations).toContain("Includes 3 pending items, which may still change.");
    expect(v.evidenceIds.sort()).toEqual([...s.ids].sort());
    expect(v.link).toEqual({ label: "See November's spending", to: "/account/spending", filters: { month: "2026-11" } });
    expect(visualHref(v.link!)).toBe(spendingHref({ month: "2026-11" }));
  });

  it("leaves card payments out and takes refunds off (October)", () => {
    const v = buildVisual({ kind: "category_breakdown", months: ["2026-10"] }, seed);
    const s = spendingSummary(SEED_TRANSACTIONS, "2026-10-01", "2026-10-31");
    expect(totals(v)[0].value).toBe(s.total);
    expect(v.evidenceIds).not.toContain("t022"); // the £180 payment
    expect(v.evidenceIds).toContain("t036"); // the Amazon refund
    expect(totals(v)[1]).toMatchObject({ label: "Refunds taken off", value: 1499 });
    const shopping = drawn(v)[0].data.find((d) => d.label === "Shopping")!;
    expect(shopping.value).toBe(1899 + 3450 + 1499 - 1499 + 24900);
    expect(v.title).toBe("Where your money went, October");
  });

  it("splits one category by shop", () => {
    const v = buildVisual({ kind: "category_breakdown", category: "Groceries", months: ["2026-10"] }, seed);
    const total = spendingSummary(SEED_TRANSACTIONS.filter((t) => t.category === "Groceries"), "2026-10-01", "2026-10-31").total;
    expect(totals(v)[0].value).toBe(total);
    expect(drawn(v)[0].data.map((d) => d.label).sort()).toEqual(["Sainsbury's", "Tesco"]);
    expect(sum(drawn(v)[0].data.map((d) => d.value))).toBe(total);
  });

  it("labels a month the history only partly covers", () => {
    const v = buildVisual({ kind: "category_breakdown", months: ["2026-09"] }, seed);
    expect(v.title).toContain("September (3 days, 28 to 30 September)");
    expect(v.limitations[0]).toBe("Your history starts on Monday 28 September, so September only covers 3 days.");
  });

  it("says so when refunds outweigh purchases", () => {
    const ctx = ctxOf([tx("2026-11-02", "Shop", 1000), tx("2026-11-03", "Shop", -2500)]);
    const v = buildVisual({ kind: "category_breakdown" }, ctx);
    checkVisual(v, ctx);
    expect(v.summary).toContain("-£15.00");
  });
});

describe("month_comparison", () => {
  it("compares the same days when this month is partial, matching monthOverMonth", () => {
    const v = buildVisual({ kind: "month_comparison" }, seed);
    const m = monthOverMonth(SEED_TRANSACTIONS, DEMO_TODAY);
    expect(totals(v).map((d) => d.value)).toEqual([m.thisMonth.total, m.lastMonthSamePeriod.total, m.thisMonth.total - m.lastMonthSamePeriod.total]);
    expect(drawn(v).map((s) => s.name)).toEqual(["1 to 8 November", "1 to 8 October"]);
    expect(v.summary).toBe("You spent £402.35 from 1 to 8 November, £256.72 more than the £145.63 from 1 to 8 October.");
    expect(v.limitations[0]).toBe("Both months are compared over the same 8 days (days 1 to 8), because November so far covers 8 days.");
    // Same categories, in the same order, in both series.
    expect(drawn(v)[0].data.map((d) => d.label)).toEqual(drawn(v)[1].data.map((d) => d.label));
    for (const s of drawn(v)) expect(sum(s.data.map((d) => d.value))).toBe(s === drawn(v)[0] ? m.thisMonth.total : m.lastMonthSamePeriod.total);
  });

  it("only compares the days the history covers in both months", () => {
    const v = buildVisual({ kind: "month_comparison", months: ["2026-10", "2026-09"] }, seed);
    expect(drawn(v).map((s) => s.name)).toEqual(["28 to 30 October", "28 to 30 September"]);
    expect(totals(v)[0].value).toBe(spendingSummary(SEED_TRANSACTIONS, "2026-10-28", "2026-10-30").total);
    expect(totals(v)[1].value).toBe(spendingSummary(SEED_TRANSACTIONS, "2026-09-28", "2026-09-30").total);
    expect(v.limitations[0]).toContain("your history starts on Monday 28 September");
  });

  it("compares whole months when both are complete, and says when they differ in length", () => {
    const ctx = ctxOf([tx("2026-08-03", "A", 1000), tx("2026-09-04", "B", 3000), tx("2026-10-05", "A", 2000, "Groceries")]);
    const v = buildVisual({ kind: "month_comparison", months: ["2026-10", "2026-09"] }, ctx);
    checkVisual(v, ctx);
    expect(drawn(v).map((s) => s.name)).toEqual(["October", "September"]);
    expect(v.summary).toBe("You spent £20.00 from October, £10.00 less than the £30.00 from September.");
    expect(v.limitations).toContain("October has 31 days and September has 30.");
    const groceries = drawn(v)[1].data.find((d) => d.label === "Groceries")!;
    expect(groceries).toMatchObject({ value: 0, note: "nothing spent" });
  });

  it("says there is nothing to compare when the earlier month is before the history", () => {
    const v = buildVisual({ kind: "month_comparison", months: ["2026-09", "2026-08"] }, seed);
    expect(v.series).toEqual([]);
    expect(v.summary).toBe("There's nothing to compare: there's no history from August.");
  });
});

describe("biggest_purchases", () => {
  it("matches biggestItems and never lists refunds or payments", () => {
    const v = buildVisual({ kind: "biggest_purchases" }, seed);
    const nov = SEED_TRANSACTIONS.filter((t) => t.date >= "2026-11-01" && t.date <= DEMO_TODAY);
    expect(drawn(v)[0].data.map((d) => d.evidenceIds![0])).toEqual(biggestItems(nov, 5).map((t) => t.id));
    expect(v.summary).toBe("Your biggest purchase in November so far (8 days) was £64.30 at Trainline.");
    expect(drawn(v)[0].data.every((d) => d.value > 0)).toBe(true);
    expect(v.link?.filters).toMatchObject({ month: "2026-11", sort: "highest" });
  });

  it("clamps the limit and labels a purchase that has a refund", () => {
    const v = buildVisual({ kind: "biggest_purchases", limit: 10 }, seed);
    expect(drawn(v)[0].data).toHaveLength(10);
    const amazon = drawn(v)[0].data.find((d) => d.evidenceIds?.[0] === "t061")!;
    expect(amazon.note).toContain("refund pending");
    expect(amazon.evidenceIds).toContain("t062");
    expect(drawn(buildVisual({ kind: "biggest_purchases", limit: 99 }, seed))[0].data).toHaveLength(10);
    expect(drawn(buildVisual({ kind: "biggest_purchases", limit: 0 }, seed))[0].data).toHaveLength(1);
  });

  it("filters to one category", () => {
    const v = buildVisual({ kind: "biggest_purchases", category: "Groceries", months: ["2026-10"] }, seed);
    expect(drawn(v)[0].data[0]).toMatchObject({ label: "Sainsbury's", value: 4620 });
  });
});

describe("budget_progress", () => {
  it("uses budgetStatus for this month", () => {
    const v = buildVisual({ kind: "budget_progress" }, seed);
    const b = budgetStatus(SEED_TRANSACTIONS, INITIAL_SPEND_PAUSE, DEMO_TODAY)!;
    expect(v.chart).toBe("progress");
    expect(drawn(v)[0].data.map((d) => d.value)).toEqual([b.spent, b.budget, b.remaining, 80]);
    expect(v.summary).toBe("In November so far (8 days), you've spent £402.35 of your £500.00 monthly budget (80%), leaving £97.65.");
    expect(v.limitations).toContain("Spend Pause is off, so purchases aren't checked against this budget.");
    expect(v.link?.to).toBe("/account/spend-pause");
  });

  it("says when spending is over the budget", () => {
    const v = buildVisual({ kind: "budget_progress" }, ctxOf(SEED_TRANSACTIONS, { settings: { ...INITIAL_SPEND_PAUSE, monthlyBudget: 30000, enabled: true } }));
    expect(v.title).toBe("Over your monthly budget");
    expect(drawn(v)[0].data[2]).toMatchObject({ label: "Over the budget", value: 10235 });
    expect(v.limitations).not.toContain("Spend Pause is off, so purchases aren't checked against this budget.");
  });

  it("never invents a budget", () => {
    const ctx = ctxOf(SEED_TRANSACTIONS, { settings: { ...INITIAL_SPEND_PAUSE, monthlyBudget: null } });
    const v = buildVisual({ kind: "budget_progress" }, ctx);
    checkVisual(v, ctx);
    expect(v.series).toEqual([]);
    expect(v.summary).toBe("You haven't set a monthly budget, so there's nothing to measure against yet.");
    expect(v.link).toEqual({ label: "Set a budget in Spend Pause", to: "/account/spend-pause" });
  });
});

describe("monthly_trend and category_trend", () => {
  it("shows every month of the history, partial ones labelled", () => {
    const v = buildVisual({ kind: "monthly_trend" }, seed);
    const m = monthOverMonth(SEED_TRANSACTIONS, DEMO_TODAY);
    const data = drawn(v)[0].data;
    expect(data.map((d) => d.label)).toEqual(["September", "October", "November"]);
    expect(data[1].value).toBe(m.lastMonth.total);
    expect(data[2].value).toBe(m.thisMonth.total);
    expect(data[0].value).toBe(spendingSummary(SEED_TRANSACTIONS, "2026-09-28", "2026-09-30").total);
    expect(data[0].note).toBe("3 days, 28 to 30 September");
    expect(data[2].note).toBe("8 days so far, includes 3 pending items");
    expect(data[1].note).toBeUndefined();
    expect(v.summary).toBe("Your spending by month: September (3 days, 28 to 30 September) £83.78, October £853.27, November so far (8 days) £402.35.");
    expect(v.limitations[0]).toBe("September and November are partial months, so their totals cover fewer days than a full month.");
  });

  it("fills a month with no spending in the middle of the history with a real zero", () => {
    const ctx = ctxOf([tx("2026-08-01", "A", 500), tx("2026-08-20", "Card", -500, "Payments"), tx("2026-10-02", "B", 700)]);
    const v = buildVisual({ kind: "monthly_trend" }, ctx);
    checkVisual(v, ctx);
    expect(drawn(v)[0].data.map((d) => [d.label, d.value])).toEqual([
      ["August", 500],
      ["September", 0],
      ["October", 700],
      ["November", 0],
    ]);
  });

  it("follows one category", () => {
    const v = buildVisual({ kind: "category_trend", category: "Eating out" }, seed);
    const total = (from: string, to: string) => spendingSummary(SEED_TRANSACTIONS.filter((t) => t.category === "Eating out"), from, to).total;
    expect(drawn(v)[0].data.map((d) => d.value)).toEqual([total("2026-09-28", "2026-09-30"), total("2026-10-01", "2026-10-31"), total("2026-11-01", "2026-11-08")]);
    expect(v.link?.filters).toEqual({ category: "Eating out" });
  });

  it("asks for a category rather than guessing one", () => {
    const v = buildVisual({ kind: "category_trend" }, seed);
    expect(v.series).toEqual([]);
    expect(v.summary).toContain("Name a category");
  });

  it("shows nothing when only card payments exist", () => {
    const ctx = ctxOf([tx("2026-10-15", "Payment received", -5000, "Payments")]);
    for (const kind of VISUAL_KINDS) {
      const v = buildVisual({ kind, category: "Shopping" }, ctx);
      if (kind !== "budget_progress") expect(v.series.flatMap((s) => s.data), kind).toEqual([]);
      checkVisual(v, ctx);
    }
  });
});
