import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intent, Transaction } from "../types";
import { answerQuestion, handleAsk, MAX_QUESTION_LENGTH } from "./ask";
import { answerFacts, type AnswerFactSet } from "./answer-facts";
import { DEMO_ANSWERS } from "./cache";
import { buildFacts as stage2Facts, INTENTS, seedContext, type FactContext } from "./facts";
import { CANT_TELL, checkAnswer } from "./guard";
import { matchIntent, UNSUPPORTED, type AnswerIntent } from "./intent";
import { createModel, describeError, type AskModel } from "./model";
import { templateAnswer } from "./templates";

const buildFacts = (intent: AnswerIntent, ctx: FactContext = seedContext(), question = "", merchant?: string) => answerFacts(intent, ctx, question, merchant);

const TESCO = "Did I pay Tesco twice this month?";
/** Not one of the fixed demo questions, so it reaches the model. */
const CHARGED = "Was I charged twice for anything?";
const GOOD_REPLY = "Tesco charged you £38.62 twice.";
const OWE =
  "Your current balance is £1,069.89, which is everything on the card right now, and not all of it is due yet. Your latest bill, the statement balance, is £486.20, and the minimum payment on it is £25.00, by Friday 13 November.";
const NEED_TO_PAY = "Your full statement balance, the amount on your latest bill, is £486.20. The minimum payment is £25.00, and both are due by Friday 13 November.";
const BILL = "Your bill, the statement balance, is £486.20, due on Friday 13 November.";
const NAMES = { merchants: [...new Set(seedContext().txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))], categories: [...new Set(seedContext().txns.map((t) => t.category))] };
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
    "How much have I spent on groceries?",
    "How much transport this month?",
    "How much did I spend at Tesco yesterday?",
    "What did I spend at Amazon in 2024?",
    "What did I spend at Tesco Mobile?",
    "Show me my Amazon Prime transactions.",
    "Did I get my Currys refund?",
    "Did I get a refund last week?",
    "Compare my Amazon and Tesco refunds",
    "What did I spend in September?",
    "What did I spend in 2024?",
    "How much did I spend yesterday?",
    "How much did I spend last Tuesday?",
    "How much did I spend in the last 7 days?",
    "How much have I spent in the past week?",
    "What did I spend since Monday?",
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
    ["Tesco charged you $38.62 twice.", "amount not in facts"],
    ["Tesco charged you £38.62 on 5 November, and $38.62 on 6 November.", "amount not in facts"],
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
    ["days_until_due", "Your bill is £486.20."],
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

  it.each(purchaseFree.map((set): [AnswerIntent, AnswerFactSet] => [set.intent, set]))("%s template", (_, set) => {
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
    const result = await answerQuestion("How much did I spend on groceries?", { model });
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

  it.each<[string, string]>([
    ["How much do I need to pay?", NEED_TO_PAY],
    ["How much is my bill?", BILL],
    ["What's my statement balance?", BILL],
    ["What's my current balance?", "Your current balance is £1,069.89."],
    ["How much do I owe?", OWE],
    ["How much do I owe you?", OWE],
    ["What's my balance?", "Your current balance is £1,069.89. Your statement balance is £486.20, due on Friday 13 November."],
    ["When do I need to pay?", "Your bill of £486.20 is due on Friday 13 November. That is in 5 days."],
  ])("%s", async (question, answer) => {
    const result = await answerQuestion(question, { model: null });
    expect(result).toEqual({ answer, evidenceIds: [], source: "template" });
    expect(checkAnswer(answer, bill, question)).toEqual({ ok: true });
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
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(createModel()).toBeNull();
    vi.stubEnv("GEMINI_API_KEY", "   ");
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

describe("the Gemini request", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const replyWith = (text: string | undefined, finishReason = "STOP", status = 200) => {
    const body = status === 200 ? { candidates: [{ finishReason, content: { role: "model", parts: text === undefined ? [] : [{ text }] } }] } : { error: { code: status, message: "failed", status: "FAILED" } };
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "");
    return fetchMock;
  };
  const answer = (text: string) => JSON.stringify({ answer: text });
  const phrase = () => createModel()!.phrase("hello", duplicates, 4000);
  const classify = () => createModel()!.classify("hello", 4000);

  it("sends only the facts and question, asks for structured output, and makes one attempt", async () => {
    const fetchMock = replyWith(answer(GOOD_REPLY));
    expect(await phrase()).toBe(GOOD_REPLY);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(url).toContain("gemini-3.5-flash-lite:generateContent");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    const sent = JSON.stringify(body.contents);
    expect(sent).toContain("£38.62");
    expect(sent).not.toContain("t051");
    expect(sent).not.toContain("£899");
  });

  it("uses GEMINI_MODEL when set", async () => {
    const fetchMock = replyWith(answer(GOOD_REPLY));
    vi.stubEnv("GEMINI_MODEL", "gemini-test");
    await phrase();
    expect(fetchMock.mock.calls[0][0]).toContain("gemini-test:generateContent");
  });

  it("reads the classification from the structured reply", async () => {
    replyWith(JSON.stringify({ category: "duplicates" }));
    expect(await classify()).toBe("duplicates");
  });

  it.each(["something_else", "none"])("treats the category %s as no intent", async (category) => {
    replyWith(JSON.stringify({ category }));
    expect(await classify()).toBeNull();
  });

  it.each<[string, string | undefined, string]>([
    ["cut off", answer(GOOD_REPLY), "MAX_TOKENS"],
    ["blocked for safety", answer(GOOD_REPLY), "SAFETY"],
    ["not JSON", "this is not json", "STOP"],
    ["truncated JSON", '{"answer": "Tesco', "STOP"],
    ["the wrong shape", JSON.stringify({ reply: GOOD_REPLY }), "STOP"],
    ["a non-string answer", JSON.stringify({ answer: 38.62 }), "STOP"],
    ["JSON null", "null", "STOP"],
    ["empty", undefined, "STOP"],
  ])("a reply that is %s counts as no answer", async (_, text, finishReason) => {
    replyWith(text, finishReason);
    expect(await phrase()).toBeNull();
  });

  it.each([[400], [403], [429], [500], [503]])("HTTP %i raises an error safe to log", async (status) => {
    replyWith(undefined, "STOP", status);
    await expect(phrase()).rejects.toSatisfy((error: unknown) => describeError(error) === `API status ${status}`);
  });

  it("a timeout raises an error safe to log", () => {
    expect(describeError(new DOMException("aborted", "TimeoutError"))).toBe("timeout");
    expect(describeError(new DOMException("aborted", "AbortError"))).toBe("timeout");
  });

  it("evidence the model volunteers is ignored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    replyWith(JSON.stringify({ answer: GOOD_REPLY, evidenceIds: ["t999"] }));
    const result = await answerQuestion(CHARGED, { model: createModel() });
    expect(result).toEqual({ answer: GOOD_REPLY, evidenceIds: ["t051", "t052"], source: "model" });
  });
});

describe("the two balances", () => {
  it.each<[string, string, string]>([
    ["Your current balance is £486.20.", "What's my current balance?", "contradicts facts"],
    ["£486.20 is your current balance.", "What's my balance?", "contradicts facts"],
    ["Your statement balance is £1,069.89.", "How much do I need to pay?", "contradicts facts"],
    ["Your bill is £1,069.89.", "When is it due?", "contradicts facts"],
    ["You owe £486.20.", "How much do I owe?", "contradicts facts"],
    ["Your minimum payment is £486.20.", "When is it due?", "contradicts facts"],
    ["Your bill is due on Friday 13 November.", "What's my current balance?", "no supporting fact"],
    ["It is due in 5 days.", "How much do I owe?", "no supporting fact"],
    ["It is due in 5 days.", "How much do I need to pay?", "no supporting fact"],
    ["You owe £1,069.89 right now.", "How much do I owe?", "no supporting fact"],
    ["Your current balance is £1,069.89 and your bill is £486.20.", "How much do I owe?", "no supporting fact"],
    ["Your statement balance is £486.20.", "How much do I need to pay?", "no supporting fact"],
    ["Your minimum payment is £25.00.", "How much do I need to pay?", "no supporting fact"],
    ["Your current balance of £1,069.89 is due now, with a bill of £486.20 and a minimum payment of £25.00.", "How much do I owe?", "contradicts facts"],
    ["Your minimum payment is £25.00.", "How much is my bill?", "no supporting fact"],
  ])("rejects %j for %j", (reply, question, reason) => {
    expect(checkAnswer(reply, bill, question)).toEqual({ ok: false, reason });
  });

  it.each<[string, string]>([
    ["Your current balance is £1,069.89.", "What's my current balance?"],
    ["Your current balance is £1,069.89, your bill is £486.20 and your minimum payment is £25.00.", "How much do I owe?"],
    ["Your current balance is £1,069.89, but not all of it is due yet. Your bill is £486.20 and your minimum payment is £25.00.", "How much do I owe?"],
    ["Your statement balance is £486.20 and your minimum payment is £25.00.", "How much do I need to pay?"],
    ["Your bill is £486.20.", "How much is my bill?"],
    ["£1,069.89 is your current balance.", "What's my balance?"],
  ])("accepts %j for %j", (reply, question) => expect(checkAnswer(reply, bill, question)).toEqual({ ok: true }));

  it("how much is owed never depends on the model's wording", async () => {
    const model = fakeModel({ phrase: vi.fn(async () => "You owe £1,069.89 right now.") });
    const result = await answerQuestion("How much do I owe?", { model });
    expect(result).toEqual({ answer: OWE, evidenceIds: [], source: "template" });
    expect(model.phrase).not.toHaveBeenCalled();
    expect(result.answer).toContain("not all of it is due yet");
  });

  it("a model reply naming the wrong balance is replaced", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => "Your current balance is £486.20." });
    const result = await answerQuestion("What's my current balance?", { model });
    expect(result).toEqual({ answer: "Your current balance is £1,069.89.", evidenceIds: [], source: "template" });
  });
});

describe("evidence always matches the facts behind the answer", () => {
  const ctx = seedContext();
  const byId = new Map(ctx.txns.map((t) => [t.id, t]));
  const months = (ids: string[]) => [...new Set(ids.map((id) => byId.get(id)!.date.slice(0, 7)))];

  it("November spending shows only November transactions, and October's figure stays available", () => {
    const set = answerFacts("spend_this_month", ctx);
    expect(months(stage2Facts("spend_this_month", ctx).evidenceIds)).toContain("2026-10");
    expect(months(set.evidenceIds)).toEqual(["2026-11"]);
    expect(set.evidenceIds.length).toBe(20);
    expect(set.facts.find((f) => f.key === "same_days_last_month_total")?.value).toBe("£145.63");
    expect(set.evidence.map((row) => row.id)).toEqual(set.evidenceIds);
  });

  it("October spending shows only October transactions", () => {
    expect(months(answerFacts("spend_last_month", ctx).evidenceIds)).toEqual(["2026-10"]);
  });

  it.each(INTENTS)("%s: the response carries exactly the evidence of its facts", async (intent) => {
    const set = answerFacts(intent, ctx);
    expect(set.evidenceIds).toEqual([...new Set(set.facts.flatMap((f) => f.evidenceIds))]);
    expect(set.evidence.map((row) => row.id)).toEqual(set.evidenceIds);
    for (const id of set.evidenceIds) expect(byId.has(id)).toBe(true);
  });

  it.each<[string, Intent, string]>([
    ["What did I spend this month?", "spend_this_month", "£402.35"],
    ["What did I spend last month?", "spend_last_month", "£853.27"],
    ["What were my biggest purchases?", "top_items", "£64.30"],
    ["Was I charged twice?", "duplicates", "£38.62"],
    ["Has any subscription gone up?", "price_changes", "£12.99"],
    ["When is my bill due?", "days_until_due", "Friday 13 November"],
    ["What is my minimum payment?", "minimum_payment", "£25.00"],
    ["Is Spend Pause on?", "spend_pause", "£100.00"],
  ])("%s answers the %s intent with no key", async (question, intent, expected) => {
    const result = await answerQuestion(question, { model: null });
    expect(result.answer).toContain(expected);
    expect(result.evidenceIds).toEqual(answerFacts(intent, ctx).evidenceIds);
  });
});

describe("natural variations of the demo questions", () => {
  it.each<[Intent, string[]]>([
    ["duplicates", ["Did I pay Tesco twice?", "Did Tesco charge me twice?", "Have I paid Tesco twice?", "Was I double charged?", "Did I get charged double?", "Any duplicate payments?", "Is there a duplicate charge?", "did i pay tesco twice this month"]],
    ["spend_this_month", ["How much have I spent this month?", "What's my spending this month?", "How much did I spend in November?", "What have I spent so far?", "How much have I spent so far?"]],
    ["price_changes", ["Have any of my subscriptions gone up?", "Did any subscription increase?", "Has anything gone up in price?", "Are my subscriptions more expensive?", "Has Netflix got more expensive?", "Any price rises?", "Any price increases?"]],
    ["days_until_due", ["When's my bill due?", "When do I have to pay by?", "When is my payment due?", "What's my due date?", "How long until my bill is due?", "When's the deadline?", "When is my next bill?"]],
  ])("%s", (intent, questions) => {
    for (const question of questions) expect([question, matchIntent(question, NAMES)]).toEqual([question, intent]);
  });

  it("the exact demo wording survives case, punctuation and spacing", async () => {
    for (const question of ["did i pay tesco twice this month", "  DID I PAY TESCO TWICE THIS MONTH??  "]) {
      expect((await answerQuestion(question, { model: fakeModel() })).source).toBe("cache");
    }
  });
});

describe("a merchant question can't return another figure", () => {
  it.each<[string, string, string[]]>([
    ["How much did I spend at Tesco this month?", "You have 3 Tesco transactions this month, totalling £98.71. The latest is £38.62 on Friday 6 November.", ["t052", "t051", "t050"]],
    ["How much have I spent at Amazon?", "You have 7 Amazon transactions, totalling £99.48, after refunds, counting pending items. The latest is £19.99 on Sunday 8 November (pending refund).", ["t062", "t054", "t061", "t036", "t028", "t018", "t009"]],
    ["How much did I spend at Amazon last month?", "You have 4 Amazon transactions last month, totalling £53.49, after refunds. The latest is £14.99 on Thursday 29 October (refund).", ["t036", "t028", "t018", "t009"]],
  ])("%s", async (question, answer, evidenceIds) => {
    const model = fakeModel({ classify: vi.fn(async (): Promise<Intent | null> => "spend_this_month"), phrase: async () => null });
    const result = await answerQuestion(question, { model });
    expect(result).toEqual({ answer, evidenceIds, source: "template" });
    expect(result.answer).not.toContain("£402.35");
    expect(model.classify).not.toHaveBeenCalled();
  });

  it.each(["What did Tesco cost me?", "Tesco total?", "How much at Tesco?", "Tesco spending", "How much was Trainline?"])("%s is about that shop only", async (question) => {
    const result = await answerQuestion(question, { model: null });
    const byId = new Map(seedContext().txns.map((t) => [t.id, t]));
    const shop = question.includes("Trainline") ? "Trainline" : "Tesco";
    expect(result.evidenceIds.length).toBeGreaterThan(0);
    expect(result.evidenceIds.every((id) => byId.get(id)?.merchant === shop)).toBe(true);
    expect(result.answer).not.toContain("£402.35");
  });
});

describe("refunds", () => {
  const seed = seedContext();
  const PENDING = "Your £19.99 Amazon refund for your purchase on Tuesday 3 November is pending, so it has not arrived yet.";
  const COMPLETED = "Your £14.99 Amazon refund for your purchase on Wednesday 21 October arrived on Thursday 29 October.";
  const refundsSet = (ctx = seed, merchant: string | undefined = "Amazon") => answerFacts("merchant_refunds", ctx, "", merchant);
  const withTxns = (extra: Transaction[], ctx = seed): FactContext => ({ ...ctx, txns: [...ctx.txns, ...extra] });
  const onlyPending = { ...seed, txns: seed.txns.filter((t) => t.id !== "t036") };
  const onlyCompleted = { ...seed, txns: seed.txns.filter((t) => t.id !== "t062") };

  it.each(["Did I get my Amazon refund?", "Has my Amazon refund arrived?", "Where is my Amazon refund?", "How much was my Amazon refund?", "Have I been refunded by Amazon?", "did i get my amazon refund"])(
    "%s separates the pending refund from the completed one",
    async (question) => {
      expect(matchIntent(question, NAMES)).toBe("merchant_refunds");
      const result = await answerQuestion(question, { model: null });
      expect(result).toEqual({ answer: `${PENDING} ${COMPLETED}`, evidenceIds: ["t062", "t061", "t036", "t028"], source: "template" });
    },
  );

  it("links each refund to the purchase it reverses", () => {
    const set = refundsSet();
    expect(set.facts.find((f) => f.key === "refund_pending_1")?.evidenceIds).toEqual(["t062", "t061"]);
    expect(set.facts.find((f) => f.key === "refund_completed_1")?.evidenceIds).toEqual(["t036", "t028"]);
    expect(set.evidence.map((row) => [row.id, row.status])).toEqual([["t062", "pending"], ["t061", "posted"], ["t036", "posted"], ["t028", "posted"]]);
  });

  it("only a pending refund", async () => {
    const result = await answerQuestion("Did I get my Amazon refund?", { model: null, ctx: onlyPending });
    expect(result).toEqual({ answer: PENDING, evidenceIds: ["t062", "t061"], source: "template" });
  });

  it("only a completed refund", async () => {
    const result = await answerQuestion("Did I get my Amazon refund?", { model: null, ctx: onlyCompleted });
    expect(result).toEqual({ answer: COMPLETED, evidenceIds: ["t036", "t028"], source: "template" });
  });

  it("no refund from a known shop says so, with no evidence", async () => {
    const result = await answerQuestion("Did I get my Tesco refund?", { model: null });
    expect(result).toEqual({ answer: "I can't see any refund from Tesco in your transactions.", evidenceIds: [], source: "template" });
  });

  it("a refund from an unknown shop is the fallback, not Amazon's", async () => {
    expect(await answerQuestion("Did I get my Currys refund?", { model: fakeModel() })).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "template" });
  });

  it("a refund with no matching purchase still has its own evidence", () => {
    const ctx = withTxns([{ id: "x1", date: "2026-11-07", merchant: "Greggs", amount: -123, category: "Eating out", status: "posted" }]);
    const set = refundsSet(ctx, "Greggs");
    expect(set.evidenceIds).toEqual(["x1"]);
    expect(checkAnswer(templateAnswer(set), set)).toEqual({ ok: true });
  });

  it("two pending refunds from one shop are both reported", async () => {
    const ctx = withTxns([{ id: "x2", date: "2026-11-07", merchant: "Amazon", amount: -4599, category: "Shopping", status: "pending" }]);
    const result = await answerQuestion("Did I get my Amazon refund?", { model: null, ctx });
    expect(result.answer).toContain("£19.99");
    expect(result.answer).toContain("£45.99");
    expect(result.answer).toContain("£14.99");
    expect(result.evidenceIds).toEqual(["t062", "t061", "x2", "t054", "t036", "t028"]);
  });

  it("a general refund question covers every shop and never counts card payments", async () => {
    const result = await answerQuestion("Have I had any refunds?", { model: null });
    expect(result.evidenceIds).toEqual(["t062", "t061", "t036", "t028"]);
    expect(result.evidenceIds).not.toContain("t022");
  });

  it.each<[string, string]>([
    ["Your Amazon refund of £19.99 has arrived. Your £14.99 refund has arrived.", "contradicts facts"],
    ["Yes, you received £19.99 from Amazon. You also received £14.99.", "contradicts facts"],
    ["Your £19.99 refund is complete and your £14.99 refund is complete.", "contradicts facts"],
    ["Your £19.99 refund is pending. Your £14.99 refund is pending.", "contradicts facts"],
    ["Your £19.99 and £14.99 refunds are pending.", "contradicts facts"],
    ["Your £19.99 refund is pending and has arrived. Your £14.99 refund has arrived.", "contradicts facts"],
    ["Your £19.99 refund is sorted. Your £14.99 refund has arrived.", "contradicts facts"],
    ["Your Amazon refund of £19.99 is pending.", "no supporting fact"],
    ["Your Amazon refund of £14.99 has arrived.", "no supporting fact"],
    ["Yes", "no supporting fact"],
  ])("rejects %j", (reply, reason) => expect(checkAnswer(reply, refundsSet())).toEqual({ ok: false, reason }));

  it.each(["Your £19.99 Amazon refund is pending. Your £14.99 refund has arrived.", "Your Amazon refund of £19.99 has not arrived yet. Your £14.99 refund arrived earlier."])("accepts %j", (reply) => {
    expect(checkAnswer(reply, refundsSet())).toEqual({ ok: true });
  });

  it("a model reply saying pending money arrived is replaced", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await answerQuestion("Has my Amazon refund arrived?", { model: fakeModel({ phrase: async () => "Yes, your £19.99 refund has arrived. So has your £14.99 refund." }) });
    expect(result).toEqual({ answer: `${PENDING} ${COMPLETED}`, evidenceIds: ["t062", "t061", "t036", "t028"], source: "template" });
  });

  it("a denial is required when there is no refund", () => {
    const none = refundsSet(seed, "Tesco");
    expect(checkAnswer("You have no refund from Tesco.", none).ok).toBe(true);
    expect(checkAnswer("Yes, it has arrived.", none)).toEqual({ ok: false, reason: "contradicts facts" });
  });
});

describe("merchant lookups", () => {
  const seed = seedContext();
  const ARGOS = "You spent £249.00 at Argos on Saturday 10 October.";

  it.each(["What did I spend on Argos?", "How much was my Argos purchase?", "Show me my Argos transactions.", "When did I buy something from Argos?", "argos total", "What did I spend at ARGOS?", "How much did I spend at Argos in October?"])(
    "%s finds the one Argos purchase",
    async (question) => {
      expect(matchIntent(question, NAMES)).toBe("merchant_transactions");
      expect(await answerQuestion(question, { model: null })).toEqual({ answer: ARGOS, evidenceIds: ["t060"], source: "template" });
    },
  );

  it("a month with nothing says so, with no evidence", async () => {
    const result = await answerQuestion("How much did I spend at Argos this month?", { model: null });
    expect(result).toEqual({ answer: "I can't see any Argos transactions this month.", evidenceIds: [], source: "template" });
  });

  it("several purchases at one shop are all evidence", async () => {
    const second: Transaction = { id: "x3", date: "2026-11-02", merchant: "Argos", amount: 1000, category: "Shopping", status: "posted" };
    const ctx = { ...seed, txns: [...seed.txns, second] };
    const result = await answerQuestion("Show me my Argos transactions.", { model: null, ctx });
    expect(result.evidenceIds).toEqual(["x3", "t060"]);
    expect(result.answer).toBe("You have 2 Argos transactions, totalling £259.00. The latest is £10.00 on Monday 2 November.");
  });

  it("every transaction is evidence even when only the latest are listed", () => {
    const set = answerFacts("merchant_transactions", seed, "", "TfL");
    expect(set.evidenceIds.length).toBe(15);
    expect(set.facts.filter((f) => f.key.startsWith("transaction_")).length).toBe(5);
  });

  it.each<[string, string]>([
    ["What did I spend at Sainsburys?", "Sainsbury's"],
    ["What did I spend at sainsbury's?", "Sainsbury's"],
    ["What did I spend at Sainsbury?", "Sainsbury's"],
    ["What did I spend at tfl?", "TfL"],
    ["What did I spend at Tesco's?", "Tesco"],
    ["What did I spend at Greggs?", "Greggs"],
  ])("%s means %s", async (question, shop) => {
    const result = await answerQuestion(question, { model: null });
    const byId = new Map(seed.txns.map((t) => [t.id, t]));
    expect(result.evidenceIds.length).toBeGreaterThan(0);
    expect(result.evidenceIds.every((id) => byId.get(id)?.merchant === shop)).toBe(true);
  });

  it.each(["What did I spend at Argosy?", "What did I spend at Tescotastic?", "What did I spend at Tesco Mobile?", "Show me my Amazon Prime transactions.", "What did I spend at Currys?", "Show me Payment received"])(
    "%s never matches a different shop",
    async (question) => {
      const model = fakeModel({ classify: async () => null });
      expect(await answerQuestion(question, { model })).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "template" });
    },
  );

  it("a real shop whose name contains another is told apart", async () => {
    const mobile: Transaction = { id: "x4", date: "2026-11-02", merchant: "Tesco Mobile", amount: 1500, category: "Shopping", status: "posted" };
    const ctx = { ...seed, txns: [...seed.txns, mobile] };
    expect((await answerQuestion("What did I spend at Tesco Mobile?", { model: null, ctx })).evidenceIds).toEqual(["x4"]);
    expect((await answerQuestion("What did I spend at Tesco?", { model: null, ctx })).evidenceIds).not.toContain("x4");
  });

  it.each<[string, string]>([
    ["You spent £19.99 at Argos.", "amount not in facts"],
    ["You spent £249.00 at Argos on Sunday 11 October.", "number not in facts"],
    ["You spent £249.00 at Currys.", "name not in facts"],
    ["You spent £249.00.", "no supporting fact"],
    ["You spent nothing at Argos.", "contradicts facts"],
    ["Evidence is t999, at Argos, £249.00.", "number not in facts"],
  ])("rejects %j", (reply, reason) => {
    expect(checkAnswer(reply, answerFacts("merchant_transactions", seed, "", "Argos"))).toEqual({ ok: false, reason });
  });

  it("a reply about one row of a multi-row shop isn't enough", () => {
    expect(checkAnswer("You spent £14.99 at Amazon.", answerFacts("merchant_transactions", seed, "", "Amazon")).ok).toBe(false);
  });

  it("a partial list with no total is rejected, and refunds can't pass as purchases", () => {
    const set = answerFacts("merchant_transactions", seed, "", "Amazon");
    const partial = "Your Amazon transactions are £45.99 on Friday 6 November and £19.99 on Tuesday 3 November.";
    expect(checkAnswer(partial, set)).toEqual({ ok: false, reason: "contradicts facts" });
    expect(checkAnswer("Your Amazon purchases were £45.99 on Friday 6 November.", set)).toEqual({ ok: false, reason: "no supporting fact" });
    expect(checkAnswer("You have 7 Amazon transactions, totalling £99.48, after refunds.", set)).toEqual({ ok: true });
    expect(checkAnswer("Your latest Amazon refund is £19.99, and your total is £99.48.", set)).toEqual({ ok: true });
  });

  it("a date is enough only when the question is when", () => {
    const set = answerFacts("merchant_transactions", seed, "", "Argos");
    expect(checkAnswer("You bought from Argos on Saturday 10 October.", set, "When did I buy something from Argos?")).toEqual({ ok: true });
    expect(checkAnswer("You bought from Argos on Saturday 10 October.", set, "What did I spend on Argos?")).toEqual({ ok: false, reason: "no supporting fact" });
  });
});

describe("reliability on the new questions", () => {
  const down = async () => Promise.reject(new Error("boom"));

  it.each([
    ["Did I get my Amazon refund?", "£19.99", ["t062", "t061", "t036", "t028"]],
    ["What did I spend on Argos?", "£249.00", ["t060"]],
    ["How much do I owe?", "£1,069.89", []],
    ["How much do I need to pay?", "£25.00", []],
  ])("%s keeps its figure and evidence when Gemini is down", async (question, figure, evidenceIds) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await answerQuestion(question, { model: fakeModel({ phrase: down }) });
    expect(result.source).toBe("template");
    expect(result.answer).toContain(figure);
    expect(result.evidenceIds).toEqual(evidenceIds);
  });

  it("evidence always comes from real transactions", async () => {
    const ids = new Set(seedContext().txns.map((t) => t.id));
    for (const question of ["Did I get my Amazon refund?", "What did I spend on Argos?", "Show me my Amazon transactions.", "Did Tesco charge me twice?", "What subscriptions increased?"]) {
      for (const id of (await answerQuestion(question, { model: null })).evidenceIds) expect(ids.has(id)).toBe(true);
    }
  });
});
