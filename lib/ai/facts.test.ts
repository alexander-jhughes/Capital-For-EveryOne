import { describe, expect, it } from "vitest";
import { DEMO_NOW } from "../demo-clock";
import { monthOverMonth } from "../finance";
import type { FactSet, PendingPurchase } from "../types";
import { buildFacts, INTENTS, seedContext } from "./facts";

const ctx = seedContext();
const byId = new Map(ctx.txns.map((t) => [t.id, t]));
const sumIds = (ids: string[]) => ids.reduce((s, id) => s + byId.get(id)!.amount, 0);
const value = (fs: FactSet, key: string) => fs.facts.find((f) => f.key === key)?.value;
const factIds = (fs: FactSet, key: string) => fs.facts.find((f) => f.key === key)!.evidenceIds;
const headphones: PendingPurchase = { id: "p1", merchant: "Northwind Audio", item: "Wireless headphones", amount: 12000, createdAt: DEMO_NOW.toISOString() };

describe("every intent: evidence is traceable", () => {
  for (const intent of INTENTS) {
    it(intent, () => {
      const fs = buildFacts(intent, { ...ctx, purchase: headphones });
      expect(fs.intent).toBe(intent);
      expect(fs.facts.length).toBeGreaterThan(0);
      // Union of fact evidence, deduped, in fact order.
      expect(fs.evidenceIds).toEqual([...new Set(fs.facts.flatMap((f) => f.evidenceIds))]);
      // Every ID is a real transaction, and each evidence row matches it.
      for (const id of fs.evidenceIds) expect(byId.has(id)).toBe(true);
      expect(fs.evidence.map((r) => r.id)).toEqual(fs.evidenceIds);
      // No fact value contains raw pence or unformatted arithmetic.
      for (const f of fs.facts) expect(f.value).not.toMatch(/\d{4,}(?![\d:])/);
      // Deterministic.
      expect(buildFacts(intent, { ...ctx, purchase: headphones })).toEqual(fs);
    });
  }
});

describe("spending facts", () => {
  it("this month: £402.35, and the evidence adds up to it", () => {
    const fs = buildFacts("spend_this_month", ctx);
    expect(value(fs, "month_to_date_total")).toBe("£402.35");
    expect(sumIds(factIds(fs, "month_to_date_total"))).toBe(40235);
    expect(fs.facts[0].label).toBe("Spent this month (1 to 8 November)");
    expect(value(fs, "month_refunds")).toBe("£19.99");
    const m = monthOverMonth(ctx.txns, ctx.today);
    expect(sumIds(factIds(fs, "same_days_last_month_total"))).toBe(m.lastMonthSamePeriod.total);
  });

  it("last month: evidence adds up to the October total", () => {
    const fs = buildFacts("spend_last_month", ctx);
    const m = monthOverMonth(ctx.txns, ctx.today);
    expect(fs.facts[0].label).toBe("Spent in October");
    expect(sumIds(fs.facts[0].evidenceIds)).toBe(m.lastMonth.total);
    expect(fs.evidenceIds).toContain(ctx.txns.find((t) => t.merchant === "Argos")!.id);
  });

  it("top items: three November purchases, biggest first, one ID each", () => {
    const fs = buildFacts("top_items", ctx);
    expect(fs.facts).toHaveLength(3);
    const items = fs.facts.map((f) => byId.get(f.evidenceIds[0])!);
    expect(fs.facts.every((f) => f.evidenceIds.length === 1)).toBe(true);
    expect(items.every((t) => t.date >= "2026-11-01")).toBe(true);
    expect(items[0].amount).toBeGreaterThanOrEqual(items[1].amount);
    expect(items[1].amount).toBeGreaterThanOrEqual(items[2].amount);
    expect(fs.facts[0].value).toBe("Trainline, £64.30, on Monday 2 November");
  });
});

describe("problem-spotting facts", () => {
  it("duplicates: exactly the two Tesco charges", () => {
    const fs = buildFacts("duplicates", ctx);
    const rows = fs.evidenceIds.map((id) => byId.get(id)!);
    expect(rows.map((t) => [t.merchant, t.amount, t.date])).toEqual([
      ["Tesco", 3862, "2026-11-05"],
      ["Tesco", 3862, "2026-11-06"],
    ]);
    expect(fs.facts[0].value).toBe("Tesco, £38.62, on Thursday 5 November and Friday 6 November");
    expect(fs.evidence.map((r) => r.date)).toEqual(["Thursday 5 November", "Friday 6 November"]);
  });

  it("price changes: Netflix £10.99 to £12.99", () => {
    const fs = buildFacts("price_changes", ctx);
    expect(fs.evidenceIds.map((id) => [byId.get(id)!.merchant, byId.get(id)!.amount])).toEqual([
      ["Netflix", 1099],
      ["Netflix", 1299],
    ]);
    expect(fs.facts[0].value).toBe("Netflix went up from £10.99 to £12.99 (£2.00 more), charged on Wednesday 4 November");
  });

  it("says none found rather than inventing evidence", () => {
    const clean = { ...ctx, txns: ctx.txns.filter((t) => t.merchant !== "Tesco" && t.merchant !== "Netflix") };
    expect(buildFacts("duplicates", clean)).toMatchObject({ facts: [{ value: "None found" }], evidenceIds: [] });
    expect(buildFacts("price_changes", clean)).toMatchObject({ facts: [{ value: "None found" }], evidenceIds: [] });
  });
});

describe("bill facts", () => {
  it("due date: Friday 13 November, 5 days, account-level so no evidence", () => {
    const fs = buildFacts("days_until_due", ctx);
    expect(fs.facts.map((f) => f.value)).toEqual(["Friday 13 November", "5 days", "£486.20", "£25.00"]);
    expect(fs.evidenceIds).toEqual([]);
  });
  it("minimum payment leads with £25.00", () => {
    expect(buildFacts("minimum_payment", ctx).facts[0]).toMatchObject({ key: "minimum_payment", value: "£25.00" });
  });
  it("words due today and overdue plainly", () => {
    expect(value(buildFacts("days_until_due", { ...ctx, today: "2026-11-13" }), "days_until_due")).toBe("Today");
    expect(value(buildFacts("days_until_due", { ...ctx, today: "2026-11-15" }), "days_until_due")).toBe("Overdue by 2 days");
  });
});

describe("spend pause facts", () => {
  it("status without a purchase: £97.65 left of £500", () => {
    const fs = buildFacts("spend_pause", ctx);
    expect(value(fs, "spend_pause_status")).toBe("On");
    expect(value(fs, "check_over")).toBe("£100.00");
    expect(value(fs, "budget_left")).toBe("£97.65");
    expect(sumIds(factIds(fs, "budget_spent"))).toBe(40235);
  });

  it("£120 headphones: over £100 and £22.35 over budget", () => {
    const fs = buildFacts("spend_pause", { ...ctx, purchase: headphones });
    expect(value(fs, "pause_decision")).toBe("Check with you first");
    expect(value(fs, "reason_over_threshold")).toBe("£120.00 is over the £100.00 you asked us to check");
    expect(value(fs, "reason_over_budget")).toBe("It would take you £22.35 over your £500.00 monthly budget");
    expect(value(fs, "budget_over_after")).toBe("£22.35");
    expect(value(fs, "balance_after")).toBe("£1,189.89");
    expect(value(fs, "available_credit_after")).toBe("£310.11");
  });

  it("Spend Pause off: lets it through with no reasons", () => {
    const fs = buildFacts("spend_pause", { ...ctx, settings: { ...ctx.settings, enabled: false }, purchase: headphones });
    expect(value(fs, "spend_pause_status")).toBe("Off");
    expect(value(fs, "pause_decision")).toBe("Let it go through");
    expect(fs.facts.some((f) => f.key.startsWith("reason_"))).toBe(false);
  });
});
