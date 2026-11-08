import { describe, expect, it } from "vitest";
import { SEED_TRANSACTIONS as seed } from "../data/seed";
import { monthOverMonth, spendingSummary } from "../finance";
import type { Transaction } from "../types";
import { spendingHref, parseSpendingFilters } from "./spending-filters";
import {
  describeEmpty,
  describeFilters,
  filterTransactions,
  monthComparison,
  monthRange,
  narrowsList,
  resolveFilters,
  sortTransactions,
  spendingView,
} from "./spending-view";

const TODAY = "2026-11-08";
const ids = (ts: Transaction[]) => ts.map((t) => t.id);

describe("monthRange", () => {
  it("a past month runs from the first to the last day", () => {
    expect(monthRange("2026-10", TODAY)).toEqual({ month: "2026-10", from: "2026-10-01", to: "2026-10-31", end: "2026-10-31", partial: false, future: false, days: 31 });
    expect(monthRange("2026-09", TODAY).to).toBe("2026-09-30");
    expect(monthRange("2028-02", "2028-03-01").to).toBe("2028-02-29");
    expect(monthRange("2027-02", "2027-03-01").to).toBe("2027-02-28");
  });

  it("this month stops at today and says how many days", () => {
    expect(monthRange("2026-11", TODAY)).toMatchObject({ from: "2026-11-01", to: "2026-11-08", end: "2026-11-30", partial: true, days: 8 });
  });

  it("a month that hasn't started is empty", () => {
    expect(monthRange("2026-12", TODAY)).toMatchObject({ future: true, partial: false, days: 0 });
    expect(filterTransactions(seed, { month: "2026-12" }, TODAY)).toEqual([]);
  });
});

describe("filterTransactions", () => {
  it("never includes card payments", () => {
    const all = filterTransactions(seed, {}, TODAY);
    expect(all.some((t) => t.category === "Payments")).toBe(false);
    expect(all).toHaveLength(seed.length - 1);
    expect(ids(filterTransactions(seed, { month: "2026-10" }, TODAY))).not.toContain("t022");
  });

  it("a month filter keeps only that month's dates", () => {
    const oct = filterTransactions(seed, { month: "2026-10" }, TODAY);
    expect(oct.every((t) => t.date >= "2026-10-01" && t.date <= "2026-10-31")).toBe(true);
    expect(oct).toHaveLength(seed.filter((t) => t.date.startsWith("2026-10") && t.category !== "Payments").length);
    const sep = filterTransactions(seed, { month: "2026-09" }, TODAY);
    expect(ids(sep)).toEqual(["t001", "t002", "t003", "t004"]);
  });

  it("category and month together", () => {
    const rows = filterTransactions(seed, { category: "Groceries", month: "2026-10" }, TODAY);
    expect(rows).toHaveLength(10);
    expect(rows.every((t) => t.category === "Groceries")).toBe(true);
  });

  it("matches the merchant exactly, ignoring case", () => {
    const extra: Transaction[] = [
      ...seed,
      { id: "x1", date: "2026-10-20", merchant: "Tesco Mobile", amount: 1500, category: "Subscriptions", status: "posted" },
      { id: "x2", date: "2026-10-21", merchant: "Tesco Express", amount: 800, category: "Groceries", status: "posted" },
    ];
    const tesco = filterTransactions(extra, { merchant: "Tesco", month: "2026-10" }, TODAY);
    expect(tesco.map((t) => t.merchant)).toEqual(Array(5).fill("Tesco"));
    expect(ids(filterTransactions(extra, { merchant: "tesco mobile" }, TODAY))).toEqual(["x1"]);
    expect(filterTransactions(extra, { merchant: "Tes" }, TODAY)).toEqual([]);
    expect(resolveFilters(extra, { merchant: "tesco" }).merchant).toBe("Tesco");
  });
});

describe("spendingView", () => {
  it("figures come from spendingSummary: Groceries in October", () => {
    const v = spendingView(seed, { category: "Groceries", month: "2026-10" }, TODAY);
    expect(v.summary.total).toBe(31830);
    expect(v.summary.count).toBe(10);
    expect(v.summary).toEqual(spendingSummary(seed.filter((t) => t.category === "Groceries"), "2026-10-01", "2026-10-31"));
    expect(v.status).toBe("Showing Groceries in October: 10 purchases, £318.30");
    expect(v.notes).toEqual([]);
  });

  it("refunds reduce the total and are counted separately", () => {
    const v = spendingView(seed, { category: "Shopping", month: "2026-10" }, TODAY);
    expect(v.rows).toHaveLength(5);
    expect(v.summary.count).toBe(4);
    expect(v.summary.total).toBe(1899 + 3450 + 1499 - 1499 + 24900);
    expect(v.status).toBe("Showing Shopping in October: 4 purchases and 1 refund, £302.49 after refunds");
  });

  it("this month matches monthOverMonth and says it's partial", () => {
    const v = spendingView(seed, { month: "2026-11" }, TODAY);
    expect(v.summary.total).toBe(monthOverMonth(seed, TODAY).thisMonth.total);
    expect(v.summary.total).toBe(40235);
    expect(v.notes).toEqual(["November so far: 8 days, 1 Nov to 8 Nov."]);
  });

  it("says when the records only cover part of a month", () => {
    expect(spendingView(seed, { month: "2026-09" }, TODAY).notes).toEqual(["Your records start on 28 Sept, so September is only partly here."]);
    expect(spendingView(seed, { month: "2026-08" }, TODAY).notes).toEqual(["Your records start on 28 Sept."]);
  });

  it("an empty result says what was looked for", () => {
    const v = spendingView(seed, { category: "Travel", month: "2026-09" }, TODAY);
    expect(v.rows).toEqual([]);
    expect(v.status).toBe("Showing Travel in September: no purchases");
    expect(spendingView(seed, { month: "2026-12" }, TODAY).status).toBe("Showing Spending in December: December hasn't started yet");
  });

  it("uses the account's spelling of the merchant", () => {
    expect(spendingView(seed, { merchant: "tesco" }, TODAY).description).toBe("Tesco");
  });
});

describe("describeFilters", () => {
  it.each([
    [{}, "All spending"],
    [{ category: "Groceries" as const }, "Groceries"],
    [{ category: "Groceries" as const, month: "2026-10" }, "Groceries in October"],
    [{ merchant: "Tesco", month: "2026-11" }, "Tesco in November"],
    [{ category: "Groceries" as const, merchant: "Tesco" }, "Groceries at Tesco"],
    [{ month: "2026-10" }, "Spending in October"],
    [{ month: "2026-10", sort: "highest" as const }, "Spending in October, highest amount first"],
    [{ category: "Eating out" as const, sort: "shop" as const }, "Eating out, by shop, A to Z"],
  ])("%j", (f, text) => {
    expect(describeFilters(f)).toBe(text);
  });

  it("names the year only when it isn't this year", () => {
    expect(describeFilters({ month: "2025-10" }, TODAY)).toBe("Spending in October 2025");
    expect(describeFilters({ month: "2026-10" }, TODAY)).toBe("Spending in October");
  });

  it("empty states", () => {
    expect(describeEmpty({ category: "Groceries", month: "2026-09" })).toBe("No Groceries purchases in September.");
    expect(describeEmpty({ merchant: "Argos", month: "2026-11" })).toBe("No purchases at Argos in November.");
    expect(describeEmpty({ month: "2026-12" }, TODAY)).toBe("December hasn't started yet, so there's nothing to show.");
  });
});

describe("monthComparison", () => {
  it("this month against the same days last month, like monthOverMonth", () => {
    const c = monthComparison(seed, "2026-11", TODAY);
    const mom = monthOverMonth(seed, TODAY);
    expect(c.current).toEqual(mom.thisMonth);
    expect(c.previous).toEqual(mom.lastMonthSamePeriod);
    expect(c.previousFull).toEqual(mom.lastMonth);
    expect(c.previousIncomplete).toBe(false);
  });

  it("a past month against the whole month before, flagged when records start part way", () => {
    const c = monthComparison(seed, "2026-10", TODAY);
    expect(c.range.partial).toBe(false);
    expect(c.previous.from).toBe("2026-09-01");
    expect(c.previous.to).toBe("2026-09-30");
    expect(c.previous.total).toBe(5218 + 290 + 410 + 2460);
    expect(c.previousIncomplete).toBe(true);
    expect(c.previousBeforeRecords).toBe(false);
    expect(monthComparison(seed, "2026-09", TODAY).previousBeforeRecords).toBe(true);
    expect(c.current.byCategory.find((x) => x.category === "Groceries")?.total).toBe(31830);
  });
});

describe("helpers", () => {
  it("sorts like the list", () => {
    const rows = filterTransactions(seed, { category: "Travel" }, TODAY);
    expect(ids(sortTransactions(rows, "highest"))).toEqual(["t044", "t023"]);
    expect(ids(sortTransactions(rows, "oldest"))).toEqual(["t023", "t044"]);
  });

  it("narrowsList ignores txn and highlight", () => {
    expect(narrowsList(parseSpendingFilters(new URLSearchParams("txn=t012&highlight=t001")))).toBe(false);
    expect(narrowsList({ sort: "oldest" })).toBe(true);
    expect(spendingHref({ category: "Groceries", month: "2026-10" })).toBe("/account/spending?category=Groceries&month=2026-10");
  });
});
