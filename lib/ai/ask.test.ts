import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactSet, Intent } from "../types";
import { answerQuestion, handleAsk, MAX_QUESTION_LENGTH } from "./ask";
import { DEMO_ANSWERS } from "./cache";
import { buildFacts, INTENTS, seedContext } from "./facts";
import { CANT_TELL, checkAnswer } from "./guard";
import { matchIntent, UNSUPPORTED } from "./intent";
import { createModel, type AskModel } from "./model";
import { templateAnswer } from "./templates";

const TESCO = "Did I pay Tesco twice this month?";
/** Not one of the fixed demo questions, so it reaches the model. */
const CHARGED = "Was I charged twice for anything?";
const GOOD_REPLY = "Tesco charged you £38.62 twice.";
const NAMES = { merchants: [...new Set(seedContext().txns.map((t) => t.merchant))], categories: [...new Set(seedContext().txns.map((t) => t.category))] };
const duplicates = buildFacts("duplicates");
const bill = buildFacts("days_until_due");

const fakeModel = (over: Partial<AskModel> = {}): AskModel => ({
  classify: vi.fn(async (): Promise<Intent | null> => null),
  phrase: vi.fn(async (): Promise<string | null> => GOOD_REPLY),
  ...over,
});

const post = (body?: string) => new Request("http://test/api/ask", { method: "POST", body });
const ask = async (body?: string, model: AskModel | null = null) => {
  const response = await handleAsk(post(body), () => model);
  return { status: response.status, body: await response.json() };
};

afterEach(() => vi.restoreAllMocks());

describe("matchIntent", () => {
  it.each<[string, Intent]>([
    [TESCO, "duplicates"],
    ["What did I spend this month?", "spend_this_month"],
    ["Has any subscription gone up?", "price_changes"],
    ["When is my bill due?", "days_until_due"],
    ["How much did I spend last month?", "spend_last_month"],
    ["What were my biggest purchases?", "top_items"],
    ["What is the minimum I can pay?", "minimum_payment"],
    ["Is Spend Pause on?", "spend_pause"],
    ["Turn on Spend Pause", "spend_pause"],
    ["How much do I owe?", "days_until_due"],
    ["What's my balance?", "days_until_due"],
    ["When do I need to pay?", "days_until_due"],
    ["Has Netflix gone up?", "price_changes"],
    ["Did Netflix go up?", "price_changes"],
    ["Was I charged twice at Tesco?", "duplicates"],
  ])("%s", (question, intent) => expect(matchIntent(question, NAMES)).toBe(intent));

  it.each([
    "How much did I spend at Tesco this month?",
    "How much did I spend at Tesco?",
    "How much have I spent on groceries?",
    "How much at Tesco?",
    "What did Tesco cost me?",
    "Tesco total?",
    "How much transport this month?",
    "What did I spend in September?",
    "What did I spend in 2024?",
    "How much did I spend yesterday?",
    "How much did I spend last Tuesday?",
    "How much did I spend in the last 7 days?",
    "How much have I spent in the past week?",
    "What did I spend since Monday?",
    "What's my current balance?",
    "What's my available balance?",
    "Is my bill paid?",
    "Have I paid my bill?",
    "What was my biggest purchase at Amazon?",
    "How much do I owe Tesco?",
    "How much do I spend on subscriptions?",
    "Should I pay my bill early?",
    "Can I afford a holiday?",
    "What's my balance transfer fee?",
  ])("%s is unsupported, without reaching the model", (question) => expect(matchIntent(question, NAMES)).toBe(UNSUPPORTED));

  it("leaves a question it can't place for the model to classify", () => {
    expect(matchIntent("What is my credit score?", NAMES)).toBeNull();
  });
});

describe("checkAnswer", () => {
  it.each([
    "Tesco charged you £38.62 on Thursday 5 November and again on Friday 6 November.",
    "Tesco took £38.62 on 5 Nov. It took the same again on 6th November.",
    "You may have paid Tesco £38.62 twice.",
    CANT_TELL,
    "I can’t tell that from your transactions",
  ])("accepts %s", (reply) => expect(checkAnswer(reply, duplicates)).toEqual({ ok: true }));

  it.each([
    ["one.  Two. Three.", "too many sentences"],
    ["Tesco took £38.62.\nThat is all.", "more than one line"],
    ["", "empty"],
    ["Tesco charged you £38.63 twice.", "amount not in facts"],
    ["Tesco charged you £38 twice.", "amount not in facts"],
    ["Tesco charged you 39 pounds twice.", "number not in facts"],
    ["Tesco charged you thirty eight pounds twice.", "amount not in facts"],
    ["That is 12% of your spending.", "number not in facts"],
    ["Tesco charged you on 7 November.", "number not in facts"],
    ["Tesco charged you in December.", "date not in facts"],
    ["Tesco charged you on Wednesday.", "date not in facts"],
    ["Tesco charged you on Friday 5 November.", "date not in facts"],
    ["Tesco charged you yesterday.", "relative date"],
    ["Streamly charged you £38.62 twice.", "name not in facts"],
    ["Yes, Lidl charged you £38.62 twice.", "name not in facts"],
    ["You should ask Tesco for a refund.", "advice wording"],
    ["I recommend checking this.", "advice wording"],
    ["You may want to speak to Tesco.", "advice wording"],
  ])("rejects %j", (reply, reason) => expect(checkAnswer(reply, duplicates)).toEqual({ ok: false, reason }));

  it("rejects a day and month that are each in the facts but not together", () => {
    // "5 days" and "November" are both facts here; "5 November" is not.
    expect(checkAnswer("Your bill is due on 5 November.", bill)).toEqual({ ok: false, reason: "date not in facts" });
  });

  it("does not read the word may as a month", () => {
    expect(checkAnswer("You may have paid Tesco £38.62 twice.", duplicates).ok).toBe(true);
  });
});

describe("checkAnswer: a reply must state the answer, not just avoid inventing one", () => {
  const set = (intent: Intent) => buildFacts(intent);
  const noFindings = { ...seedContext(), txns: [] };

  it.each<[Intent, string, string]>([
    ["duplicates", "Yes", "no supporting fact"],
    ["duplicates", "Yes.", "no supporting fact"],
    ["duplicates", "Yes, you were charged twice.", "no supporting fact"],
    ["duplicates", "Nothing looks unusual.", "contradicts facts"],
    ["duplicates", "No, you were not charged twice.", "contradicts facts"],
    ["duplicates", "No.", "contradicts facts"],
    ["duplicates", "Tesco did not charge you £38.62 twice.", "contradicts facts"],
    ["duplicates", "Tesco only took £38.62, so you weren't charged twice.", "contradicts facts"],
    ["price_changes", "Yes", "no supporting fact"],
    ["price_changes", "Nothing has changed.", "contradicts facts"],
    ["price_changes", "No subscription has gone up.", "contradicts facts"],
    ["price_changes", "Netflix went down to £12.99.", "contradicts facts"],
    ["price_changes", "Netflix went from £12.99 to £10.99.", "contradicts facts"],
    ["price_changes", "A subscription went up.", "no supporting fact"],
    ["spend_this_month", "Yes", "no supporting fact"],
    ["spend_this_month", "You have spent £145.63 this month.", "no supporting fact"],
    ["spend_this_month", "You spent £402.35 last month.", "contradicts facts"],
    ["spend_this_month", "Last month you spent £402.35.", "contradicts facts"],
    ["spend_this_month", "You have spent £402.35, which is £256.72 less than the same days last month.", "contradicts facts"],
    ["spend_this_month", "You have not spent £402.35.", "contradicts facts"],
    ["spend_last_month", "You spent £853.27 this month.", "contradicts facts"],
    ["spend_last_month", "Nothing looks unusual.", "contradicts facts"],
    ["top_items", "Amazon was your biggest purchase, at £45.99.", "no supporting fact"],
    ["days_until_due", "Your bill is due soon.", "no supporting fact"],
    ["days_until_due", "Your bill is not due on Friday 13 November.", "contradicts facts"],
    ["minimum_payment", "Your minimum payment is small.", "no supporting fact"],
    ["minimum_payment", "There is no minimum payment.", "contradicts facts"],
    ["spend_pause", "Yes", "no supporting fact"],
    ["spend_pause", "Spend Pause is off.", "contradicts facts"],
  ])("%s rejects %j", (intent, reply, reason) => {
    expect(checkAnswer(reply, set(intent))).toEqual({ ok: false, reason });
  });

  it.each<[Intent, string]>([
    ["price_changes", "Netflix went up from £10.99 to £12.99."],
    ["price_changes", "Yes, Netflix now costs £12.99."],
    ["spend_this_month", "You have spent £402.35, which is £256.72 more than the same days last month."],
    ["spend_last_month", "You spent £853.27 in October."],
    ["top_items", "Trainline was your biggest purchase, at £64.30."],
    ["days_until_due", "Your bill is due on Friday."],
    ["days_until_due", "Your bill is due in 5 days."],
    ["days_until_due", "You owe £486.20."],
    ["minimum_payment", "Your minimum payment is £25.00."],
    ["spend_pause", "Spend Pause is on."],
    ["spend_pause", "You have £97.65 left in your budget."],
  ])("%s accepts %j", (intent, reply) => expect(checkAnswer(reply, set(intent))).toEqual({ ok: true }));

  it("a denial is the right answer when the facts found nothing", () => {
    const clean = buildFacts("duplicates", noFindings);
    expect(checkAnswer("No, I can't see any duplicate charges.", clean)).toEqual({ ok: true });
    expect(checkAnswer("Nothing looks unusual.", clean)).toEqual({ ok: true });
    expect(checkAnswer("Yes, you were charged twice.", clean)).toEqual({ ok: false, reason: "contradicts facts" });
    expect(checkAnswer("Yes", buildFacts("price_changes", noFindings))).toEqual({ ok: false, reason: "contradicts facts" });
  });

  it("can't-tell must stand alone to skip the grounding check", () => {
    expect(checkAnswer(CANT_TELL, duplicates)).toEqual({ ok: true });
    expect(checkAnswer("Yes, but I can't tell that from your transactions.", duplicates).ok).toBe(false);
  });
});

describe("templates and cached answers pass the guard", () => {
  const purchaseFree = INTENTS.map((intent) => buildFacts(intent));

  it.each(purchaseFree.map((set): [Intent, FactSet] => [set.intent, set]))("%s template", (_, set) => {
    expect(checkAnswer(templateAnswer(set), set)).toEqual({ ok: true });
  });

  it("covers empty results and an overdue bill", () => {
    const quiet = { ...seedContext(), txns: [] };
    const overdue = { ...seedContext(), today: "2026-11-20" };
    for (const set of [...INTENTS.map((i) => buildFacts(i, quiet)), buildFacts("days_until_due", overdue)]) {
      expect(checkAnswer(templateAnswer(set), set)).toEqual({ ok: true });
    }
  });

  it.each(Object.entries(DEMO_ANSWERS))("cache: %s", (_, cached) => {
    expect(checkAnswer(cached.answer, buildFacts(cached.intent))).toEqual({ ok: true });
  });

  it("the cache holds the four demo questions, each matching its own intent", () => {
    expect(Object.keys(DEMO_ANSWERS)).toHaveLength(4);
    for (const [question, cached] of Object.entries(DEMO_ANSWERS)) expect(matchIntent(question)).toBe(cached.intent);
  });
});

describe("answerQuestion", () => {
  it("uses a checked model reply, with evidence from the facts", async () => {
    const result = await answerQuestion(CHARGED, { model: fakeModel() });
    expect(result).toEqual({ answer: GOOD_REPLY, evidenceIds: duplicates.evidenceIds, source: "model" });
  });

  it("gives the model the facts and never takes evidence from it", async () => {
    const phrase = vi.fn(async () => "Tesco charged you £38.62 twice. Evidence: tx-999.");
    const result = await answerQuestion(CHARGED, { model: fakeModel({ phrase }) });
    expect(phrase.mock.calls[0]).toContainEqual(duplicates);
    expect(result.evidenceIds).toEqual(duplicates.evidenceIds);
  });

  it.each(["You owe £1,000,000.", "No, you were not charged twice.", "Yes", "Nothing looks unusual."])(
    "replaces the bad reply %j with the template",
    async (reply) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await answerQuestion(CHARGED, { model: fakeModel({ phrase: async () => reply }) });
      expect(result).toEqual({ answer: templateAnswer(duplicates), evidenceIds: duplicates.evidenceIds, source: "template" });
    },
  );

  it("never gives a narrow question the monthly total, and never asks the model", async () => {
    const model = fakeModel({ classify: vi.fn(async (): Promise<Intent | null> => "spend_this_month") });
    const result = await answerQuestion("How much did I spend at Tesco this month?", { model });
    expect(result).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "template" });
    expect(model.classify).not.toHaveBeenCalled();
    expect(model.phrase).not.toHaveBeenCalled();
  });

  it("the four demo questions skip the model and always read the same", async () => {
    for (const [question, cached] of Object.entries(DEMO_ANSWERS)) {
      const model = fakeModel();
      const result = await answerQuestion(question, { model });
      expect(result).toEqual({ answer: cached.answer, evidenceIds: buildFacts(cached.intent).evidenceIds, source: "cache" });
      expect(model.phrase).not.toHaveBeenCalled();
    }
  });

  it.each(["How much do I owe?", "When do I need to pay?"])("answers %s from the bill facts", async (question) => {
    const result = await answerQuestion(question, { model: null });
    expect(result.source).toBe("template");
    expect(result.answer).toBe("Your bill of £486.20 is due on Friday 13 November. That is in 5 days.");
  });

  it("says which balance it means, because the current balance is not in the facts", async () => {
    const ctx = seedContext();
    expect(ctx.account.currentBalance).not.toBe(ctx.account.statementBalance);
    const result = await answerQuestion("What's my balance?", { model: null });
    expect(result.answer).toBe("Your statement balance is £486.20, due on Friday 13 November.");
    expect(checkAnswer(result.answer, bill)).toEqual({ ok: true });
  });

  it.each(["Have I been charged twice by Lidl?", "Was I charged twice at Lidl?", "Did Spotify go up?"])("does not answer %s with a finding about another shop", async (question) => {
    expect(await answerQuestion(question, { model: fakeModel() })).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "template" });
  });

  it("still answers a duplicates question that names the right shop", async () => {
    const result = await answerQuestion("Was I charged twice at Tesco?", { model: null });
    expect(result.evidenceIds).toEqual(duplicates.evidenceIds);
  });

  it("still answers about a shop the facts do cover", async () => {
    const result = await answerQuestion("Has Netflix gone up?", { model: null });
    expect(result.answer).toContain("Netflix went up");
    expect(result.evidenceIds).toEqual(buildFacts("price_changes").evidenceIds);
  });

  it("uses the template when the model refuses or is cut off", async () => {
    const result = await answerQuestion(CHARGED, { model: fakeModel({ phrase: async () => null }) });
    expect(result.source).toBe("template");
  });

  it("shows no evidence when the model says the facts don't cover it", async () => {
    const result = await answerQuestion(CHARGED, { model: fakeModel({ phrase: async () => "I can’t tell that from your transactions." }) });
    expect(result).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "model" });
  });

  it("uses the template on an error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => Promise.reject(new Error("boom")) });
    expect((await answerQuestion(CHARGED, { model })).source).toBe("template");
  });

  it("drops a cached answer the facts no longer support", async () => {
    const ctx = { ...seedContext(), account: { ...seedContext().account, statementBalance: 1000 } };
    const result = await answerQuestion("When is my bill due?", { model: null, ctx });
    expect(result.source).toBe("template");
    expect(result.answer).toContain("£10.00");
  });

  it("with no key: cache for demo questions, template otherwise, and no call out", async () => {
    expect((await answerQuestion(TESCO, { model: null })).source).toBe("cache");
    expect((await answerQuestion("How much is my bill?", { model: null })).source).toBe("template");
    expect(await answerQuestion("What is my credit score?", { model: null })).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "template" });
  });

  it("no question gives the spending summary", async () => {
    const result = await answerQuestion(undefined, { model: null });
    expect(result.answer).toContain("£402.35");
    expect(result.evidenceIds).toEqual(buildFacts("spend_this_month").evidenceIds);
  });

  it("classifies with the model only when keywords don't match", async () => {
    const classify = vi.fn(async (): Promise<Intent | null> => "days_until_due");
    const phrase = vi.fn(async () => "Your bill is £486.20.");
    await answerQuestion(TESCO, { model: fakeModel({ classify }) });
    expect(classify).not.toHaveBeenCalled();
    const result = await answerQuestion("Am I square with you lot?", { model: fakeModel({ classify, phrase }) });
    expect(classify).toHaveBeenCalledOnce();
    expect(result.source).toBe("model");
  });

  it("treats a failed classification as unanswerable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ classify: async () => Promise.reject(new Error("boom")) });
    expect((await answerQuestion("Am I square with you lot?", { model })).answer).toBe(CANT_TELL);
  });

  it("shares one time limit across both model calls", async () => {
    const classify = vi.fn(async (): Promise<Intent | null> => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "days_until_due";
    });
    const phrase = vi.fn(async () => "Your bill is £486.20.");
    const result = await answerQuestion("Am I square with you lot?", { model: fakeModel({ classify, phrase }), timeoutMs: 100 });
    expect(phrase).not.toHaveBeenCalled();
    expect(result.source).toBe("template");
  });
});

describe("handleAsk", () => {
  it("answers a question", async () => {
    const { status, body } = await ask(JSON.stringify({ question: TESCO }));
    expect(status).toBe(200);
    expect(body.source).toBe("cache");
  });

  it.each([[undefined], [""], ["{}"], ['{"question":null}']])("body %j means the default summary, not an error", async (body) => {
    const result = await ask(body as string | undefined);
    expect(result.status).toBe(200);
    expect(result.body.answer).toContain("£402.35");
  });

  it.each([
    ['{"question":""}', "Please type a question first."],
    ['{"question":"   "}', "Please type a question first."],
    ['{"question":42}', "Sorry, I couldn't read that. Please try asking again."],
    ["not json", "Sorry, I couldn't read that. Please try asking again."],
    ["[1]", "Sorry, I couldn't read that. Please try asking again."],
  ])("%s gets a friendly 400", async (body, error) => {
    expect(await ask(body)).toEqual({ status: 400, body: { error } });
  });

  it("caps the question at the limit", async () => {
    const atLimit = await ask(JSON.stringify({ question: "a".repeat(MAX_QUESTION_LENGTH) }));
    const overLimit = await ask(JSON.stringify({ question: "a".repeat(MAX_QUESTION_LENGTH + 1) }));
    expect(atLimit.status).toBe(200);
    expect(overLimit).toEqual({ status: 400, body: { error: "Please keep your question to 300 characters or fewer." } });
  });

  it("rejects an oversized body without parsing it", async () => {
    expect((await ask("x".repeat(5000))).status).toBe(400);
  });

  it("never returns a raw error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleAsk(post("{}"), () => {
      throw new Error("secret detail sk-ant-123");
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
});

describe("the API key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no key means no model", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createModel()).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");
    expect(createModel()).toBeNull();
  });

  it("never reaches a log line or a response, even when the error text carries it", async () => {
    const key = "sk-ant-test-do-not-print";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => Promise.reject(new Error(`401 for key ${key}`)) });
    const response = await handleAsk(post(JSON.stringify({ question: CHARGED })), () => model);
    expect(await response.text()).not.toContain(key);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
  });
});

describe("the model request", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const replyWith = (content: unknown[], stopReason: string) => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ id: "m", type: "message", role: "assistant", model: "m", content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    return fetchMock;
  };
  const sentBody = (fetchMock: ReturnType<typeof replyWith>) => JSON.parse(String(fetchMock.mock.calls[0][1].body));
  const thinking = { type: "thinking", thinking: "", signature: "s" };

  it("leaves thinking on at low effort, with room for it in max_tokens", async () => {
    const fetchMock = replyWith([{ type: "text", text: "duplicates" }], "end_turn");
    await createModel()!.classify("hello", 4000);
    const body = sentBody(fetchMock);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("reads the text after a leading thinking block", async () => {
    replyWith([thinking, { type: "text", text: "duplicates" }], "end_turn");
    expect(await createModel()!.classify("hello", 4000)).toBe("duplicates");
  });

  it("treats a reply that ran out of tokens while thinking as no answer", async () => {
    replyWith([thinking], "max_tokens");
    expect(await createModel()!.classify("hello", 4000)).toBeNull();
    expect(await createModel()!.phrase("hello", duplicates, 4000)).toBeNull();
  });

  it("ignores a label outside the fixed list", async () => {
    replyWith([{ type: "text", text: "something_else" }], "end_turn");
    expect(await createModel()!.classify("hello", 4000)).toBeNull();
  });
});

describe("Stage 2 evidence (owned by the facts layer)", () => {
  it.todo("spend_this_month evidence should not include October transactions: needs a facts.ts change, agreed with its owner");
});
