import { describe, expect, it, vi } from "vitest";
import type { Intent, Transaction } from "../types";
import { answerFacts } from "./answer-facts";
import { answerQuestion, handleAsk } from "./ask";
import { ASK_INTENTS, parseExperience, selectExperience, TEMPLATE_FOR_INTENT, TEMPLATES } from "./experience";
import { INTENTS, seedContext, type FactContext } from "./facts";
import { CANT_TELL, checkAnswer } from "./guard";
import { matchIntent, UNSUPPORTED } from "./intent";
import { askIntentFor, CLARIFY_GENERAL, interpretQuestion } from "./interpreter";
import { parseInterpretation, type AskModel, type ModelInterpretation } from "./model";
import { checkEvidence, validateResponse } from "./validator";

const ctx = seedContext();
const names = {
  merchants: [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))],
  categories: [...new Set(ctx.txns.map((t) => t.category))],
  ids: ctx.txns.map((t) => t.id),
};
const byId = new Map(ctx.txns.map((t) => [t.id, t]));
const REFUND_IDS = ["t062", "t061", "t036", "t028"];
const NOVEMBER = "November 2026";

const fakeModel = (over: Partial<AskModel> = {}): AskModel => ({
  classify: vi.fn(async (): Promise<ModelInterpretation | null> => null),
  phrase: vi.fn(async (): Promise<string | null> => null),
  ...over,
});
const understood = (intent: ModelInterpretation["intent"], confidence: ModelInterpretation["confidence"] = "high") => async () => ({ intent, confidence });

describe("the required questions, end to end with no model", () => {
  it.each([
    ["How much do I owe?", "statement", "statement_balance", undefined, ["£1,069.89", "£486.20", "£25.00"], []],
    ["How much have I spent this month?", "spending", "spending_insights", NOVEMBER, ["£402.35"], undefined],
    ["What subscriptions am I paying for?", "subscriptions", "subscription_query", undefined, ["Netflix", "£12.99", "Spotify", "£11.99"], undefined],
    ["Have I been charged twice by Tesco?", "transaction", "transaction_investigation", undefined, ["Tesco", "£38.62"], ["t051", "t052"]],
    ["Where is my Amazon refund?", "transaction", "transaction_investigation", undefined, ["£19.99", "pending", "£14.99"], REFUND_IDS],
    ["When is my next payment due?", "payment", "payment_planning", undefined, ["Friday 13 November"], []],
    ["How much did I spend at Argos?", "spending", "spending_insights", undefined, ["£249.00", "Saturday 10 October"], ["t060"]],
  ])("%s", async (question, template, intent, periodLabel, figures, evidenceIds) => {
    const result = await answerQuestion(question, { model: null });
    expect(result.experience).toEqual({ template, intent, confidence: "high", ...(periodLabel ? { periodLabel } : {}) });
    for (const figure of figures) expect(result.answer).toContain(figure);
    if (evidenceIds) expect(result.evidenceIds).toEqual(evidenceIds);
    expect(parseExperience(result.experience)).toEqual(result.experience);
  });

  it("an ambiguous question asks for clarification, with no evidence and no model call", async () => {
    const model = fakeModel();
    const result = await answerQuestion("How much is it?", { model });
    expect(result).toEqual({ answer: CLARIFY_GENERAL, evidenceIds: [], source: "template", experience: { template: "general", intent: "general", confidence: "low" } });
    expect(model.classify).not.toHaveBeenCalled();
  });

  it.each(["Is that right?", "What about that one?", "Tell me more", "why", "?"])("%j is too vague to guess at", async (question) => {
    expect((await answerQuestion(question, { model: null })).answer).toBe(CLARIFY_GENERAL);
  });

  it("two shops at once asks which one", async () => {
    const result = await answerQuestion("How much did I spend at Amazon or Tesco?", { model: fakeModel() });
    expect(result.answer).toMatch(/^Which shop do you mean: (Tesco or Amazon|Amazon or Tesco)\?$/);
    expect(result.experience?.confidence).toBe("low");
  });

  it("an unsupported question gets the safe general fallback", async () => {
    const result = await answerQuestion("What is my credit score?", { model: null });
    expect(result).toMatchObject({ answer: CANT_TELL, evidenceIds: [], source: "template" });
    expect(result.experience?.template).toBe("general");
  });

  it("advice requests are general, and never reach the model", async () => {
    const model = fakeModel();
    const result = await answerQuestion("Should I get a second credit card?", { model });
    expect(result.experience).toEqual({ template: "general", intent: "general", confidence: "high" });
    expect(model.classify).not.toHaveBeenCalled();
    expect(model.phrase).not.toHaveBeenCalled();
  });
});

describe("Agent 1: interpreter", () => {
  const interpret = (question: string, model: AskModel | null = null) => interpretQuestion(question, names, model, 1000, () => {});

  it("extracts what it can from a question", async () => {
    expect((await interpret("Was the £38.62 at Tesco last month charged twice?")).entities).toEqual({ merchant: "Tesco", period: "last_month" });
    expect((await interpret("What is t051?")).entities).toEqual({ transactionRef: "t051", period: "all" });
  });

  it("only names a shop that's really in the data", async () => {
    expect((await interpret("How much did I spend at Currys?")).entities.merchant).toBeUndefined();
    expect((await interpret("How much did I spend at Tesco Mobile?")).entities.merchant).toBeUndefined();
  });

  it("uses no model call when the rules are sure", async () => {
    const model = fakeModel();
    await answerQuestion("Have I been charged twice by Tesco?", { model });
    expect(model.classify).not.toHaveBeenCalled();
    expect(model.phrase).toHaveBeenCalledOnce();
  });

  it("makes at most two model calls for one question", async () => {
    const model = fakeModel({ classify: vi.fn(understood("days_until_due")), phrase: vi.fn(async () => null) });
    await answerQuestion("Am I square with you lot?", { model });
    expect(model.classify).toHaveBeenCalledOnce();
    expect(model.phrase).toHaveBeenCalledOnce();
  });

  it("low confidence asks instead of guessing", async () => {
    const model = fakeModel({ classify: understood("spend_this_month", "low"), phrase: vi.fn(async () => "You spent £402.35 this month.") });
    const result = await answerQuestion("Am I square with you lot?", { model });
    expect(result.answer).toBe(CLARIFY_GENERAL);
    expect(result.experience).toEqual({ template: "general", intent: "general", confidence: "low" });
    expect(model.phrase).not.toHaveBeenCalled();
  });

  it("medium confidence carries through to the response", async () => {
    const model = fakeModel({ classify: understood("spend_this_month", "medium"), phrase: async () => "You spent £402.35 this month." });
    expect((await answerQuestion("Am I square with you lot?", { model })).experience).toEqual({ template: "spending", intent: "spending_insights", confidence: "medium", periodLabel: NOVEMBER });
  });

  it("the model's none is the general fallback", async () => {
    const result = await answerQuestion("Am I square with you lot?", { model: fakeModel({ classify: understood(null) }) });
    expect(result).toMatchObject({ answer: CANT_TELL, experience: { template: "general", confidence: "high" } });
  });

  it("a failed classification is safe", async () => {
    const onError = vi.fn();
    const model = fakeModel({ classify: async () => Promise.reject(new Error("boom")) });
    expect(await interpretQuestion("Am I square with you lot?", names, model, 1000, onError)).toMatchObject({ kind: "unsupported", confidence: "low" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each<[Intent | "merchant_transactions", string, string]>([
    ["days_until_due", "How much do I owe?", "statement_balance"],
    ["days_until_due", "What's my current balance?", "statement_balance"],
    ["days_until_due", "How much is my bill?", "statement_balance"],
    ["days_until_due", "When is my bill due?", "payment_planning"],
    ["days_until_due", "How much do I need to pay?", "payment_planning"],
    ["minimum_payment", "What's my minimum payment?", "payment_planning"],
    ["merchant_transactions", "How much did I spend at Argos?", "spending_insights"],
    ["merchant_transactions", "Show me my Amazon transactions.", "transaction_investigation"],
    ["merchant_transactions", "When did I buy something from Argos?", "transaction_investigation"],
    ["price_changes", "What subscriptions increased?", "subscription_query"],
    ["spend_pause", "Is Spend Pause on?", "general"],
  ])("%s for %j is %s", (intent, question, expected) => expect(askIntentFor(intent, question)).toBe(expected));

  it("subscription lists and price changes are told apart", () => {
    expect(matchIntent("What subscriptions am I paying for?", names)).toBe("subscription_list");
    expect(matchIntent("Show me my subscriptions", names)).toBe("subscription_list");
    expect(matchIntent("What subscriptions increased?", names)).toBe("price_changes");
    expect(matchIntent("Has any subscription gone up?", names)).toBe("price_changes");
    expect(matchIntent("How much do I spend on subscriptions?", names)).toBe(UNSUPPORTED);
  });
});

describe("invalid model output", () => {
  it.each([
    ["no confidence", { category: "duplicates" }],
    ["a bad confidence", { category: "duplicates", confidence: "certain" }],
    ["an unknown category", { category: "drop_tables", confidence: "high" }],
    ["a non-string category", { category: 7, confidence: "high" }],
    ["nothing", null],
    ["an empty object", {}],
  ])("rejects %s", (_, reply) => expect(parseInterpretation(reply)).toBeNull());

  it("accepts a valid reply, and drops anything extra", () => {
    const reply = { category: "duplicates", confidence: "high", template: "<script>alert(1)</script>", evidenceIds: ["t999"], html: "<b>x</b>" };
    expect(parseInterpretation(reply)).toEqual({ intent: "duplicates", confidence: "high" });
  });

  it("invalid classification falls back to general", async () => {
    const result = await answerQuestion("Am I square with you lot?", { model: fakeModel({ classify: async () => null }) });
    expect(result).toMatchObject({ answer: CANT_TELL, evidenceIds: [], experience: { template: "general", confidence: "low" } });
  });
});

describe("Agent 2: template selection", () => {
  it("every intent has exactly one valid template", () => {
    for (const intent of ASK_INTENTS) expect(TEMPLATES).toContain(TEMPLATE_FOR_INTENT[intent]);
    expect(new Set(Object.values(TEMPLATE_FOR_INTENT)).size).toBe(TEMPLATES.length);
  });

  it.each([
    ["an unknown template", { template: "dashboard", intent: "general", confidence: "high" }],
    ["markup as a template", { template: "<script>", intent: "general", confidence: "high" }],
    ["a template that doesn't match its intent", { template: "payment", intent: "statement_balance", confidence: "high" }],
    ["an unknown intent", { template: "general", intent: "delete_account", confidence: "high" }],
    ["a bad confidence", { template: "general", intent: "general", confidence: 0.9 }],
    ["an empty period", { template: "general", intent: "general", confidence: "high", periodLabel: " " }],
    ["a non-string period", { template: "general", intent: "general", confidence: "high", periodLabel: 12 }],
    ["nothing", null],
  ])("rejects %s", (_, value) => expect(parseExperience(value)).toBeNull());

  it("keeps only the agreed fields", () => {
    expect(parseExperience({ template: "general", intent: "general", confidence: "high", html: "<b>x</b>" })).toEqual({ template: "general", intent: "general", confidence: "high" });
  });

  it("selection always gives something valid", () => {
    expect(selectExperience("payment_planning", "high")).toEqual({ template: "payment", intent: "payment_planning", confidence: "high" });
    expect(selectExperience("spending_insights", "medium", NOVEMBER).periodLabel).toBe(NOVEMBER);
  });

  it("periods follow the question", async () => {
    expect((await answerQuestion("What did I spend last month?", { model: null })).experience?.periodLabel).toBe("October 2026");
    expect((await answerQuestion("How much did I spend at Tesco this month?", { model: null })).experience?.periodLabel).toBe(NOVEMBER);
    expect((await answerQuestion("How much did I spend at Tesco?", { model: null })).experience?.periodLabel).toBeUndefined();
  });
});

describe("Agent 3: finance validator", () => {
  const duplicates = answerFacts("duplicates", ctx);
  const refunds = answerFacts("merchant_refunds", ctx, "", "Amazon");
  const bill = answerFacts("days_until_due", ctx);
  const good = "Tesco charged you £38.62 twice.";

  it("passes a correct reply", () => {
    expect(validateResponse(good, ["t051", "t052"], duplicates, ctx, "")).toEqual({ ok: true });
  });

  it.each([
    ["an invented id", ["t051", "t999"], "unknown evidence id"],
    ["a repeated id", ["t051", "t051"], "repeated evidence id"],
    ["a real id that isn't behind the facts", ["t051", "t001"], "evidence doesn't match the facts"],
    ["only some of the evidence", ["t051"], "evidence doesn't match the facts"],
  ])("rejects %s", (_, ids, reason) => expect(checkEvidence(ids, duplicates, ctx)).toEqual({ ok: false, reason }));

  it("rejects a transaction answer with no evidence", () => {
    const hollow = { ...duplicates, evidenceIds: [], evidence: [] };
    expect(checkEvidence([], hollow, ctx)).toEqual({ ok: false, reason: "missing evidence" });
  });

  it("allows no evidence for account-level answers and for finding nothing", () => {
    expect(checkEvidence([], bill, ctx)).toEqual({ ok: true });
    expect(checkEvidence([], answerFacts("merchant_refunds", ctx, "", "Tesco"), ctx)).toEqual({ ok: true });
  });

  it.each([
    ["a wrong amount", "Tesco charged you £38.63 twice.", "amount not in facts"],
    ["a wrong date", "Tesco charged you £38.62 twice on 7 November.", "number not in facts"],
    ["an invented shop", "Lidl charged you £38.62 twice.", "name not in facts"],
    ["another currency", "Tesco charged you $38.62 twice.", "amount not in facts"],
    ["advice", "Tesco charged you £38.62 twice, so you should complain.", "advice wording"],
    ["a transaction id", "Tesco charged you £38.62 twice, see t999.", "number not in facts"],
    ["HTML", "<b>Tesco</b> charged you £38.62 twice.", "markup or code"],
    ["a script", "Tesco charged you £38.62 twice.<script>alert(1)</script>", "markup or code"],
    ["a markdown link", "[Tesco](http://example.com) charged you £38.62 twice.", "markup or code"],
    ["a code block", "`Tesco` charged you £38.62 twice.", "markup or code"],
    ["JSON", '{"template":"payment"} Tesco charged you £38.62 twice.', "markup or code"],
  ])("rejects %s", (_, reply, reason) => expect(checkAnswer(reply, duplicates)).toEqual({ ok: false, reason }));

  it("keeps pending and completed apart", () => {
    expect(validateResponse("Your £19.99 refund has arrived. Your £14.99 refund has arrived.", REFUND_IDS, refunds, ctx, "").ok).toBe(false);
    expect(validateResponse("Your £19.99 refund is pending. Your £14.99 refund has arrived.", REFUND_IDS, refunds, ctx, "").ok).toBe(true);
  });

  it("keeps refunds out of general spending evidence and matched to their purchases", () => {
    expect(refunds.evidence.map((row) => [row.id, row.status])).toEqual([["t062", "pending"], ["t061", "posted"], ["t036", "posted"], ["t028", "posted"]]);
    for (const [refund, purchase] of [["t062", "t061"], ["t036", "t028"]]) expect(byId.get(refund)?.amount).toBe(-(byId.get(purchase)?.amount ?? 0));
  });

  it("keeps the current and statement balances apart", () => {
    expect(validateResponse("Your current balance is £486.20.", [], bill, ctx, "What's my current balance?")).toEqual({ ok: false, reason: "no supporting fact" });
    expect(validateResponse("Your statement balance is £1,069.89.", [], bill, ctx, "How much is my bill?")).toEqual({ ok: false, reason: "no supporting fact" });
    expect(validateResponse("Your current balance is £1,069.89.", [], bill, ctx, "What's my current balance?")).toEqual({ ok: true });
  });

  it("a model reply of I can't tell opens no specialist screen", async () => {
    const result = await answerQuestion("How much is my bill?", { model: fakeModel({ phrase: async () => CANT_TELL }) });
    expect(result).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "model", experience: { template: "general", intent: "general", confidence: "high" } });
  });

  it("a bad model reply is replaced, and the evidence stays real", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => "Tesco charged you £99.99 twice." });
    const result = await answerQuestion("Have I been charged twice by Tesco?", { model });
    expect(result).toMatchObject({ source: "template", evidenceIds: ["t051", "t052"], experience: { template: "transaction" } });
    expect(result.answer).toContain("£38.62");
    vi.restoreAllMocks();
  });

  it("a fixed demo sentence is dropped when the account no longer matches it", async () => {
    const changed: FactContext = { ...ctx, account: { ...ctx.account, statementBalance: 1000 } };
    const result = await answerQuestion("When is my bill due?", { model: null, ctx: changed });
    expect(result.source).toBe("template");
    expect(result.answer).toContain("£10.00");
    expect(result.answer).not.toContain("£486.20");
  });

  it("every intent's own answer passes the final gate", async () => {
    for (const intent of [...INTENTS, "subscription_list", "transaction_lookup"] as const) {
      const question = intent === "transaction_lookup" ? "What is t051?" : "";
      const facts = answerFacts(intent, ctx, question);
      expect(checkEvidence(facts.evidenceIds, facts, ctx)).toEqual({ ok: true });
    }
  });
});

describe("new facts", () => {
  it("lists each subscription once, at its latest price", () => {
    const set = answerFacts("subscription_list", ctx);
    expect(set.facts.map((f) => f.value)).toEqual(["Netflix, £12.99, last charged on Wednesday 4 November", "Spotify, £11.99, last charged on Sunday 1 November"]);
    expect(set.evidenceIds.every((id) => byId.get(id)?.category === "Subscriptions")).toBe(true);
  });

  it("a subscription reply has to name them all", () => {
    const set = answerFacts("subscription_list", ctx);
    expect(checkAnswer("You pay Netflix £12.99 and Spotify £11.99.", set)).toEqual({ ok: true });
    expect(checkAnswer("You pay Netflix £12.99.", set)).toEqual({ ok: false, reason: "no supporting fact" });
    expect(checkAnswer("You pay Netflix £11.99 and Spotify £12.99.", set)).toEqual({ ok: false, reason: "contradicts facts" });
  });

  it("finds a transaction by reference, with its true status", async () => {
    const posted = await answerQuestion("What is t051?", { model: null });
    expect(posted).toMatchObject({ evidenceIds: ["t051"], experience: { template: "transaction" } });
    expect(posted.answer).toContain("completed");
    expect((await answerQuestion("What is t062?", { model: null })).answer).toContain("pending refund");
  });

  it("a reference lookup needs no model", async () => {
    const model = fakeModel({ phrase: vi.fn(async () => CANT_TELL) });
    const result = await answerQuestion("What is t062?", { model });
    expect(model.phrase).not.toHaveBeenCalled();
    expect(result).toMatchObject({ evidenceIds: ["t062"], experience: { template: "transaction" } });
    expect(result.answer).toContain("pending refund");
  });

  it("never invents a transaction for an unknown reference", async () => {
    expect(await answerQuestion("Show me transaction t999", { model: null })).toMatchObject({ answer: "I can't find a transaction with that reference.", evidenceIds: [], experience: { template: "general" } });
  });

  it("can't call a pending transaction completed", () => {
    const set = answerFacts("transaction_lookup", ctx, "t062");
    expect(checkAnswer("That Amazon refund of £19.99 has arrived.", set)).toEqual({ ok: false, reason: "contradicts facts" });
    expect(checkAnswer("That Amazon refund of £19.99 is pending.", set)).toEqual({ ok: true });
  });
});

describe("the API contract", () => {
  const post = (body: string) => handleAsk(new Request("http://test/api/ask", { method: "POST", body }), () => null);

  it("keeps the original fields, and adds experience", async () => {
    const body = await (await post(JSON.stringify({ question: "How much do I owe?" }))).json();
    expect(Object.keys(body).sort()).toEqual(["answer", "evidenceIds", "experience", "source"]);
    expect(typeof body.answer).toBe("string");
    expect(Array.isArray(body.evidenceIds)).toBe(true);
    expect(body.source).toBe("template");
  });

  it("errors stay as they were", async () => {
    const response = await post('{"question":"  "}');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Please type a question first." });
  });

  it("the default summary has an experience too", async () => {
    expect((await (await post("{}")).json()).experience).toMatchObject({ template: "spending", periodLabel: NOVEMBER });
  });

  it("a cached demo answer has one too", async () => {
    expect(await answerQuestion("Did I pay Tesco twice this month?", { model: null })).toMatchObject({ source: "cache", experience: { template: "transaction", confidence: "high" } });
  });
});

describe("the regressions from review", () => {
  const withTxns = (txns: Transaction[]): FactContext => ({ ...ctx, txns });
  const noNovember = ctx.txns.filter((t) => !t.date.startsWith("2026-11"));
  const row = (id: string, date: string, merchant: string, amount: number, category: Transaction["category"] = "Shopping"): Transaction => ({ id, date, merchant, amount, category, status: "posted" });

  it("an empty month is £0.00, not I can't tell", async () => {
    const result = await answerQuestion("What did I spend this month?", { model: null, ctx: withTxns(noNovember) });
    expect(result).toMatchObject({ answer: "You have spent £0.00 so far this month.", evidenceIds: [], experience: { template: "spending" } });
    const earlier = await answerQuestion("What did I spend last month?", { model: null, ctx: withTxns(ctx.txns.filter((t) => !t.date.startsWith("2026-10"))) });
    expect(earlier.answer).toContain("£0.00");
  });

  it.each(["When is my bill due?", "When is my next payment due?", "How much is my bill?", "How much do I need to pay?", "How much do I owe?"])("%s works when both balances are equal", async (question) => {
    const same = { ...ctx, account: { ...ctx.account, currentBalance: ctx.account.statementBalance } };
    const result = await answerQuestion(question, { model: null, ctx: same });
    expect(result.answer).toContain("£486.20");
    expect(result.answer).not.toBe(CANT_TELL);
  });

  it("purchases of £1,000 or more work", async () => {
    const big = withTxns([...ctx.txns, row("x1", "2026-11-07", "Currys", 124900)]);
    const top = await answerQuestion("What were my biggest purchases?", { model: null, ctx: big });
    expect(top.answer).toContain("Currys, £1,249.00");
    expect(top.evidenceIds).toContain("x1");
    expect((await answerQuestion("How much did I spend at Currys?", { model: null, ctx: big })).answer).toContain("£1,249.00");
  });

  it("a negative shop total works", async () => {
    const refunded = withTxns([...ctx.txns, row("x2", "2026-10-20", "Argos", 3000), row("x3", "2026-11-07", "Argos", -3000)]);
    const result = await answerQuestion("How much did I spend at Argos this month?", { model: null, ctx: refunded });
    expect(result.answer).toContain("-£30.00");
    expect(result.evidenceIds).toEqual(["x3"]);
  });

  const lapsed = withTxns(ctx.txns.filter((t) => !(t.merchant === "Spotify" && t.date.startsWith("2026-11"))).map((t) => (t.merchant === "Spotify" ? { ...t, date: "2026-09-01" } : t)));

  it("a subscription with no recent charge isn't an ongoing payment", async () => {
    const result = await answerQuestion("What subscriptions am I paying for?", { model: null, ctx: lapsed });
    expect(result.answer).toContain("You are paying for these subscriptions: Netflix");
    expect(result.answer).toContain("These have stopped being charged: Spotify");
    expect(result.answer.split("These have stopped")[0]).not.toContain("Spotify");
  });

  it("a reply calling it ongoing is rejected, and one that says it stopped passes", () => {
    const set = answerFacts("subscription_list", lapsed);
    expect(checkAnswer("You are paying for Netflix at £12.99 and Spotify at £11.99.", set).ok).toBe(false);
    expect(checkAnswer("You pay Netflix £12.99, and Spotify at £11.99 has had no charge since Tuesday 1 September.", set)).toEqual({ ok: true });
  });

  it.each(["What subscriptions have I cancelled?", "What subscriptions did I have in January?", "How much have I spent on subscriptions since August?", "Compare Tesco and Argos", "Is Tesco cheaper than Argos?", "Should I shop at Tesco or Argos?", "Can I afford Tesco and Argos?", "How much did I spend at Tesco and Argos last year?", "Compare t051 and t052"])(
    "%s gets the safe fallback",
    async (question) => {
      expect(await answerQuestion(question, { model: null })).toMatchObject({ answer: CANT_TELL, evidenceIds: [], experience: { template: "general" } });
    },
  );

  it("subscription questions that aren't lists stay what they are", () => {
    expect(matchIntent("Have I paid for any subscription twice?", names)).toBe("duplicates");
    expect(matchIntent("Have any subscriptions changed?", names)).toBe("price_changes");
    expect(matchIntent("Have my subscriptions got cheaper?", names)).toBe("price_changes");
    expect(matchIntent("What subscriptions do I have?", names)).toBe("subscription_list");
  });

  it("two shops are fine when the facts can answer", async () => {
    expect((await answerQuestion("Do I have Netflix and Spotify subscriptions?", { model: null })).experience?.template).toBe("subscriptions");
  });

  it("a template's I can't tell opens no specialist screen", async () => {
    const result = await answerQuestion("What were my biggest purchases?", { model: null, ctx: withTxns(noNovember) });
    expect(result).toMatchObject({ answer: CANT_TELL, experience: { template: "general" } });
    expect(result.experience?.periodLabel).toBeUndefined();
  });

  it("finding nothing opens no transaction screen", async () => {
    expect(await answerQuestion("Did I get my Tesco refund?", { model: null })).toMatchObject({ evidenceIds: [], experience: { template: "general" } });
  });

  it("T100 isn't a transaction reference", async () => {
    expect(matchIntent("Did I buy a T100 at Argos?", names)).toBe("merchant_transactions");
    expect((await answerQuestion("Did I buy a T100 at Argos?", { model: null })).evidenceIds).toEqual(["t060"]);
    expect(matchIntent("What is a T100?", names)).toBeNull();
  });

  it("a real reference still works, in any case", () => {
    expect(matchIntent("What is T051?", names)).toBe("transaction_lookup");
    expect(matchIntent("Show me reference t999", names)).toBe("transaction_lookup");
  });

  it("a reference at the wrong shop is the fallback, not that record", async () => {
    expect(await answerQuestion("Was t051 at Lidl?", { model: null })).toMatchObject({ answer: CANT_TELL, evidenceIds: [] });
    expect((await answerQuestion("Was t051 at Tesco?", { model: null })).evidenceIds).toEqual(["t051"]);
  });

  it("entities decide the facts", async () => {
    const reading = await interpretQuestion("What was my biggest purchase in October?", names, null, 1000, () => {});
    expect(reading.entities.period).toBe("last_month");
    expect((await answerQuestion("What was my biggest purchase in October?", { model: null })).experience?.periodLabel).toBe("October 2026");
  });
});
