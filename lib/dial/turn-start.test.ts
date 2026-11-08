// How a turn starts when voice corrections meet the accessibility layer's clarifying questions (lib/dial/turn-start.ts,
// used by components/dial/session.tsx). Regression cases 1-5 from the integration review; 6 is the existing
// conversation and access suites, 7 is in scripts/test-voice-browser.mjs.
import { describe, expect, it } from "vitest";
import { WHAT_WOULD_HELP } from "../access/clarify";
import { plan } from "./plan";
import { startTurn } from "./turn-start";
import { EMPTY_CONTEXT } from "./types";

const env = { context: EMPTY_CONTEXT, textSize: 125 as const, merchants: ["Tesco"], transactionIds: [], months: ["2026-10", "2026-11"], today: "2026-11-08" };
const planned = (text: string, replaces?: string) => plan({ text, replaces }, env).steps;

describe("starting a turn", () => {
  it("1. a correction of the question in flight is corrected, even when it would otherwise get a question back", () => {
    const start = startTurn("Actually, not bigger, smaller", undefined, "Make the text bigger");
    expect(start).toEqual({ replaces: "Make the text bigger", inFlight: "Make the text bigger. Actually, not bigger, smaller", question: null });
    // Planned against what it corrects: from 125% down a step, not "Do you want it bigger or smaller?".
    expect(planned("Actually, not bigger, smaller", start.replaces)).toEqual([{ type: "preferences", actions: [{ type: "textSize", value: 100 }] }]);
  });

  it("2. a correction inside one utterance (the voice engine's replaces) never gets a question back", () => {
    const start = startTurn("not bigger, smaller", "make the text bigger", null);
    expect(start.question).toBeNull();
    expect(start.replaces).toBe("make the text bigger");
    // The engine's own correction wins over the question in flight.
    expect(startTurn("not bigger, smaller", "make the text bigger", "How much do I owe?").replaces).toBe("make the text bigger");
  });

  it("3. a question back leaves nothing in flight, so the next correction is a new request", () => {
    const vague = startTurn("Make it better", undefined, "How much did I spend on food?");
    expect(vague).toEqual({ question: WHAT_WOULD_HELP, inFlight: null });
    const next = startTurn("Actually, groceries", undefined, vague.inFlight);
    expect(next.replaces).toBeUndefined();
    expect(planned("Actually, groceries", next.replaces)).toEqual(planned("Actually, groceries"));
  });

  it("4. with nothing in flight, vague and contradictory requests still get a question back", () => {
    expect(startTurn("Make it better", undefined, null).question).toBe(WHAT_WOULD_HELP);
    expect(startTurn("Make the text bigger and smaller", undefined, null).question).toBe("Do you want it bigger or smaller?");
    expect(startTurn("Make the text bigger", undefined, null)).toEqual({ replaces: undefined, inFlight: "Make the text bigger", question: null });
  });

  it("5. a whole new question while one is in flight replaces it rather than being merged into it", () => {
    const start = startTurn("Actually, how much do I owe?", undefined, "How much did I spend on food");
    expect(start.question).toBeNull();
    expect(planned("Actually, how much do I owe?", start.replaces)).toEqual([{ type: "ask", question: "Actually, how much do I owe?" }]);
    // A sentence that doesn't open with a correction is just the next request.
    expect(startTurn("What's my balance?", undefined, "How much did I spend on food")).toEqual({ replaces: undefined, inFlight: "What's my balance?", question: null });
  });
});
