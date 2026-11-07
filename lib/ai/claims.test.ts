import { describe, expect, it, vi } from "vitest";
import { answerFacts } from "./answer-facts";
import { answerQuestion, handleAsk } from "./ask";
import { amountSpans } from "./claims";
import { seedContext } from "./facts";
import { CANT_TELL, checkAnswer } from "./guard";
import { matchIntent, namedMerchants, UNSUPPORTED, type AnswerIntent } from "./intent";
import { allowModelCall, resetRateLimit } from "./rate-limit";
import { templateAnswer } from "./templates";

const ctx = seedContext();
const NAMES = {
  merchants: [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))],
  categories: [...new Set(ctx.txns.map((t) => t.category))],
};
const check = (intent: AnswerIntent, reply: string, question = "", merchant?: string) => checkAnswer(reply, answerFacts(intent, ctx, question, merchant), question);

describe("the 17 wrong replies from the review", () => {
  it.each<[AnswerIntent, string, string?, string?]>([
    ["spend_this_month", "You have spent £402.35, and your biggest category is Groceries at £145.63."],
    ["spend_this_month", "You spent £145.63 so far this month and £402.35 in the same days last month."],
    ["spend_this_month", "You spent £402.35 from 1 to 8 October."],
    ["spend_last_month", "You spent £853.27 in October, and your biggest category was Groceries at £853.27."],
    ["top_items", "Amazon was your biggest purchase, at £64.30."],
    ["price_changes", "Netflix went up by £10.99 to £12.99."],
    ["days_until_due", "Your balance is £25.00, due on Friday 13 November.", "When is my bill due?"],
    ["days_until_due", "Your bill is due on Friday, in 13 days.", "When is my bill due?"],
    ["days_until_due", "Your total balance is £486.20.", "How much is my bill?"],
    ["merchant_refunds", "Your £19.99 refund is pending. Your £14.99 refund arrived on Sunday 8 November.", "", "Amazon"],
    ["merchant_transactions", "You have 5 Amazon transactions, totalling £99.48.", "", "Amazon"],
    ["merchant_transactions", "You have 7 Amazon transactions, and your latest purchase was £99.48.", "", "Amazon"],
    ["spend_pause", "You have £100.00 left in your budget."],
    ["spend_pause", "Your monthly budget is £97.65."],
    ["duplicates", "<b>Tesco</b> charged you £38.62 twice."],
    ["duplicates", "Tesco charged you £38.62 twice. <script>alert(1)</script>"],
    ["duplicates", "[Tesco](http://evil.example) charged you £38.62 twice."],
  ])("%s rejects %j", (intent, reply, question, merchant) => {
    expect(check(intent, reply, question, merchant).ok).toBe(false);
  });
});

describe("more wrong replies", () => {
  it.each<[AnswerIntent, string, string?, string?]>([
    // Wrong amounts on the right shop
    ["top_items", "Trainline was your biggest purchase, at £45.99."],
    ["top_items", "Your biggest purchase was Sainsbury's at £64.30."],
    ["top_items", "Your biggest purchase was Amazon at £45.99."],
    // Wrong dates on the right amount
    ["top_items", "Trainline was your biggest purchase, at £64.30 on Friday 6 November."],
    ["merchant_refunds", "Your £19.99 Amazon refund on Thursday 29 October is pending. Your £14.99 refund has arrived.", "", "Amazon"],
    // Pending described as arrived
    ["merchant_refunds", "Your £19.99 Amazon refund is no longer pending. Your £14.99 Amazon refund has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £19.99 Amazon refund is not pending. Your £14.99 Amazon refund has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £19.99 Amazon refund has finished processing. Your £14.99 refund has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £19.99 Amazon refund has landed after pending. Your £14.99 refund has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £19.99 refund is pending and has arrived. Your £14.99 refund has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £14.99 refund is pending. Your £19.99 refund has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £19.99 purchase refund has arrived. Your £14.99 refund has arrived.", "", "Amazon"],
    ["spend_this_month", "You have spent £402.35, and your £19.99 refund has arrived."],
    // Balances
    ["days_until_due", "Your current balance is £1,069.89, which is due on Friday 13 November.", "When is my bill due?"],
    ["days_until_due", "£1,069.89 is payable by Friday 13 November.", "When is my bill due?"],
    ["days_until_due", "Your bill of £1,069.89 is due on Friday 13 November.", "When is my bill due?"],
    ["days_until_due", "Your minimum payment is £486.20, due on Friday 13 November.", "When is my bill due?"],
    ["days_until_due", "Your statement balance is £25.00, and your minimum is £486.20.", "How much do I need to pay?"],
    ["minimum_payment", "Your minimum payment is £25.00, and your current balance is £25.00."],
    // Meaning reversed
    ["spend_pause", "You are £97.65 over your budget this month."],
    ["spend_pause", "Spend Pause has been turned off, and you have £97.65 left."],
    ["spend_pause", "Spend Pause is disabled, and you have £97.65 left."],
    ["duplicates", "Tesco charged you £38.62 only once."],
    ["price_changes", "Netflix stayed the same at £12.99."],
    // Advice and outside topics
    ["days_until_due", "You could pay £486.20 by Friday 13 November to avoid interest.", "When is my bill due?"],
    ["days_until_due", "Your bill is £486.20, and you can pay it on Friday 13 November.", "When is my bill due?"],
    ["minimum_payment", "Your minimum payment is £25.00, and interest will be added."],
    // Formatting
    ["duplicates", "Tesco charged you #38.62 twice."],
    ["duplicates", "Tesco charged you 38.62 twice."],
    ["duplicates", "**Tesco** charged you £38.62 twice."],
    ["duplicates", "See www.example.com: Tesco charged you £38.62 twice."],
    ["duplicates", "Tesco | £38.62 | twice"],
  ])("%s rejects %j", (intent, reply, question, merchant) => {
    expect(check(intent, reply, question, merchant).ok).toBe(false);
  });
});

describe("right replies stay accepted", () => {
  // Real Groq replies from the live samples, including the two the sentence-level check wrongly threw away.
  it.each<[AnswerIntent, string, string?, string?]>([
    ["merchant_refunds", "Your £19.99 Amazon refund on Sunday 8 November is pending and has not arrived yet, while your £14.99 Amazon refund on Thursday 29 October is completed and has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your £19.99 Amazon refund on Sunday 8 November is pending and has not arrived yet, but your £14.99 Amazon refund on Thursday 29 October has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your Amazon refund of £19.99 on Sunday 8 November is pending and has not arrived yet. Your completed Amazon refund of £14.99 on Thursday 29 October has arrived.", "", "Amazon"],
    ["merchant_refunds", "Your Amazon refund of £19.99 on Sunday 8 November is pending and has not arrived yet. Your Amazon refund of £14.99 on Thursday 29 October is completed and has arrived.", "", "Amazon"],
    ["price_changes", "Netflix went up from £10.99 to £12.99 on Wednesday 4 November."],
    ["price_changes", "Yes, Netflix went up from £10.99 to £12.99, which is £2.00 more, and was charged on Wednesday 4 November."],
    ["price_changes", "Your Netflix subscription went up by £2.00 to £12.99, and was charged on Wednesday 4 November."],
    ["price_changes", "Your Netflix subscription increased from £10.99 to £12.99 on Wednesday 4 November."],
    ["price_changes", "Netflix went up from £10.99 to £12.99 (£2.00 more), charged on Wednesday 4 November."],
    ["days_until_due", "Your full bill, which is the statement balance, is £486.20 and your minimum payment is £25.00.", "How much do I need to pay?"],
    ["days_until_due", "Your full statement balance, the amount on your latest bill, is £486.20. The minimum payment is £25.00, and both are due by Friday 13 November.", "How much do I need to pay?"],
    ["days_until_due", "Your current balance, which is everything on the card right now and not all due yet, is £1,069.89.", "What's my current balance?"],
    ["days_until_due", "Your statement balance is £486.20 and you owe £1,069.89 in total right now.", "What's my balance?"],
    ["days_until_due", "Your next payment is due on Friday 13 November.", "When is my next payment due?"],
    ["days_until_due", "Your bill of £486.20 is due on Friday 13 November. That is in 5 days.", "When is my bill due?"],
    ["days_until_due", "Your current balance is £1,069.89, which is everything on the card right now, and not all of it is due yet. Your latest bill, the statement balance, is £486.20, and the minimum payment on it is £25.00, by Friday 13 November.", "How much do I owe?"],
    ["minimum_payment", "Your minimum payment is £25.00, and it is due on Friday 13 November."],
    ["spend_this_month", "You have spent £402.35 this month from 1 to 8 November."],
    ["spend_this_month", "You spent £402.35 this month from 1 to 8 November, which is £256.72 more than the same days last month."],
    ["spend_this_month", "You spent £402.35 from 1 to 8 November. Your biggest category this month is Groceries, at £183.53."],
    ["spend_this_month", "You have spent £402.35 so far this month. Your biggest category is Groceries, £183.53."],
    ["spend_last_month", "You spent £853.27 in October across 36 purchases."],
    ["spend_last_month", "You spent £853.27 in October. Your biggest category was Groceries, £318.30."],
    ["top_items", "Your biggest purchase this month was Trainline for £64.30 on Monday 2 November, your second biggest was Amazon for £45.99 on Friday 6 November, and your third biggest was Sainsbury's for £42.67 on Saturday 7 November."],
    ["top_items", "Your biggest purchases this month were Trainline for £64.30 on Monday 2 November, Amazon for £45.99 on Friday 6 November, and Sainsbury's for £42.67 on Saturday 7 November."],
    ["top_items", "Your biggest purchases this month were: Trainline, £64.30, on Monday 2 November; Amazon, £45.99, on Friday 6 November; Sainsbury's, £42.67, on Saturday 7 November."],
    ["spend_pause", "Your monthly budget is £500.00, and you have spent £402.35 of it this month."],
    ["spend_pause", "Your monthly budget is £500.00, and you have spent £402.35 towards it this month."],
    ["spend_pause", "Spend Pause is on. It checks any purchase over £100.00, and you have £97.65 left in your budget this month."],
    ["spend_pause", "Yes, Spend Pause is on."],
    ["duplicates", "You have a possible duplicate charge of £38.62 at Tesco on Thursday 5 November and Friday 6 November."],
    ["duplicates", "You had a Tesco charge of £38.62 on Thursday 5 November and another of £38.62 on Friday 6 November, which could be a duplicate charge."],
    ["duplicates", "You have charges at Tesco for £38.62 on Thursday 5 November and Friday 6 November, which might be duplicates."],
    ["duplicates", "You may have paid Tesco £38.62 twice."],
    ["merchant_transactions", "You spent £249.00 at Argos on Saturday 10 October.", "", "Argos"],
    ["merchant_transactions", "You spent £249.00 on Saturday 10 October at Argos.", "", "Argos"],
    ["merchant_transactions", "Your Argos purchase was £249.00 on Saturday 10 October.", "", "Argos"],
    ["merchant_transactions", "You bought something from Argos on Saturday 10 October.", "When did I buy something from Argos?", "Argos"],
    ["merchant_transactions", "You have 7 Amazon transactions, totalling £99.48, after refunds, counting pending items. The latest is £19.99 on Sunday 8 November (pending refund).", "", "Amazon"],
  ])("%s accepts %j", (intent, reply, question, merchant) => {
    expect(check(intent, reply, question, merchant)).toEqual({ ok: true });
  });
});

describe("reading a reply", () => {
  it("gives each amount its own words", () => {
    const reply = "Your bill is £486.20 and your minimum is £25.00.";
    const [first, second] = amountSpans(reply);
    expect(reply.slice(first.from, first.to)).toBe("Your bill is £486.20");
    expect(reply.slice(second.from, second.to)).toBe("your minimum is £25.00");
  });

  it("keeps amounts in thousands whole", () => {
    expect(amountSpans("You spent £1,249.00.")[0].amount).toBe("£1249.00");
  });
});

describe("routing to the right question", () => {
  it.each<[string, AnswerIntent]>([
    ["What's my biggest category?", "category_spending"],
    ["What was my biggest category last month?", "category_spending"],
    ["What's my biggest spending category?", "category_spending"],
    ["Which category did I spend the least on?", "category_spending"],
    ["What's my grocery spend?", "category_spending"],
    ["Did I spend more on groceries or eating out?", "category_spending"],
    ["Did my payment go through?", "payment_history"],
    ["Has my payment been recorded?", "payment_history"],
    ["How much did I just pay?", "payment_history"],
    ["What was my biggest purchase in October?", "top_items"],
    ["Did I spend more than last month?", "spend_this_month"],
    ["How does this month compare to last month?", "spend_this_month"],
    ["What is the least I can pay?", "minimum_payment"],
    ["When did I last pay?", "days_until_due"],
    ["What do I need to pay?", "days_until_due"],
  ])("%s", (question, intent) => expect(matchIntent(question, NAMES)).toBe(intent));

  it.each([
    "How much did I spend in Lidl?",
    "What's my food spend this month?",
    "What was my Uber spend?",
    "What was my least expensive purchase?",
    "Which shop did I spend the least at?",
    "Where do I spend the most?",
    "What's my cheapest subscription?",
    "Did Currys refund me?",
    "Has Currys refunded me?",
    "Did I get a Currys refund?",
    "Did I get my money back from Currys?",
  ])("%s is unsupported", (question) => expect(matchIntent(question, NAMES)).toBe(UNSUPPORTED));

  it.each([
    ["Was Lidl charged twice?", "Lidl"],
    ["Did I pay Lidl twice?", "Lidl"],
    ["Did Lidl charge me twice?", "Lidl"],
    ["Was I charged twice at lidl?", "lidl"],
    ["Have I been charged twice by Lidl?", "Lidl"],
  ])("%s names %s", (question, shop) => expect(namedMerchants(question, NAMES.merchants)).toEqual([shop]));

  it("doesn't read ordinary words as shops", () => {
    expect(namedMerchants("Was I charged twice by mistake?", NAMES.merchants)).toEqual([]);
    expect(namedMerchants("Did I pay twice?", NAMES.merchants)).toEqual([]);
  });
});

describe("the right answers", () => {
  it("answers the biggest category", async () => {
    expect((await answerQuestion("What's my biggest category?", { model: null })).answer).toBe("Your biggest category this month is Groceries, £183.53.");
    expect((await answerQuestion("What was my biggest category last month?", { model: null })).answer).toBe("Your biggest category last month was Groceries, £318.30.");
  });

  it("answers October with October", async () => {
    const result = await answerQuestion("What was my biggest purchase in October?", { model: null });
    expect(result.answer).toContain("Your biggest purchases last month were: Argos, £249.00");
    expect(result.answer).not.toContain("Trainline, £64.30");
    expect(result.evidenceIds).toContain("t060");
    const byId = new Map(ctx.txns.map((t) => [t.id, t]));
    expect(result.evidenceIds.every((id) => byId.get(id)?.date.startsWith("2026-10"))).toBe(true);
  });

  it("doesn't give a November duplicate for an October question", async () => {
    const result = await answerQuestion("Was I charged twice in October?", { model: null });
    expect(result).toMatchObject({ answer: "I can't see any possible duplicate charges.", evidenceIds: [] });
    expect((await answerQuestion("Was I charged twice in November?", { model: null })).evidenceIds).toEqual(["t051", "t052"]);
  });

  it("compares the months", async () => {
    const result = await answerQuestion("Did I spend more than last month?", { model: null });
    expect(result.answer).toBe("You have spent £402.35 so far this month, £256.72 more than the same days last month, when you spent £145.63.");
  });

  it("every shop template survives the validator, in every period", async () => {
    for (const question of ["How much did I spend at Amazon last month?", "How much did I spend at Amazon this month?", "How much did I spend at Amazon?", "Show me my Tesco transactions from last month."]) {
      const set = answerFacts("merchant_transactions", ctx, question, question.includes("Tesco") ? "Tesco" : "Amazon");
      expect(checkAnswer((await answerQuestion(question, { model: null })).answer, set, question)).toEqual({ ok: true });
    }
  });

  it("two pending refunds each say they're pending", () => {
    const ctx2 = { ...ctx, txns: [...ctx.txns, { id: "x2", date: "2026-11-07", merchant: "Amazon", amount: -4599, category: "Shopping" as const, status: "pending" as const }] };
    const set = answerFacts("merchant_refunds", ctx2, "", "Amazon");
    const answer = templateAnswer(set);
    expect(answer.match(/is pending/g)).toHaveLength(2);
    expect(checkAnswer(answer, set)).toEqual({ ok: true });
  });

  it("gives the last payment", async () => {
    expect((await answerQuestion("When did I last pay?", { model: null })).answer).toBe("Your last payment was £180.00 on Thursday 15 October.");
  });

  it("need to pay gives both amounts, however it's asked", async () => {
    expect((await answerQuestion("What do I need to pay?", { model: null })).answer).toContain("£25.00");
  });

  it.each(["Was Lidl charged twice?", "Did Currys refund me?", "How much did I spend in Lidl?", "Which shop did I spend the least at?"])("%s falls back", async (question) => {
    expect(await answerQuestion(question, { model: null })).toMatchObject({ answer: CANT_TELL, evidenceIds: [] });
  });

  it("a wrong real-looking reply is replaced by the correct template", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const phrase = async () => "Your biggest purchase this month was Amazon at £64.30.";
    const result = await answerQuestion("What were my biggest purchases?", { model: { classify: async () => null, phrase } });
    expect(result.source).toBe("template");
    expect(result.answer).toContain("Trainline, £64.30");
    vi.restoreAllMocks();
  });
});

describe("API protection", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) => handleAsk(new Request("http://test/api/ask", { method: "POST", body, headers, duplex: "half" } as RequestInit), () => null);

  it("refuses an oversized body from its header, without reading it", async () => {
    const response = await post('{"question":"hi"}', { "content-length": "999999" });
    expect(response.status).toBe(400);
  });

  it("stops reading a body that turns out too big, whatever the header says", async () => {
    let chunks = 0;
    const stream = new ReadableStream({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(2000)));
      },
    });
    const response = await post(stream);
    expect(response.status).toBe(400);
    expect(chunks).toBeLessThan(10);
  });

  it("still reads a normal body", async () => {
    expect((await post(JSON.stringify({ question: "How much do I owe?" }))).status).toBe(200);
  });

  it("handles multi-byte text", async () => {
    expect((await post(JSON.stringify({ question: "Where’s my £ gone? 你好" }))).status).toBe(200);
  });

  it("limits model calls per visitor, then keeps answering without the model", async () => {
    resetRateLimit();
    const phrase = vi.fn(async () => "Tesco charged you £38.62 twice.");
    const create = () => ({ classify: async () => null, phrase });
    const ask = () => handleAsk(new Request("http://test/api/ask", { method: "POST", body: JSON.stringify({ question: "Was I charged twice?" }), headers: { "x-forwarded-for": "9.9.9.9" } }), create);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 60; i += 1) expect((await (await ask()).json()).source).toBe("model");
    const blocked = await ask();
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ source: "template", evidenceIds: ["t051", "t052"] });
    expect(phrase).toHaveBeenCalledTimes(60);
    expect(warn.mock.calls.flat().join(" ")).toContain("Groq call limit reached");
    vi.restoreAllMocks();
  });

  it("the limit can be set for long test runs", () => {
    resetRateLimit();
    vi.stubEnv("ASK_MODEL_CALLS_PER_MINUTE", "2");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([allowModelCall("c", 1), allowModelCall("c", 2), allowModelCall("c", 3)]).toEqual([true, true, false]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("the window moves on, and visitors are separate", () => {
    resetRateLimit();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 60; i += 1) allowModelCall("a", 1000);
    expect(allowModelCall("a", 1001)).toBe(false);
    expect(allowModelCall("b", 1001)).toBe(true);
    expect(allowModelCall("a", 62_000)).toBe(true);
  });
});
