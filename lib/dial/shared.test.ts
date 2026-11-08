import { describe, expect, it } from "vitest";
import { splitCorrection } from "../voice/correction";
import { hasFilters, parseSpendingFilters, spendingHref } from "./spending-filters";

describe("splitCorrection", () => {
  it.each([
    ["How much did I spend on food? Actually, groceries.", "How much did I spend on food?", "groceries."],
    ["Take me to pay, no wait, spending", "Take me to pay", "spending"],
    ["Show October. No, I mean September", "Show October.", "September"],
    ["Open settings, scratch that, open goals", "Open settings", "open goals"],
    ["A, actually B, no I mean C", "A, actually B", "C"],
  ])("%s", (text, before, after) => {
    expect(splitCorrection(text)).toEqual({ before, after });
  });

  it.each(["I actually spent too much", "Actually, how much do I owe?", "What did I spend?", "Food, actually"])("no correction: %s", (text) => {
    expect(splitCorrection(text)).toBeNull();
  });
});

describe("spending filters", () => {
  it("round-trips through the URL", () => {
    const f = { category: "Groceries" as const, month: "2026-10", txn: "t012", sort: "highest" as const, highlight: ["t001", "t002"] };
    const href = spendingHref(f);
    expect(href).toBe("/account/spending?category=Groceries&month=2026-10&txn=t012&sort=highest&highlight=t001,t002");
    expect(parseSpendingFilters(new URLSearchParams(href.split("?")[1]))).toEqual(f);
  });

  it("drops anything not allowlisted", () => {
    expect(parseSpendingFilters({ category: "Payments", month: "2026-13", txn: "<script>", sort: "random", merchant: "a".repeat(80), highlight: "t1,<x>" })).toEqual({ highlight: ["t1"] });
    expect(hasFilters({})).toBe(false);
    expect(spendingHref()).toBe("/account/spending");
  });

  it("reads Next.js searchParams objects", () => {
    expect(parseSpendingFilters({ category: ["Eating out"], merchant: "Sainsbury's" })).toEqual({ category: "Eating out", merchant: "Sainsbury's" });
  });
});
