import { describe, expect, it } from "vitest";
import { buildTranscript, endsWithContinuation, hasWords, isEcho, isStopWord, joinParts, normalise, readResults, words, type ResultLike } from "./transcript";

const result = (transcript: string, isFinal = false): ResultLike => Object.assign([{ transcript }], { isFinal });

describe("normalising text", () => {
  it("collapses whitespace and joins pieces with single spaces", () => {
    expect(normalise("  how   much\n do I owe ")).toBe("how much do I owe");
    expect(joinParts(" how much", "", " do I owe ")).toBe("how much do I owe");
  });
  it("only counts letters and digits as words", () => {
    expect(hasWords(" ,. ? ")).toBe(false);
    expect(hasWords("£5")).toBe(true);
    expect(hasWords("café")).toBe(true);
  });
  it("compares words without case, punctuation or accents", () => {
    expect(words("Don't, Café! £38.62")).toEqual(["dont", "cafe", "38", "62"]);
  });
});

describe("readResults", () => {
  it("splits finals from interim words", () => {
    expect(readResults([result("How much", true), result(" did I", true), result(" spend")])).toEqual({ final: "How much did I", interim: "spend" });
  });
  it("skips results that belong to an earlier utterance", () => {
    expect(readResults([result("first one", true), result("second", true), result("one")], 1)).toEqual({ final: "second", interim: "one" });
  });
  it("copes with empty results", () => {
    expect(readResults([])).toEqual({ final: "", interim: "" });
    expect(readResults([Object.assign([], { isFinal: true })])).toEqual({ final: "", interim: "" });
  });
});

describe("buildTranscript", () => {
  it("joins final and interim words when nothing was corrected", () => {
    expect(buildTranscript(3, "How much", "do I owe")).toEqual({
      snapshot: { utteranceId: 3, finalText: "How much", interimText: "do I owe", text: "How much do I owe", corrected: false },
    });
  });

  it("applies a correction in the final words", () => {
    const t = buildTranscript(1, "How much on food? Actually, groceries", "");
    expect(t.snapshot).toEqual({ utteranceId: 1, finalText: "groceries", interimText: "", text: "groceries", corrected: true });
    expect(t.replaces).toBe("How much on food?");
  });

  it("keeps interim words after a correction in the final words", () => {
    const t = buildTranscript(1, "Take me to pay, no wait, spending", "please");
    expect(t.snapshot).toMatchObject({ finalText: "spending", interimText: "please", text: "spending please", corrected: true });
    expect(t.replaces).toBe("Take me to pay");
  });

  it("treats the corrected tail as interim when the correction is still being recognised", () => {
    const t = buildTranscript(1, "How much on food?", "actually groceries");
    expect(t.snapshot).toMatchObject({ finalText: "", interimText: "groceries", text: "groceries", corrected: true });
    expect(t.replaces).toBe("How much on food?");
  });

  it("doesn't correct until something follows the phrase", () => {
    expect(buildTranscript(1, "How much on food? Actually", "").snapshot).toMatchObject({ text: "How much on food? Actually", corrected: false });
  });

  it("always shows exactly what it would submit", () => {
    for (const [f, i] of [["a, actually b", "c"], ["a", "no I mean b"], ["food", ""], ["", "groceries"]]) {
      const s = buildTranscript(1, f, i).snapshot;
      expect(joinParts(s.finalText, s.interimText)).toBe(s.text);
    }
  });
});

describe("endsWithContinuation", () => {
  it.each(["How much did I spend and", "Show me food, actually", "What about I mean", "um", "so", "groceries but", "this or", "then", "food and,"])("waits longer after: %s", (t) => {
    expect(endsWithContinuation(t)).toBe(true);
  });
  it.each(["How much did I spend", "Show me the brand", "Take me to spending", ""])("doesn't wait after: %s", (t) => {
    expect(endsWithContinuation(t)).toBe(false);
  });
});

describe("isStopWord", () => {
  it.each(["stop", "Stop.", "cancel", "wait", "hang on", "Be quiet", "stop talking", "stop stop", "OK stop please", "hang on a second", "Dial, stop"])("stops: %s", (t) => {
    expect(isStopWord(t)).toBe(true);
  });
  it.each(["stop my card", "cancel my payment", "wait, how much do I owe", "", "Spend Pause"])("is a request, not a stop word: %s", (t) => {
    expect(isStopWord(t)).toBe(false);
  });
});

describe("isEcho", () => {
  const dial = "Your bill is £120.50, due on Friday 20 November. You owe £340 in total.";
  it("recognises Dial's own words coming back, even misheard or partial", () => {
    expect(isEcho("your bill is 120.50", dial)).toBe(true);
    expect(isEcho("you owe £340 in total", dial)).toBe(true);
    expect(isEcho("your bill is 120 50 duo on friday", dial)).toBe(true);
  });
  it("lets the person's own words through", () => {
    expect(isEcho("what did I spend on groceries", dial)).toBe(false);
    expect(isEcho("is that more than last month", dial)).toBe(false);
  });
  it("is never echo when Dial is quiet or nothing was heard", () => {
    expect(isEcho("your bill", null)).toBe(false);
    expect(isEcho("", dial)).toBe(false);
  });
});
