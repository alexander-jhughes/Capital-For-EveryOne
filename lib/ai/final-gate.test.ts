import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion } from "./ask";
import { CANT_TELL } from "./guard";
import { templateAnswer } from "./templates";

// Templates are the last resort, so nothing normally tests the gate after them. These make one go wrong on purpose.
vi.mock("./templates", () => ({ templateAnswer: vi.fn() }));

const safe = { answer: CANT_TELL, evidenceIds: [], source: "template", experience: { template: "general", intent: "general", confidence: "low" } };

describe("the final gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["a wrong figure", "How much do I need to pay?", "You need £999.99."],
    ["the wrong balance", "What's my current balance?", "Your current balance is £486.20."],
    ["a pending refund as arrived", "Where is my Amazon refund?", "Your £19.99 refund has arrived. Your £14.99 refund has arrived."],
    ["markup", "How much did I spend at Argos?", "<b>You spent £249.00 at Argos.</b>"],
  ])("stops %s, even from our own template", async (_, question, wrong) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(templateAnswer).mockReturnValue(wrong);
    expect(await answerQuestion(question, { model: null })).toEqual(safe);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("lets a correct answer through", async () => {
    vi.mocked(templateAnswer).mockReturnValue("You spent £249.00 at Argos on Saturday 10 October.");
    expect(await answerQuestion("How much did I spend at Argos?", { model: null })).toMatchObject({ source: "template", evidenceIds: ["t060"], experience: { template: "spending" } });
  });
});
