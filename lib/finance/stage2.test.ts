import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT as acct, SEED_TRANSACTIONS as txns } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import type { Transaction } from "../types";
import {
  availableCredit,
  budgetStatus,
  daysUntilDue,
  findPossibleDuplicates,
  findPriceChanges,
  monthOverMonth,
  monthToDateSpend,
  spendingSummary,
} from "./index";

const sumOf = (ts: Transaction[]) => ts.reduce((s, t) => s + t.amount, 0);
const spendIn = (from: string, to: string) => txns.filter((t) => t.category !== "Payments" && t.date >= from && t.date <= to);
const find = (merchant: string, date: string) => txns.filter((t) => t.merchant === merchant && t.date === date);

describe("seed invariants (regression)", () => {
  it("keeps the demo's fixed figures", () => {
    expect(acct.statementBalance).toBe(48620);
    expect(acct.minimumPayment).toBe(2500);
    expect(acct.paymentDueDate).toBe("2026-11-13");
    expect(acct.currentBalance).toBe(106989); // unchanged by Stage 2: additions net to zero after the statement date
    expect(monthToDateSpend(txns, DEMO_TODAY)).toBe(40235);
    expect(sumOf(spendIn("2026-11-01", "2026-11-08"))).toBe(40235); // independent recomputation
  });

  it("has unique IDs and keeps t001-t059 in place", () => {
    expect(txns).toHaveLength(62);
    expect(new Set(txns.map((t) => t.id)).size).toBe(62);
    expect(txns.slice(0, 59).map((t) => t.id)).toEqual(Array.from({ length: 59 }, (_, i) => `t${String(i + 1).padStart(3, "0")}`));
  });

  it("keeps exactly one planted duplicate: Tesco £38.62 on 5 and 6 Nov", () => {
    const d = findPossibleDuplicates(txns);
    expect(d).toHaveLength(1);
    expect([d[0].first.merchant, d[0].first.amount, d[0].first.date, d[0].second.date]).toEqual(["Tesco", 3862, "2026-11-05", "2026-11-06"]);
  });

  it("has the Stage 2 additions", () => {
    expect(find("Netflix", "2026-10-04")[0].amount).toBe(1099);
    expect(find("Netflix", "2026-11-04")[0].amount).toBe(1299);
    expect(find("Sainsbury's", "2026-11-07")[0].amount).toBe(4267);
    const argos = txns.filter((t) => t.merchant === "Argos");
    expect(argos).toEqual([expect.objectContaining({ amount: 24900, date: "2026-10-10", status: "posted" })]);
    const refund = txns.filter((t) => t.amount < 0 && t.status === "pending");
    expect(refund).toEqual([expect.objectContaining({ merchant: "Amazon", amount: -1999, date: "2026-11-08" })]);
    expect(find("Amazon", "2026-11-03")[0].amount).toBe(1999); // the matching November offset
  });

  it("leaves room for the £120 demo purchase", () => {
    expect(availableCredit(acct)).toBeGreaterThan(12000);
  });
});

describe("spendingSummary evidence", () => {
  it("returns the IDs behind every total", () => {
    const s = spendingSummary(txns, "2026-11-01", "2026-11-08");
    const byId = new Map(txns.map((t) => [t.id, t]));
    expect(sumOf(s.ids.map((id) => byId.get(id)!))).toBe(s.total);
    expect(s.refundIds.map((id) => byId.get(id)!.amount)).toEqual([-1999]);
    for (const c of s.byCategory) expect(sumOf(c.ids.map((id) => byId.get(id)!))).toBe(c.total);
    expect(s.byCategory.flatMap((c) => c.ids).sort()).toEqual([...s.ids].sort());
  });
});

describe("daysUntilDue", () => {
  it("counts whole days", () => {
    expect(daysUntilDue(acct, DEMO_TODAY)).toBe(5);
    expect(daysUntilDue(acct, "2026-11-13")).toBe(0);
    expect(daysUntilDue(acct, "2026-11-15")).toBe(-2);
  });
});

describe("findPriceChanges", () => {
  it("finds only the Netflix rise in the seed", () => {
    const c = findPriceChanges(txns);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ merchant: "Netflix", change: 200 });
    expect([c[0].before.amount, c[0].after.amount]).toEqual([1099, 1299]);
  });

  const sub = (id: string, merchant: string, date: string, amount: number, category: Transaction["category"] = "Subscriptions"): Transaction => ({
    id,
    date,
    merchant,
    amount,
    category,
    status: "posted",
  });

  it("ignores repeat non-subscription merchants and unchanged prices", () => {
    expect(
      findPriceChanges([
        sub("a", "Trainline", "2026-10-01", 4210, "Travel"),
        sub("b", "Trainline", "2026-11-01", 6430, "Travel"),
        sub("c", "Spotify", "2026-10-01", 1199),
        sub("d", "Spotify", "2026-11-01", 1199),
      ]),
    ).toEqual([]);
  });

  it("reports decreases and compares consecutive charges in date order", () => {
    const c = findPriceChanges([sub("b", "Gym", "2026-11-01", 3000), sub("a", "Gym", "2026-10-01", 3500), sub("c", "Gym", "2026-12-01", 3000)]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ change: -500 });
    expect([c[0].before.id, c[0].after.id]).toEqual(["a", "b"]);
  });

  it("handles empty input", () => expect(findPriceChanges([])).toEqual([]));
});

describe("monthOverMonth", () => {
  it("compares 1-8 Nov with 1-8 Oct and gives October in full", () => {
    const m = monthOverMonth(txns, DEMO_TODAY);
    expect(m.thisMonth.total).toBe(40235);
    expect([m.lastMonthSamePeriod.from, m.lastMonthSamePeriod.to]).toEqual(["2026-10-01", "2026-10-08"]);
    expect(m.lastMonthSamePeriod.total).toBe(sumOf(spendIn("2026-10-01", "2026-10-08")));
    expect([m.lastMonth.from, m.lastMonth.to]).toEqual(["2026-10-01", "2026-10-31"]);
    expect(m.lastMonth.total).toBe(sumOf(spendIn("2026-10-01", "2026-10-31")));
    expect(m.difference).toBe(m.thisMonth.total - m.lastMonthSamePeriod.total);
  });

  it("wraps January back to December", () => {
    const m = monthOverMonth([], "2027-01-15");
    expect([m.lastMonth.from, m.lastMonth.to]).toEqual(["2026-12-01", "2026-12-31"]);
  });

  it("clamps to the end of a shorter previous month", () => {
    const m = monthOverMonth([], "2027-03-31");
    expect(m.lastMonthSamePeriod.to).toBe("2027-02-28");
  });
});

describe("budgetStatus", () => {
  it("reports spend and remaining budget", () => {
    expect(budgetStatus(txns, RESET_SPEND_PAUSE, DEMO_TODAY)).toEqual({ budget: 50000, spent: 40235, remaining: 9765 });
  });
  it("is null with no budget", () => {
    expect(budgetStatus(txns, { ...RESET_SPEND_PAUSE, monthlyBudget: null }, DEMO_TODAY)).toBeNull();
  });
});
