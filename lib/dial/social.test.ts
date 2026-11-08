import { describe, expect, it } from "vitest";
import { partOfDay, safeChatReply, socialKind, socialTurn, splitGreeting } from "./social";

const ctx = { hour: 10, turn: 0 };

describe("social moments", () => {
  it.each([
    ["hello", "greeting"],
    ["hey dial", "greeting"],
    ["good morning", "greeting"],
    ["hi, how are you?", "how_are_you"],
    ["how are you", "how_are_you"],
    ["how's it going", "how_are_you"],
    ["thanks", "thanks"],
    ["thank you so much", "thanks"],
    ["cheers", "thanks"],
    ["bye", "goodbye"],
    ["take care", "goodbye"],
    ["you're brilliant", "compliment"],
    ["good bot", "compliment"],
    ["ugh", "frustration"],
    ["this is useless", "frustration"],
    ["you don't understand", "frustration"],
    ["sorry", "apology"],
    ["lol", "laugh"],
    ["tell me a joke", "joke"],
    ["I'm having a rough day", "feeling_low"],
    ["what's the weather like", "off_topic"],
    ["ok thanks", "thanks"],
    ["cool", "ok"],
  ])("%s -> %s", (text, kind) => expect(socialKind(text)).toBe(kind));

  it("treats 'hi, how are you' as one social moment", () => {
    expect(socialTurn("hi, how are you?", ctx)).toMatchObject({ kind: "reply", reply: { kind: "how_are_you" } });
    expect(socialTurn("hey there how's it going", ctx)).toMatchObject({ kind: "reply", reply: { kind: "how_are_you" } });
  });

  it("never swallows a money question", () => {
    for (const t of [
      "what did I spend this month",
      "what's my balance",
      "my balance is wrong",
      "thanks, what about Netflix?",
      "did I pay Tesco twice",
      "how much do I owe",
      "show me my spending",
      "seriously how much did I spend at Amazon",
      "this is wrong, Tesco charged me twice",
      "I have trouble seeing at night",
      "make everything bigger",
    ])
      expect(socialTurn(t, ctx).kind === "reply", t).toBe(false);
  });

  it("says hello, then handles the real request", () => {
    expect(splitGreeting("hi Dial, did I pay Tesco twice?", ctx)).toEqual({ greeting: "Hi!", rest: "did I pay Tesco twice?" });
    expect(splitGreeting("good evening, how much do I owe", { hour: 20, turn: 0 })).toEqual({ greeting: "Good evening!", rest: "how much do I owe" });
    expect(splitGreeting("thanks, what about Netflix?", ctx)).toEqual({ greeting: "Thanks!", rest: "what about Netflix?" });
    expect(splitGreeting("hello", ctx)).toBeNull();
  });

  it("greets by the time of day", () => {
    expect(partOfDay(8)).toBe("morning");
    expect(partOfDay(14)).toBe("afternoon");
    expect(partOfDay(21)).toBe("evening");
    const r = socialTurn("good evening", { hour: 21, turn: 0 });
    expect(r.kind === "reply" && r.reply.text.startsWith("Good evening!")).toBe(true);
  });

  it("varies its wording from turn to turn", () => {
    const texts = new Set([0, 1, 2].map((turn) => (socialTurn("thanks", { hour: 10, turn }) as { reply: { text: string } }).reply.text));
    expect(texts.size).toBe(3);
  });

  it("never puts a figure, date or account detail in a social reply", () => {
    for (const t of ["hello", "how are you", "thanks", "bye", "ugh", "sorry", "lol", "tell me a joke", "bad day", "weather?", "ok"])
      for (const turn of [0, 1, 2]) {
        const r = socialTurn(t, { hour: 10, turn });
        if (r.kind === "reply") expect(r.reply.text, t).not.toMatch(/[0-9£]/);
      }
  });
});

describe("care comes first", () => {
  it("answers anyone who may be in danger with real help, whatever else they said", () => {
    for (const t of ["I want to die", "hi, I don't want to live anymore", "I can't go on", "thinking about suicide", "I might hurt myself"]) {
      const r = socialTurn(t, ctx);
      expect(r.kind, t).toBe("reply");
      if (r.kind === "reply") {
        expect(r.reply.kind).toBe("crisis");
        expect(r.reply.text).toContain("Samaritans");
        expect(r.reply.text).toContain("116 123");
        expect(r.reply.text).toContain("999");
      }
    }
  });

  it("meets money trouble with empathy, free help and the Pay screen, never a lecture", () => {
    for (const t of ["I can't pay my bill", "I'm struggling with money", "I'm behind on my payments", "I lost my job"]) {
      const r = socialTurn(t, ctx);
      expect(r.kind === "reply" && r.reply.kind, t).toBe("hardship");
      if (r.kind === "reply") {
        expect(r.reply.link?.href).toBe("/account/pay");
        expect(r.reply.text).toMatch(/StepChange|MoneyHelper/);
      }
    }
  });
});

describe("cloud small-talk replies are checked", () => {
  it("keeps short, plain, friendly text", () => {
    expect(safeChatReply("  I can't check the weather, sadly! But I'm here for your card.  ")).toBe("I can't check the weather, sadly! But I'm here for your card.");
  });
  it("rejects figures, money, advice, links, markup and anything long", () => {
    for (const bad of ["You have £20 left", "Your balance looks fine", "You should save more", "See www.example.com", "<b>hi</b>", "x".repeat(300), 42, null, "It's 3pm"])
      expect(safeChatReply(bad), String(bad)).toBeNull();
  });
});
