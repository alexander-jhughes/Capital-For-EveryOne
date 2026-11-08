import { describe, expect, it } from "vitest";
import { namedShops } from "../ai/intent";
import { SEED_TRANSACTIONS } from "../data/seed";
import {
  addMonths,
  findAmount,
  findCategories,
  findMerchants,
  findMonths,
  findTargetMonth,
  findTransactionRef,
  monthName,
  monthRange,
  validPence,
  wordsToNumber,
} from "./entities";

const MERCHANTS = [...new Set(SEED_TRANSACTIONS.map((t) => t.merchant))];
const ENV = { today: "2026-11-08", months: ["2026-09", "2026-10", "2026-11"] };
const cats = (text: string) => findCategories(text).map((c) => c.category);

describe("categories", () => {
  it.each([
    ["groceries", ["Groceries"]],
    ["the supermarket", ["Groceries"]],
    ["my food shopping", ["Groceries"]],
    ["the weekly shop", ["Groceries"]],
    ["takeaways", ["Eating out"]],
    ["restaurants", ["Eating out"]],
    ["eating out", ["Eating out"]],
    ["fast food", ["Eating out"]],
    ["food delivery", ["Eating out"]],
    ["the tube", ["Transport"]],
    ["buses", ["Transport"]],
    ["commuting", ["Transport"]],
    ["trains", ["Travel"]],
    ["travel", ["Travel"]],
    ["holidays", ["Travel"]],
    ["subscriptions", ["Subscriptions"]],
    ["streaming", ["Subscriptions"]],
    ["shopping", ["Shopping"]],
    ["clothes", ["Shopping"]],
    ["groceries and eating out", ["Groceries", "Eating out"]],
  ])("%s", (text, expected) => {
    expect(cats(text)).toEqual(expected);
  });

  it("'food' on its own is reported as ambiguous, never as one category", () => {
    expect(cats("How much did I spend on food?")).toEqual(["food"]);
    expect(cats("food shopping")).toEqual(["Groceries"]);
    expect(cats("fast food")).toEqual(["Eating out"]);
  });

  it("doesn't find categories inside other words or phrases", () => {
    expect(cats("my shopping list")).toEqual([]);
    expect(cats("business and youtube")).toEqual([]);
    expect(cats("spend pause")).toEqual([]);
  });

  it("returns where each match is, for corrections", () => {
    const [m] = findCategories("How much on food?");
    expect(m).toMatchObject({ start: 12, end: 16, text: "food" });
  });
});

describe("merchants", () => {
  const shops = (text: string) => findMerchants(text, MERCHANTS).matches.map((m) => m.merchant);

  it("matches whole words, case-insensitively, with or without the apostrophe", () => {
    expect(shops("show my tesco transactions")).toEqual(["Tesco"]);
    expect(shops("Sainsburys last month")).toEqual(["Sainsbury's"]);
    expect(shops("Sainsbury's")).toEqual(["Sainsbury's"]);
    expect(shops("Tesco's prices")).toEqual(["Tesco"]);
    expect(shops("TFL and greggs")).toEqual(["TfL", "Greggs"]);
    expect(shops("Argosy")).toEqual([]);
  });

  it("never reads a different business that shares a word as the shop", () => {
    expect(findMerchants("my Tesco Mobile bill", MERCHANTS)).toEqual({ matches: [], otherBusiness: "Tesco Mobile" });
    expect(shops("Amazon Prime")).toEqual([]);
    expect(shops("Tesco Bank and Tesco")).toEqual(["Tesco"]);
  });

  it("never treats card payments as a shop", () => {
    expect(shops("payment received")).toEqual([]);
  });

  it("agrees with the backend's rule", () => {
    for (const text of ["Did Tesco charge me twice?", "Tesco Mobile", "Sainsburys", "Amazon Prime", "Argos and Deliveroo", "argosy"])
      expect(shops(text).sort(), text).toEqual(namedShops(text, MERCHANTS.filter((m) => !/^payment/i.test(m))).sort());
  });
});

describe("months", () => {
  const months = (text: string) => findMonths(text, ENV).months;

  it.each([
    ["October", ["2026-10"]],
    ["in oct", ["2026-10"]],
    ["this month", ["2026-11"]],
    ["so far", ["2026-11"]],
    ["last month", ["2026-10"]],
    ["the previous month", ["2026-10"]],
    ["the last three months", ["2026-09", "2026-10", "2026-11"]],
    ["past 2 months", ["2026-10", "2026-11"]],
    ["October with September", ["2026-10", "2026-09"]],
    ["between September and November", ["2026-09", "2026-10", "2026-11"]],
    ["September to November", ["2026-09", "2026-10", "2026-11"]],
    ["October 2026", ["2026-10"]],
  ])("%s", (text, expected) => {
    expect(months(text)).toEqual(expected);
  });

  it("only months with data, or this month, count; others are reported as unavailable", () => {
    expect(findMonths("December", ENV)).toMatchObject({ months: [], unavailable: ["2025-12"] });
    expect(findMonths("the last six months", ENV).months).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(findMonths("next month", ENV)).toMatchObject({ months: [], unavailable: ["2026-12"] });
  });

  it("'may' is only a month after a word that introduces one", () => {
    expect(months("May I see my spending?")).toEqual([]);
    expect(findMonths("in May", ENV).unavailable).toEqual(["2026-05"]);
  });

  it("goal and what-if months are the next one after today", () => {
    expect(findTargetMonth("by January", "2026-11-08")).toBe("2027-01");
    expect(findTargetMonth("by December", "2026-11-08")).toBe("2026-12");
    expect(findTargetMonth("by November", "2026-11-08")).toBe("2027-11");
    expect(findTargetMonth("by next month", "2026-11-08")).toBe("2026-12");
    expect(findTargetMonth("by Christmas", "2026-11-08")).toBe("2026-12");
    expect(findTargetMonth("by the end of the month", "2026-11-08")).toBe("2026-11");
    expect(findTargetMonth("save £500", "2026-11-08")).toBeNull();
  });

  it("month arithmetic and names", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2026-11", "2026-09")).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(monthName("2026-10", "2026-11-08")).toBe("October");
    expect(monthName("2027-01", "2026-11-08")).toBe("January 2027");
  });
});

describe("amounts", () => {
  const pence = (text: string, loose = false) => findAmount(text, { loose })?.pence ?? null;

  it.each([
    ["£100", 10000],
    ["100 pounds", 10000],
    ["a hundred pounds", 10000],
    ["£1,250.50", 125050],
    ["£80", 8000],
    ["80 quid", 8000],
    ["£12.5", 1250],
    ["£1.5k", 150000],
    ["two hundred and fifty pounds", 25000],
    ["one thousand five hundred pounds", 150000],
    ["fifty pounds", 5000],
    ["50p", 50],
  ])("%s", (text, expected) => {
    expect(pence(text)).toBe(expected);
  });

  it("needs a currency word unless loose, and never reads counts, years or references", () => {
    expect(pence("spend 100 less")).toBeNull();
    expect(pence("spend 100 less", true)).toBe(10000);
    expect(pence("a hundred less", true)).toBe(10000);
    expect(pence("the last 3 months", true)).toBeNull();
    expect(pence("transaction t012", true)).toBeNull();
    expect(pence("in 2026", true)).toBeNull();
  });

  it("amounts are positive whole pence under £100,000", () => {
    expect(validPence(10000)).toBe(true);
    expect(validPence(0)).toBe(false);
    expect(validPence(10_000_000)).toBe(false);
    expect(validPence(1.5)).toBe(false);
    expect(wordsToNumber("banana")).toBeNull();
    expect(wordsToNumber("five a")).toBeNull();
  });
});

describe("transaction references", () => {
  const env = { transactionIds: SEED_TRANSACTIONS.map((t) => t.id), merchants: MERCHANTS, transactions: SEED_TRANSACTIONS };

  it.each([
    ["transaction t012", { kind: "id", id: "t012" }],
    ["T012", { kind: "id", id: "t012" }],
    ["open transaction t999", { kind: "unknown", id: "t999" }],
    ["the Argos purchase", { kind: "merchant", merchant: "Argos", id: "t060" }],
    ["the Amazon purchase", { kind: "merchant", merchant: "Amazon" }],
  ])("%s", (text, expected) => {
    expect(findTransactionRef(text, env)).toEqual(expected);
  });

  it("a list or a bare code is not a reference", () => {
    expect(findTransactionRef("my Amazon purchases", env)).toBeNull();
    expect(findTransactionRef("t999", env)).toBeNull();
    expect(findTransactionRef("the biggest expense", env)).toBeNull();
  });

  it("without transaction details, a shop's purchase has no id", () => {
    expect(findTransactionRef("the Argos purchase", { ...env, transactions: undefined })).toEqual({ kind: "merchant", merchant: "Argos" });
  });
});
