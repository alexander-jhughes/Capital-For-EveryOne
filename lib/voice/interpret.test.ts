import { describe, expect, it } from "vitest";
import { interpret, isQuestionText, normaliseUtterance, type Interpretation } from "./interpret";

type Case = [string, Partial<Interpretation> | ((r: Interpretation) => boolean)];
const ui = (...types: string[]) => (r: Interpretation) => r.kind === "ui" && types.every((t) => r.actions.some((a) => `${a.type}${"widget" in a ? `:${a.widget}` : ""}${"value" in a ? `=${a.value}` : ""}`.startsWith(t)));

const CASES: Case[] = [
  // The brief's examples
  ["Make everything bigger.", ui("textSize=125")],
  ["Put my balance at the top.", ui("moveToTop:balance")],
  ["Make the dashboard simpler.", ui("density=calm")],
  ["Hide the spending chart.", ui("hide:chart")],
  ["Show my recent transactions first.", ui("moveToTop:recent")],
  ["I want less information on the screen.", ui("density=calm")],
  ["Use more contrast.", ui("contrast=high")],
  ["Make the buttons easier to press.", ui("targets=large")],
  ["I prefer a dark interface.", ui("theme=dark")],
  ["Make my upcoming payments more visible.", ui("moveToTop:bill", "emphasize:bill")],
  ["I struggle to find out when my next payment is.", ui("moveToTop:bill", "emphasize:bill")],
  ["There's too much going on here.", ui("density=calm")],
  ["I want to see my spending before anything else.", ui("moveToTop:budget")],
  // Text size, phrased naturally
  ["I can't read this, it's too small", ui("textSize=125")],
  ["The writing is tiny", ui("textSize=125")],
  ["Can you make the text larger", ui("textSize=125")],
  ["That's too big, make it smaller", ui("textSize=100")],
  // Contrast and colour
  ["The colours look washed out", ui("contrast=high")],
  ["I find it hard to see some of the words", ui("contrast=high")],
  ["Go back to normal contrast", ui("contrast=standard")],
  ["The screen is too bright at night", ui("theme=dark")],
  ["Switch to a light background please", ui("theme=light")],
  // Spacing, targets, motion
  ["Everything feels cramped", ui("spacing=roomy")],
  ["Can you spread things out a bit", ui("spacing=roomy")],
  ["I keep missing the buttons", ui("targets=large")],
  ["The buttons are too small for my fingers", ui("targets=large")],
  ["Turn off the animations", ui("motion=reduced")],
  ["The moving stuff makes me dizzy", ui("motion=reduced")],
  // Layout
  ["I don't need the chart", ui("hide:chart")],
  ["Get rid of the budget section", ui("hide:budget")],
  ["Bring back the spending chart", ui("show:chart")],
  ["Put Dial's alerts first", ui("moveToTop:insights")],
  ["I want my transactions at the top", ui("moveToTop:recent")],
  ["Make my bill stand out", ui("moveToTop:bill", "emphasize:bill")],
  ["I never notice when my payment is due", ui("moveToTop:bill", "emphasize:bill")],
  ["Hide Spend Pause from the home screen", ui("hide:pause")],
  ["This is overwhelming", ui("density=calm")],
  ["It's all a bit busy", ui("density=calm")],
  ["Show everything again", ui("density=standard")],
  ["Bigger text and a dark background please", ui("textSize=125", "theme=dark")],
  // Assistant preferences
  ["Explain things step by step", ui("explanations=stepByStep")],
  ["Can you walk me through it in steps", ui("explanations=stepByStep")],
  ["I'd rather talk than tap", ui("voiceFirst=true")],
  ["I prefer tapping first", ui("voiceFirst=false")],
  ["Switch to voice-first mode", ui("voiceFirst=true")],
  ["Use fewer numbers", ui("answerStyle=brief", "density=calm")],
  ["Shorter explanations", ui("answerStyle=brief")],
  ["Keep your answers short", ui("answerStyle=brief")],
  ["Make this easier to understand", ui("explanations=stepByStep", "density=calm")],
  ["Larger buttons", ui("targets=large")],
  ["High contrast", ui("contrast=high")],
  ["Reduce motion", ui("motion=reduced")],
  // View (mode)
  ["Switch to simple view", { kind: "mode", mode: "simple" }],
  ["Show me more detail", { kind: "mode", mode: "complex" }],
  ["Give me the full details", { kind: "mode", mode: "complex" }],
  // Navigation
  ["Take me to payments", { kind: "navigate", to: "/account/pay" }],
  ["Go to my spending", { kind: "navigate", to: "/account/spending" }],
  ["Open settings", { kind: "navigate", to: "/account/settings" }],
  ["Go to Spend Pause", { kind: "navigate", to: "/account/spend-pause" }],
  ["Take me home", { kind: "navigate", to: "/account" }],
  ["Go back", { kind: "navigate", to: "back" }],
  ["Go to the previous page", { kind: "navigate", to: "back" }],
  // A place, not the browser's back button
  ["Go back to the dashboard", { kind: "navigate", to: "/account" }],
  // Controls
  ["Yes", { kind: "control", command: "yes" }],
  ["Yes please", { kind: "control", command: "yes" }],
  ["Keep it", { kind: "control", command: "yes" }],
  ["No thanks", { kind: "control", command: "no" }],
  ["Not now", { kind: "control", command: "no" }],
  ["Stop speaking", { kind: "control", command: "stop" }],
  ["Stop", { kind: "control", command: "stop" }],
  ["Undo that", { kind: "control", command: "undo" }],
  ["Put everything back to normal", { kind: "control", command: "reset" }],
  ["Save it", { kind: "control", command: "save" }],
  ["What can I say?", { kind: "control", command: "help" }],
  ["Help", { kind: "control", command: "help" }],
  ["I need help", { kind: "control", command: "help" }],
  ["Read everything aloud", { kind: "control", command: "readPage" }],
  ["Read my balance", { kind: "control", command: "readBalance" }],
  ["Close", { kind: "control", command: "exit" }],
  // Money questions go to /api/ask untouched
  ["How much did I spend?", { kind: "question", text: "How much did I spend?" }],
  ["How much do I owe?", { kind: "question", text: "How much do I owe?" }],
  ["Did Tesco charge me twice?", { kind: "question", text: "Did Tesco charge me twice?" }],
  ["Did I receive my Amazon refund?", { kind: "question", text: "Did I receive my Amazon refund?" }],
  ["When is my next payment?", { kind: "question", text: "When is my next payment?" }],
  ["Has Netflix gone up", { kind: "question", text: "Has Netflix gone up" }],
  // Not understood
  ["banana", { kind: "unknown" }],
  ["", { kind: "unknown" }],
];

describe("interpret: natural requests", () => {
  for (const [text, expected] of CASES) {
    it(JSON.stringify(text), () => {
      const r = interpret(text, { textSize: text.includes("too big") ? 125 : 100 });
      if (typeof expected === "function") expect(expected(r), JSON.stringify(r)).toBe(true);
      else expect(r).toMatchObject(expected);
    });
  }
  it("has at least 60 cases", () => expect(CASES.length).toBeGreaterThanOrEqual(60));
});

describe("interpret: safety", () => {
  it("never turns a money question into an interface change", () => {
    for (const q of ["How much is my bill?", "When is my bill due?", "What is my balance?", "How much have I spent on Tesco?"])
      expect(interpret(q).kind).toBe("question");
  });
  it("'no' inside a sentence is not a refusal", () => {
    expect(interpret("No, I meant make the text bigger").kind).toBe("ui");
  });
  it("cannot produce anything outside the allowlist", () => {
    const r = interpret("pay my bill of £486.20 now and delete my account");
    expect(["question", "unknown", "navigate"]).toContain(r.kind);
  });
  it("'help' and 'reset' inside a money request are not app controls", () => {
    expect(interpret("Help me stay within my budget").kind).not.toBe("control");
    expect(interpret("Can you help me understand my bill?")).toMatchObject({ kind: "question" });
    expect(interpret("Reset my budget").kind).not.toBe("control");
    expect(interpret("Reset")).toMatchObject({ kind: "control", command: "reset" });
  });
  it("money words keep 'easier to understand' a question", () => {
    expect(interpret("Make my bill easier to understand").kind).not.toBe("ui");
  });
  it("text size stops at the largest and smallest steps", () => {
    expect(interpret("bigger", { textSize: 200 })).toMatchObject({ kind: "ui", actions: [{ type: "textSize", value: 200 }] });
    expect(interpret("smaller", { textSize: 100 })).toMatchObject({ kind: "ui", actions: [{ type: "textSize", value: 100 }] });
  });
});

describe("interpret: helpers for the planner", () => {
  it("normalises to padded plain words", () => {
    expect(normaliseUtterance("  Take me to Sainsbury’s!  ")).toBe(" take me to sainsbury's ");
  });
  it.each([
    ["How much did I spend?", true],
    ["Explain my statement", true],
    ["Tell me about my bill", true],
    ["my bill?", true],
    ["Make everything bigger", false],
    ["Take me to spending", false],
  ])("isQuestionText(%s)", (text, expected) => {
    expect(isQuestionText(text)).toBe(expected);
  });
});
