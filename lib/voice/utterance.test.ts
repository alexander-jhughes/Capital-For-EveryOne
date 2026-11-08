// MOCKED: scripted recogniser result sequences, no real speech recognition.
import { describe, expect, it } from "vitest";
import {
  CONTINUATION_PAUSE_MS,
  correct,
  echoSimilarity,
  endsMidThought,
  isStopPhrase,
  PAUSE_MS,
  pauseFor,
  TranscriptAssembler,
  type RecognisedResult,
} from "./utterance";

const fin = (transcript: string): RecognisedResult => ({ transcript, isFinal: true });
const int = (transcript: string): RecognisedResult => ({ transcript, isFinal: false });

describe("MOCKED corrections", () => {
  it("'Actually, groceries specifically' replaces the food question", () => {
    expect(correct(["How much did I spend on food? Actually, groceries specifically"])).toEqual({
      text: "groceries specifically",
      corrected: true,
      replaces: "How much did I spend on food?",
    });
  });
  it("a complete correction is delivered with what it replaced; the caller decides", () => {
    expect(correct(["How much did I spend on food this month? Actually, compare it with last month"])).toEqual({
      text: "compare it with last month",
      corrected: true,
      replaces: "How much did I spend on food this month?",
    });
  });
  it("works without punctuation when the sentence clearly restarts", () => {
    expect(correct(["how much did I spend on food actually groceries specifically"])).toMatchObject({ text: "groceries specifically", replaces: "how much did I spend on food" });
  });
  it("a recogniser segment boundary (a pause) counts like punctuation", () => {
    expect(correct(["when is it", "actually what do I owe"])).toMatchObject({ text: "what do I owe", corrected: true, replaces: "when is it" });
    expect(correct(["when is it actually what do I owe"]).corrected).toBe(false);
  });
  it("leaves 'actually' alone when it is part of the sentence", () => {
    for (const s of ["How much did I actually spend?", "Did Tesco actually charge me twice", "Has my bill actually gone up", "Is it actually due tomorrow", "What's my balance actually"])
      expect(correct([s])).toEqual({ text: s, corrected: false });
  });
  it.each([
    ["Show me Tesco, no wait, Sainsbury's", "Sainsbury's", "Show me Tesco"],
    ["What did I spend on food I mean takeaways", "takeaways", "What did I spend on food"],
    ["How much on Amazon sorry Netflix", "Netflix", "How much on Amazon"],
    ["When is my bill due scratch that how much do I owe", "how much do I owe", "When is my bill due"],
    ["Spending this week, let me rephrase, spending this month", "spending this month", "Spending this week"],
    ["Make the text bigger, or rather much bigger", "much bigger", "Make the text bigger"],
    ["food actually groceries sorry I mean takeaways", "takeaways", "food"],
  ])("%s", (said, text, replaces) => {
    expect(correct([said])).toEqual({ text, corrected: true, replaces });
  });
  it("'what do I mean' is not a correction", () => {
    expect(correct(["what do I mean by minimum payment"]).corrected).toBe(false);
  });
  it("a correction word at the start just drops the lead-in", () => {
    expect(correct(["Actually, how much do I owe?"])).toEqual({ text: "how much do I owe?", corrected: false });
    expect(correct(["No, I meant make the text bigger"])).toEqual({ text: "make the text bigger", corrected: false });
  });
  it("a correction word with nothing after it changes nothing", () => {
    expect(correct(["How much do I owe, I mean"])).toEqual({ text: "How much do I owe, I mean", corrected: false });
    expect(correct(["I'd rather talk than tap"])).toEqual({ text: "I'd rather talk than tap", corrected: false });
  });
});

describe("MOCKED pauses and continuation words", () => {
  it("normal end after a stable pause, longer after a word that leaves the thought open", () => {
    expect(pauseFor("how much do I owe")).toBe(PAUSE_MS);
    for (const s of ["what did I spend on food and", "show me Tesco but", "how much on food actually", "the one for, I mean", "what did I spend on", "compare it with"])
      expect(pauseFor(s), s).toBe(CONTINUATION_PAUSE_MS);
    expect(PAUSE_MS).toBeGreaterThanOrEqual(900);
    expect(PAUSE_MS).toBeLessThanOrEqual(1200);
    expect(CONTINUATION_PAUSE_MS).toBe(1800);
  });
  it("endsMidThought ignores punctuation and case", () => {
    expect(endsMidThought("Food AND,")).toBe(true);
    expect(endsMidThought("groceries.")).toBe(false);
    expect(endsMidThought("")).toBe(false);
  });
  it("the pause restarts every time the words change", () => {
    const a = new TranscriptAssembler();
    a.update([int("how much")], 0);
    expect(a.remaining(500)).toBe(PAUSE_MS - 500);
    a.update([int("how much do I owe")], 800);
    expect(a.remaining(1700)).toBe(PAUSE_MS - 900);
    // A final with the same words doesn't restart the pause.
    a.update([fin("how much do I owe")], 1700);
    expect(a.remaining(1800)).toBe(0);
  });
  it("waits longer after 'and'", () => {
    const a = new TranscriptAssembler();
    a.update([fin("show me groceries and")], 0);
    expect(a.remaining(PAUSE_MS)).toBe(CONTINUATION_PAUSE_MS - PAUSE_MS);
  });
  it("nothing heard means nothing to end", () => {
    expect(new TranscriptAssembler().remaining(10_000)).toBe(Infinity);
  });
});

describe("MOCKED stop-word reflex", () => {
  it.each(["stop", "Stop!", "cancel", "never mind", "OK stop please", "stop talking", "be quiet", "Dial, stop"])("'%s' is a stop", (s) => expect(isStopPhrase(s)).toBe(true));
  it.each(["stop my spend pause", "please stop the payment to Tesco now", "how do I cancel a subscription", "don't stop", "stop listening"])("'%s' is not", (s) =>
    expect(isStopPhrase(s)).toBe(false),
  );
  it("only short utterances (5 words or fewer)", () => {
    expect(isStopPhrase("ok ok ok stop please")).toBe(true);
    expect(isStopPhrase("ok ok ok ok stop please")).toBe(false);
  });
  it("the assembler flags a stop on interim text", () => {
    const a = new TranscriptAssembler();
    expect(a.update([int("stop")], 0).stop).toBe(true);
  });
});

describe("MOCKED transcript snapshots", () => {
  it("shows final and interim text separately; text is what would be sent", () => {
    const a = new TranscriptAssembler();
    const { snapshot } = a.update([fin("how much did I"), int(" spend on food")], 0);
    expect(snapshot).toMatchObject({ finalText: "how much did I", interimText: "spend on food", text: "how much did I spend on food", corrected: false });
  });
  it("corrections apply to the live text", () => {
    const a = new TranscriptAssembler();
    const { snapshot } = a.update([fin("How much did I spend on food?"), int(" actually groceries")], 0);
    expect(snapshot).toMatchObject({ text: "groceries", corrected: true, finalText: "How much did I spend on food?" });
  });
  it("reports changes only when something changed", () => {
    const a = new TranscriptAssembler();
    expect(a.update([int("hello")], 0).changed).toBe(true);
    expect(a.update([int("hello")], 10).changed).toBe(false);
    expect(a.update([fin("hello")], 20).changed).toBe(true);
  });
});

describe("MOCKED delivery: once per id, stale results dropped", () => {
  it("delivers the corrected utterance with what it replaced", () => {
    const a = new TranscriptAssembler();
    a.update([fin("How much did I spend on food?"), fin(" Actually, groceries specifically")], 0);
    const u = a.deliver();
    expect(u).toMatchObject({ text: "groceries specifically", replaces: "How much did I spend on food?", corrected: true, origin: "voice" });
  });
  it("the delivered text equals the last snapshot", () => {
    const a = new TranscriptAssembler();
    const { snapshot } = a.update([fin("what do I owe"), int(" this month")], 0);
    expect(a.deliver()).toMatchObject({ utteranceId: snapshot.utteranceId, text: snapshot.text });
  });
  it("delivers each id at most once and moves to a new id", () => {
    const a = new TranscriptAssembler();
    a.update([fin("what do I owe")], 0);
    const first = a.deliver()!;
    expect(a.deliver()).toBeNull();
    expect(a.snapshot.utteranceId).toBeGreaterThan(first.utteranceId);
  });
  it("a late final for words already delivered is ignored (stale)", () => {
    const a = new TranscriptAssembler();
    a.update([int("what do I owe")], 0);
    a.deliver();
    // The recogniser finalises the same result afterwards: it belongs to the delivered utterance.
    const late = a.update([fin("what do I owe today")], 100);
    expect(late.snapshot.text).toBe("");
    expect(a.deliver()).toBeNull();
    // New speech in the same session starts the next utterance.
    expect(a.update([fin("what do I owe today"), int(" and my bill")], 200).snapshot.text).toBe("and my bill");
  });
  it("replaying the same result list delivers nothing twice", () => {
    const a = new TranscriptAssembler();
    const list = [fin("hello there")];
    a.update(list, 0);
    expect(a.deliver()).not.toBeNull();
    a.update(list, 10);
    expect(a.deliver()).toBeNull();
  });
  it("discard drops the pending words and never delivers that id", () => {
    const a = new TranscriptAssembler();
    const id = a.update([int("pay my bill")], 0).snapshot.utteranceId;
    a.discard();
    expect(a.deliver()).toBeNull();
    expect(a.snapshot.utteranceId).not.toBe(id);
  });
  it("ids are unique across assemblers on the page", () => {
    const a = new TranscriptAssembler();
    const b = new TranscriptAssembler();
    expect(a.snapshot.utteranceId).not.toBe(b.snapshot.utteranceId);
  });
  it("a new recogniser session keeps the words heard so far (push-to-talk across a restart)", () => {
    const a = new TranscriptAssembler();
    a.update([fin("how much did I spend")], 0);
    a.newSession();
    expect(a.update([int("on food")], 100).snapshot).toMatchObject({ text: "how much did I spend on food", finalText: "how much did I spend", interimText: "on food" });
  });
});

describe("MOCKED echo filter and barge-in", () => {
  const SPOKEN = "Your bill is £486.20, due on Friday 20 November. You owe £1,212.40 in total.";

  it("ordered token overlap: Dial's words heard back score high, a new question scores low", () => {
    expect(echoSimilarity("your bill is 486 pounds 20 due on Friday", SPOKEN)).toBeGreaterThanOrEqual(0.7);
    expect(echoSimilarity("you owe 1212 40 in total", SPOKEN)).toBe(1);
    expect(echoSimilarity("what about groceries", SPOKEN)).toBe(0);
    // Same words, wrong order and mostly new: not echo.
    expect(echoSimilarity("is my bill due", SPOKEN)).toBeLessThan(0.7);
    expect(echoSimilarity("", SPOKEN)).toBe(0);
  });
  it("ignores Dial's own words while it speaks", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking(SPOKEN, 0);
    const u = a.update([int("your bill is 486")], 100);
    expect(u).toMatchObject({ echo: true, bargeIn: false });
    expect(u.snapshot.text).toBe("");
    expect(a.hasWords).toBe(false);
  });
  it("still ignores echo for 1.5 s after Dial stops, then drops it", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking(SPOKEN, 0);
    a.setSpeaking(null, 1000);
    expect(a.update([fin("in total")], 2000).echo).toBe(true);
    expect(a.dropEcho(2400)).toBe(false);
    expect(a.dropEcho(2600)).toBe(true);
    expect(a.update([fin("in total"), int(" what about groceries")], 3000).snapshot.text).toBe("what about groceries");
  });
  it("two non-echo words while Dial speaks is a barge-in, reported once", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking(SPOKEN, 0);
    expect(a.update([int("what")], 100).bargeIn).toBe(false);
    expect(a.update([int("what about")], 200).bargeIn).toBe(true);
    expect(a.update([int("what about groceries")], 300).bargeIn).toBe(false);
  });
  it("a stop word over Dial is a barge-in even as one word", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking(SPOKEN, 0);
    expect(a.update([int("stop")], 100)).toMatchObject({ bargeIn: true, stop: true });
  });
  it("a stop word Dial says itself is echo, not a stop", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking("You can also say take me to spending, undo, or stop.", 0);
    expect(a.update([int("or stop")], 100)).toMatchObject({ echo: true, stop: false, bargeIn: false });
  });
  it("strips Dial's words from the start of a barge-in", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking(SPOKEN, 0);
    const u = a.update([fin("your bill is"), int(" what about my groceries this month")], 100);
    expect(u.snapshot.text).toBe("what about my groceries this month");
    expect(u.bargeIn).toBe(true);
  });
  it("no barge-in after Dial has stopped speaking", () => {
    const a = new TranscriptAssembler();
    a.setSpeaking(SPOKEN, 0);
    a.setSpeaking(null, 100);
    expect(a.update([int("what about groceries")], 200).bargeIn).toBe(false);
  });
});
