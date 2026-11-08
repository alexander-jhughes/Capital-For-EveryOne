import { describe, expect, it, vi } from "vitest";
import { answerQuestion } from "./ask";
import { overviewFacts } from "./answer-facts";
import { seedContext } from "./facts";
import { checkAnswer } from "./guard";
import { matchIntent } from "./intent";
import { templateAnswer } from "./templates";
import type { AskModel } from "./model";

const ctx = seedContext();
const set = overviewFacts(ctx);

describe("account overview", () => {
  it.each(["Tell me about my accounts", "tell me about my account", "Give me a summary", "How am I doing?", "what's going on with my card", "account overview"])("%s is an overview", (q) => {
    expect(matchIntent(q)).toBe("account_overview");
  });
  it.each(["What did I spend this month?", "When is my bill due?", "Should I pay my bill?", "How much do I owe?", "Has Netflix gone up?"])("%s is not", (q) => {
    expect(matchIntent(q)).not.toBe("account_overview");
  });

  it("uses verified figures only", () => {
    const text = JSON.stringify(set.facts);
    for (const v of ["£486.20", "£25.00", "£1,069.89", "£402.35", "Friday 13 November", "£430.11", "Netflix", "Tesco, £38.62"]) expect(text).toContain(v);
    expect(set.evidenceIds).toEqual([]);
  });

  it("the template passes the guard", () => {
    const t = templateAnswer(set, "tell me about my account");
    expect(t).toBe("Your bill is £486.20, due on Friday 13 November, and the minimum payment is £25.00. You have spent £402.35 so far this month, and you owe £1,069.89 in total.");
    expect(checkAnswer(t, set, "tell me about my account")).toEqual({ ok: true });
  });

  it.each([
    ["Your bill is £1,069.89, due on Friday 13 November.", "total called the bill"],
    ["You owe £486.20 in total and spent £402.35 this month.", "bill called the total"],
    ["Your bill is £486.20 and you need to pay £25.00 by Friday 13 November.", "minimum not called minimum"],
    ["Your bill is £486.20, due on Friday 14 November.", "wrong date"],
    ["Your bill is £500.00.", "invented amount"],
  ])("rejects: %s (%s)", (reply) => {
    expect(checkAnswer(reply, set, "tell me about my account").ok).toBe(false);
  });

  it("accepts a correct Gemini-style summary", () => {
    const reply = "Your bill of £486.20 is due on Friday 13 November, with a minimum payment of £25.00. You have spent £402.35 so far this month, and you owe £1,069.89 in total.";
    expect(checkAnswer(reply, set, "tell me about my account")).toEqual({ ok: true });
  });

  it("goes to Gemini to word it, and falls back to the template when Gemini's reply fails the guard", async () => {
    const good = "Your bill of £486.20 is due on Friday 13 November, with a minimum payment of £25.00. You have spent £402.35 so far this month, and you owe £1,069.89 in total.";
    const model: AskModel = { classify: vi.fn(async () => null), phrase: vi.fn(async () => good) };
    const r = await answerQuestion("tell me about my accounts", { model, ctx });
    expect(r).toMatchObject({ answer: good, source: "model", evidenceIds: [] });
    const bad: AskModel = { classify: vi.fn(async () => null), phrase: vi.fn(async () => "Your bill is £1,069.89.") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r2 = await answerQuestion("tell me about my accounts", { model: bad, ctx });
    warn.mockRestore();
    expect(r2.source).toBe("template");
    expect(r2.answer).toContain("you owe £1,069.89 in total");
  });

  it("Gemini can route an unusual phrasing to the overview", async () => {
    const model: AskModel = { classify: vi.fn(async () => ({ intent: "account_overview" as const, confidence: "high" as const })), phrase: vi.fn(async () => null) };
    const r = await answerQuestion("anything I need to know about my card right now", { model, ctx });
    expect(model.classify).toHaveBeenCalled();
    expect(r.answer).toContain("£486.20");
  });
});
