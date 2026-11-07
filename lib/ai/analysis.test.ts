// Categories, payment history and how Spend Pause works: facts the finance layer computes, checked claim by claim.
import { describe, expect, it } from "vitest";
import { answerFacts } from "./answer-facts";
import { answerQuestion } from "./ask";
import { seedContext, type FactContext } from "./facts";
import { checkAnswer } from "./guard";
import type { AnswerIntent } from "./intent";
import { contextFromState } from "./live-state";

const seed = seedContext();
const paidOff = contextFromState({ payments: [{ id: "pay-1", date: "2026-11-08", amount: 48620 }] });
const check = (intent: AnswerIntent, question: string, reply: string, ctx: FactContext = seed) => checkAnswer(reply, answerFacts(intent, ctx, question), question);
const ask = (question: string, ctx: FactContext = seed) => answerQuestion(question, { model: null, ctx });

describe("spending by category", () => {
  it.each([
    ["What's my biggest spending category?", "Your biggest category this month is Groceries, £183.53."],
    ["Which category did I spend the least on?", "Your smallest spending category this month is Transport, £16.30."],
    ["What was my smallest category last month?", "Your smallest spending category last month was Subscriptions, £22.98."],
    ["What did I spend on groceries?", "You have spent £183.53 on Groceries this month."],
    ["How much did I spend on restaurants?", "You have spent £67.25 on Eating out this month."],
    ["Did I spend more on groceries or eating out?", "You have spent £183.53 on Groceries and £67.25 on Eating out this month, so that is £116.28 more on Groceries than on Eating out."],
  ])("%s", async (question, answer) => expect((await ask(question)).answer).toBe(answer));

  it("evidence is only the category asked about", async () => {
    const result = await ask("What did I spend on groceries?");
    const byId = new Map(seed.txns.map((t) => [t.id, t]));
    expect(result.evidenceIds.length).toBeGreaterThan(0);
    expect(result.evidenceIds.every((id) => byId.get(id)?.category === "Groceries" && byId.get(id)!.date >= "2026-11-01")).toBe(true);
  });

  it("the full list adds up to the month, with no card payments in it", async () => {
    const facts = answerFacts("category_spending", seed, "What are my spending categories?");
    const pence = facts.facts.map((f) => Math.round(Number(f.value.split("£")[1].replace(/,/g, "")) * 100));
    expect(pence.reduce((a, b) => a + b, 0)).toBe(40235);
    expect(facts.facts.some((f) => f.value.startsWith("Payments"))).toBe(false);
  });

  it("a new purchase moves its category", async () => {
    const ctx = contextFromState({ purchases: [{ id: "demo-1", date: "2026-11-08", amount: 12000, merchant: "Dial Shop" }] });
    expect((await ask("How much have I spent on shopping?", ctx)).answer).toBe("You have spent £165.99 on Shopping this month.");
  });

  it.each([
    ["What's my biggest spending category?", "Your biggest category this month is Transport, £183.53."],
    ["What's my biggest spending category?", "Your smallest category this month is Groceries, £183.53."],
    ["What's my biggest spending category?", "Your biggest category last month was Groceries, £183.53."],
    ["What did I spend on groceries?", "You have spent £67.25 on Groceries this month."],
    ["Did I spend more on groceries or eating out?", "You spent £116.28 more on Eating out than on Groceries this month."],
  ])("rejects %j answered %j", (question, reply) => expect(check("category_spending", question, reply).ok).toBe(false));

  it("other periods and unknown shops aren't answered with this month", async () => {
    for (const q of ["How much did I spend on groceries yesterday?", "How much did I spend on groceries in September?", "What did I spend on groceries at Lidl?"]) {
      expect((await ask(q)).answer, q).toBe("I can't tell that from your transactions.");
    }
  });
});

describe("payment history", () => {
  it("names the real latest payment and its status", async () => {
    expect((await ask("Did my payment go through?")).answer).toBe(
      "Your latest payment was £180.00 on Thursday 15 October, and it is completed. Your statement balance still to pay is £486.20.",
    );
    const live = await ask("Did my payment go through?", paidOff);
    expect(live.answer).toBe("Your latest payment was £486.20 on Sunday 8 November, and it is pending, so it hasn't cleared yet. Your statement balance is now £0.00.");
    expect(live.evidenceIds).toContain("pay-1");
  });

  it.each([
    ["a pending payment called completed", "Your £486.20 payment on Sunday 8 November has gone through.", paidOff],
    ["a payment that isn't there", "Your latest payment was £100.00 on Sunday 8 November.", seed],
    ["the wrong date", "Your latest payment was £180.00 on Sunday 8 November, and it is completed.", seed],
    ["a completed payment called pending", "Your latest payment of £180.00 on Thursday 15 October is still pending.", seed],
  ])("rejects %s", (_, reply, ctx) => expect(check("payment_history", "Did my payment go through?", reply, ctx).ok).toBe(false));

  it("is never counted as spending", async () => {
    expect((await ask("How much did I spend this month?", paidOff)).answer).toContain("£402.35");
  });
});

describe("a paid-off bill", () => {
  it.each(["When is my bill due?", "What's my minimum payment?", "How much do I need to pay?"])("%s says nothing is due", async (question) => {
    expect((await ask(question, paidOff)).answer).toBe(
      question.includes("minimum") ? "Your minimum payment is £0.00, so nothing is due on this bill by Friday 13 November." : "Your statement balance is £0.00, so nothing is due on this bill by Friday 13 November.",
    );
  });

  it("nothing is due is a contradiction while there's a bill", () => {
    expect(check("days_until_due", "When is my bill due?", "Nothing is due on your bill by Friday 13 November.").ok).toBe(false);
  });
});

describe("how Spend Pause works", () => {
  it.each(["What happens if I activate Spend Pause?", "How does Spend Pause work?", "Will Spend Pause block my purchases?"])("%s is explained", async (question) => {
    const result = await ask(question);
    expect(result.answer).toContain("checks a purchase in the Dial demo shop");
    expect(result.answer).toContain("does not change your balance");
    expect(result.evidenceIds).toEqual([]);
  });

  it("status answers carry no transactions as evidence", async () => {
    const result = await ask("Is Spend Pause on?");
    expect(result.answer).toMatch(/^Spend Pause is on\./);
    expect(result.evidenceIds).toEqual([]);
  });

  it("follows the live setting", async () => {
    const off = contextFromState({ spendPause: { enabled: false, singlePurchaseThreshold: 10000, monthlyBudget: 50000, quietHours: null } });
    expect((await ask("What happens if I activate Spend Pause?", off)).answer).toContain("It is off now");
  });

  it.each([
    "Spend Pause blocks all your purchases until you turn it off.",
    "Spend Pause freezes your card, so nothing can be bought.",
    "Spend Pause checks each purchase and lowers your balance.",
    "Spend Pause declines purchases at any shop on your real card.",
  ])("rejects %j", (reply) => expect(check("spend_pause", "What happens if I activate Spend Pause?", reply).ok).toBe(false));

  it("accepts a true reply", () => {
    expect(check("spend_pause", "What happens if I activate Spend Pause?", "Spend Pause checks a purchase in the Dial demo shop before it goes through, and you choose Go ahead or Cancel it.")).toEqual({ ok: true });
  });
});

describe("Spend Pause status can't be smuggled in as a condition", () => {
  const off = contextFromState({ spendPause: { enabled: false, singlePurchaseThreshold: 10000, monthlyBudget: 50000, quietHours: null } });
  it("still rejects a plain wrong status", () => {
    expect(check("spend_pause", "Is Spend Pause on?", "Spend Pause is on, and it checks any purchase over £100.00.", off).ok).toBe(false);
    expect(check("spend_pause", "Is Spend Pause on?", "Spend Pause is off.").ok).toBe(false);
  });
  it("allows a condition", () => {
    expect(check("spend_pause", "What happens if I activate Spend Pause?", "When Spend Pause is on, it checks a purchase in the Dial demo shop and you choose Go ahead or Cancel it. It is off now.", off)).toEqual({ ok: true });
  });
});

describe("a paid-off bill can't be described as due", () => {
  it.each([
    ["When is my bill due?", "Your payment is due on Friday 13 November.", "days_until_due"],
    ["When is my bill due?", "Your bill is due on Friday 13 November, in 5 days.", "days_until_due"],
    ["What's my minimum payment?", "Your minimum payment is due on Friday 13 November.", "minimum_payment"],
    ["When is my bill due?", "Your payment is due on Friday 13 November. There is nothing due on this statement.", "days_until_due"],
    ["What's my minimum payment?", "Your minimum payment of £0.00 is due on Friday 13 November.", "minimum_payment"],
  ] as const)("rejects %j answered %j", (question, reply, intent) => expect(check(intent, question, reply, paidOff).ok).toBe(false));

  it("accepts the truth", () => {
    expect(check("days_until_due", "When is my bill due?", "Your statement balance is £0.00, so nothing is due by Friday 13 November.", paidOff)).toEqual({ ok: true });
    expect(check("days_until_due", "What's my current balance?", "Your current balance is £583.69.", paidOff)).toEqual({ ok: true });
  });
});

describe("a model that gives up", () => {
  it("is replaced by the template when the facts answer the question", async () => {
    const model = { classify: async () => null, phrase: async () => "I can't tell that from your transactions." };
    const result = await answerQuestion("Is Spend Pause on and what's my limit?", { model });
    expect(result).toMatchObject({ source: "template" });
    expect(result.answer).toMatch(/^Spend Pause is on\./);
  });
});

describe("a pending refund inside the month's total", () => {
  it.each([
    "You have spent £402.35 this month. This includes £19.99 in refunds already taken off the total.",
    "You have spent £402.35 this month, after your £19.99 refund arrived.",
    "You have spent £402.35 this month, after £19.99 in refunds.",
  ])("rejects %j", (reply) => expect(check("spend_this_month", "How much have I spent this month?", reply).ok).toBe(false));

  it("accepts saying it's pending", () => {
    expect(check("spend_this_month", "How much have I spent this month?", "You have spent £402.35 this month, counting a £19.99 refund that is still pending.")).toEqual({ ok: true });
    expect(check("spend_this_month", "How much have I spent this month?", "You have spent £402.35 this month.")).toEqual({ ok: true });
  });
});

describe("counts in a reply", () => {
  it("the pence of an amount are never read as a count", () => {
    const facts = answerFacts("merchant_transactions", seed, "What did I spend at Tesco this month?", "Tesco");
    expect(checkAnswer("You spent a total of £98.71 across 3 purchases at Tesco this month.", facts, "What did I spend at Tesco this month?")).toEqual({ ok: true });
    expect(checkAnswer("You spent a total of £98.71 across 4 purchases at Tesco this month.", facts, "What did I spend at Tesco this month?").ok).toBe(false);
  });
});
