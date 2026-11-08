import { describe, expect, it } from "vitest";
import { smallTalk } from "./small-talk";
import { validateStep } from "./registry";

describe("smallTalk", () => {
  it.each(["hello", "Hello!", "hi", "Hey Dial", "good morning", "hello there", "Hiya"])("greets: %s", (t) => {
    expect(smallTalk(t)).toMatch(/^Hello\. I'm Dial/);
  });
  it.each(["thanks", "Thank you!", "cheers", "thanks Dial"])("thanks: %s", (t) => {
    expect(smallTalk(t)).toMatch(/welcome/);
  });
  it.each(["how are you", "what's up", "are you there?"])("how are you: %s", (t) => {
    expect(smallTalk(t)).toMatch(/ready to help/);
  });
  it("leaves real requests alone", () => {
    for (const t of ["hello how much did I spend", "hi can you make the text bigger", "thanks, now show spending", "what is my bill", "make everything bigger", "tell me about my accounts", ""]) {
      expect(smallTalk(t)).toBeNull();
    }
  });
  it("never contains a figure, and is a valid local step", () => {
    const r = smallTalk("hello")!;
    expect(r).not.toMatch(/£|\d/);
    expect(validateStep({ type: "local", text: r })).toEqual({ type: "local", text: r });
  });
});
