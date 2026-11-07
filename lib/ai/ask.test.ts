import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactSet, Intent } from "../types";
import { answerQuestion, handleAsk, MAX_QUESTION_LENGTH } from "./ask";
import { DEMO_ANSWERS } from "./cache";
import { buildFacts, INTENTS, seedContext } from "./facts";
import { CANT_TELL, checkAnswer } from "./guard";
import { matchIntent } from "./intent";
import { createModel, type AskModel } from "./model";
import { templateAnswer } from "./templates";

const TESCO = "Did I pay Tesco twice this month?";
const duplicates = buildFacts("duplicates");
const bill = buildFacts("days_until_due");

const fakeModel = (over: Partial<AskModel> = {}): AskModel => ({
  classify: vi.fn(async (): Promise<Intent | null> => null),
  phrase: vi.fn(async (): Promise<string | null> => "Tesco charged you £38.62 twice."),
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
  ])("%s", (question, intent) => expect(matchIntent(question)).toBe(intent));

  it.each(["What is my credit score?", "Should I pay my bill early?", "How much did I spend at Pret?", "What did I spend in 2024?"])(
    "leaves %s unmatched rather than guessing",
    (question) => expect(matchIntent(question)).toBeNull(),
  );
});

describe("checkAnswer", () => {
  it.each([
    "Tesco charged you £38.62 on Thursday 5 November and again on Friday 6 November.",
    "Tesco took £38.62 on 5 Nov. It took the same again on 6th November.",
    "You may have paid Tesco twice.",
    CANT_TELL,
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
    expect(checkAnswer("You may have paid Tesco twice.", duplicates).ok).toBe(true);
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
    const result = await answerQuestion(TESCO, { model: fakeModel() });
    expect(result).toEqual({ answer: "Tesco charged you £38.62 twice.", evidenceIds: duplicates.evidenceIds, source: "model" });
  });

  it("gives the model the facts and never takes evidence from it", async () => {
    const phrase = vi.fn(async () => "Tesco charged you £38.62 twice. Evidence: tx-999.");
    const result = await answerQuestion(TESCO, { model: fakeModel({ phrase }) });
    expect(phrase.mock.calls[0]).toContainEqual(duplicates);
    expect(result.evidenceIds).toEqual(duplicates.evidenceIds);
  });

  it("rejects a bad reply in favour of the template, even for a cached question", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => "You owe £1,000,000." });
    const result = await answerQuestion(TESCO, { model });
    expect(result).toEqual({ answer: templateAnswer(duplicates), evidenceIds: duplicates.evidenceIds, source: "template" });
  });

  it("uses the template when the model refuses or is cut off", async () => {
    const result = await answerQuestion(TESCO, { model: fakeModel({ phrase: async () => null }) });
    expect(result.source).toBe("template");
  });

  it("shows no evidence when the model says the facts don't cover it", async () => {
    const result = await answerQuestion(TESCO, { model: fakeModel({ phrase: async () => "I can’t tell that from your transactions." }) });
    expect(result).toEqual({ answer: CANT_TELL, evidenceIds: [], source: "model" });
  });

  it("answers from the cache on an error, for a demo question", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => Promise.reject(new Error("boom")) });
    const result = await answerQuestion(TESCO, { model });
    expect(result.source).toBe("cache");
    expect(result.evidenceIds).toEqual(duplicates.evidenceIds);
  });

  it("uses the template on an error, for any other question", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ phrase: async () => Promise.reject(new Error("boom")) });
    expect((await answerQuestion("How much is my bill?", { model })).source).toBe("template");
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
    const result = await answerQuestion("What do I owe you lot?", { model: fakeModel({ classify, phrase }) });
    expect(classify).toHaveBeenCalledOnce();
    expect(result.source).toBe("model");
  });

  it("treats a failed classification as unanswerable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = fakeModel({ classify: async () => Promise.reject(new Error("boom")) });
    expect((await answerQuestion("What do I owe you lot?", { model })).answer).toBe(CANT_TELL);
  });

  it("shares one time limit across both model calls", async () => {
    const classify = vi.fn(async (): Promise<Intent | null> => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "days_until_due";
    });
    const phrase = vi.fn(async () => "Your bill is £486.20.");
    const result = await answerQuestion("What do I owe you lot?", { model: fakeModel({ classify, phrase }), timeoutMs: 100 });
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
    const response = await handleAsk(post(JSON.stringify({ question: TESCO })), () => model);
    expect(await response.text()).not.toContain(key);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
  });
});
