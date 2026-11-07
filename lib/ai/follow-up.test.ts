import { describe, expect, it } from "vitest";
import { answerQuestion, handleAsk } from "./ask";
import { seedContext } from "./facts";
import { resolveFollowUp } from "./follow-up";

const ctx = seedContext();
const names = { merchants: [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))], categories: [...new Set(ctx.txns.map((t) => t.category))] };

describe("follow-up questions", () => {
  it.each([
    ["What about Argos?", "What did I spend at Tesco?", "What did I spend at Argos?"],
    ["And Amazon?", "Show me my Tesco transactions this month.", "Show me my Amazon transactions this month."],
    ["What about Sainsburys?", "What did I spend at Tesco last month?", "What did I spend at Sainsbury's last month?"],
    ["What about Argos?", "How much did I spend this month?", "What did I spend at Argos this month?"],
    ["And last month?", "How much did I spend on groceries?", "How much did I spend on groceries last month?"],
    ["What about last month?", "What's my biggest category this month?", "What's my biggest category last month?"],
    ["How about eating out?", "How much did I spend on groceries?", "How much did I spend on eating out?"],
    ["What about restaurants?", "What did I spend this month?", "How much did I spend on eating out this month?"],
  ])("%s after %s", (question, previous, expected) => expect(resolveFollowUp(question, previous, names)).toBe(expected));

  it.each([
    ["How much did I spend this month?", "What did I spend at Tesco?"],
    ["What about Lidl?", "What did I spend at Tesco?"],
    ["What about it?", "What did I spend at Tesco?"],
    ["What about Argos?", undefined],
  ])("%s stays as it is", (question, previous) => expect(resolveFollowUp(question, previous, names)).toBe(question));

  it("answers the follow-up from the facts", async () => {
    const result = await answerQuestion("What about Argos?", { model: null, previousQuestion: "What did I spend at Tesco?" });
    expect(result.answer).toContain("£249.00");
    expect(result.evidenceIds).toEqual(["t060"]);
    const month = await answerQuestion("And last month?", { model: null, previousQuestion: "What's my biggest spending category?" });
    expect(month.answer).toBe("Your biggest category last month was Groceries, £318.30.");
  });

  it("an unknown shop is still not answered with another one", async () => {
    expect((await answerQuestion("What about Lidl?", { model: null, previousQuestion: "What did I spend at Tesco?" })).answer).toBe("I can't tell that from your transactions.");
  });

  it("the request field is optional and checked", async () => {
    const post = (body: unknown) => handleAsk(new Request("http://x/api/ask", { method: "POST", body: JSON.stringify(body) }), () => null);
    expect((await (await post({ question: "What about Argos?", previousQuestion: "What did I spend at Tesco?" })).json()).answer).toContain("£249.00");
    expect((await post({ question: "What about Argos?" })).status).toBe(200);
    expect((await post({ question: "What about Argos?", previousQuestion: 5 })).status).toBe(400);
    expect((await post({ question: "What about Argos?", previousQuestion: "x".repeat(301) })).status).toBe(400);
  });
});
