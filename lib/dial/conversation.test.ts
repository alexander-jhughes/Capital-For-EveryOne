// The product brief's spoken examples, run through the real on-device pipeline: correction, transcript helpers,
// segment(), interpret(), plan() and runSteps(). No microphone, no Groq: see docs/VOICE-TESTING.md for what only a
// person with a real microphone can check.
//
// A second utterance reaches plan() the way components/dial/session.tsx sends it: its own text, no `replaces` (the
// voice engine only sets that for a correction inside one utterance), and the context the previous plan returned,
// plus afterAnswer() when the previous turn went to the backend.
import { describe, expect, it, vi } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { paymentReply } from "../payments/dial";
import { spendPauseReply } from "../spend-pause/dial";
import type { SpendPauseSettings } from "../types";
import { opensWithCorrection, splitCorrection } from "../voice/correction";
import { interpret } from "../voice/interpret";
import { buildTranscript, endsWithContinuation, isStopWord } from "../voice/transcript";
import { afterAnswer } from "./context";
import { plan, type PlanEnvWithTransactions } from "./plan";
import { validateStep } from "./registry";
import { runSteps, type RunnerDeps } from "./runner";
import { segment } from "./segment";
import { CONFIRMED_STEPS, EMPTY_CONTEXT, type DialContext, type DialPlan, type DialStep, type VisualRequest } from "./types";

const SPEND_PAUSE_ON: SpendPauseSettings = { enabled: true, singlePurchaseThreshold: null, monthlyBudget: 50000, quietHours: null };

function env(context: Partial<DialContext> = {}): PlanEnvWithTransactions {
  return {
    context: { ...EMPTY_CONTEXT, ...context },
    textSize: 100,
    merchants: [...new Set(SEED_TRANSACTIONS.map((t) => t.merchant))],
    transactionIds: SEED_TRANSACTIONS.map((t) => t.id),
    months: ["2026-09", "2026-10", "2026-11"],
    today: "2026-11-08",
    transactions: SEED_TRANSACTIONS,
    // The real Pay and Spend Pause answers, with Spend Pause on so a mistaken "turn it off" would show.
    localReply: (text) => {
      const sp = spendPauseReply(text, SPEND_PAUSE_ON, { activatedAt: null, deactivatedAt: null });
      if (sp) return sp.action ? { text: sp.text, link: { label: sp.action.label, href: sp.action.href } } : { text: sp.text };
      const p = paymentReply(text, { account: SEED_ACCOUNT, transactions: SEED_TRANSACTIONS, payments: [] });
      return p ? { text: p } : null;
    },
  };
}

const planned = (text: string, context: Partial<DialContext> = {}): DialPlan => plan({ text }, env(context));
const steps = (text: string, context: Partial<DialContext> = {}) => planned(text, context).steps;
/** The context a follow-up sees after this question was answered on the device. */
const after = (text: string, context: Partial<DialContext> = {}) => planned(text, context).context;
/** The context a follow-up sees after this question went to the backend (session.tsx calls afterAnswer). */
const afterBackend = (text: string) => afterAnswer(after(text), { question: text });

const visual = (request: VisualRequest): DialStep => ({ type: "visual", request });
const trend = (category: "Groceries" | "Eating out" | "Transport", month: string) => visual({ kind: "category_trend", category, months: [month] });
const GROCERIES_NOW = [trend("Groceries", "2026-11")];
const NOT_UNDERSTOOD = expect.stringContaining("didn't understand");

describe("brief 1: self-correction inside one utterance", () => {
  const CASES: [string, string, DialStep[], string][] = [
    ["Actually", "How much did I spend on restaurants? Actually, groceries.", GROCERIES_NOW, "groceries."],
    ["no, I meant", "How much did I spend on groceries in September? No, I meant October", [trend("Groceries", "2026-10")], "October"],
    ["change that to", "Show my Sainsbury's transactions, change that to Tesco", [{ type: "navigate", to: "/account/spending", filters: { merchant: "Tesco" } }], "Tesco"],
    ["sorry", "How much did I spend on groceries? Sorry, eating out", [trend("Eating out", "2026-11")], "eating out"],
    ["wait", "How much did I spend on restaurants, wait, groceries", GROCERIES_NOW, "groceries"],
  ];

  it.each(CASES)("%s: only the corrected request is planned", (_, text, expected) => {
    expect(steps(text)).toEqual(expected);
  });

  it.each(CASES)("%s: the voice engine's split gives the same plan", (_, text, expected, tail) => {
    const t = buildTranscript(1, text, "");
    expect(t.snapshot).toMatchObject({ text: tail, corrected: true });
    expect(plan({ text: t.snapshot.text, replaces: t.replaces }, env()).steps).toEqual(expected);
  });

  it("is understood as groceries, with no restaurants question and not two questions", () => {
    const p = planned("How much did I spend on restaurants? Actually, groceries.");
    expect(p.understood).toBe("Groceries this month");
    expect(JSON.stringify(p)).not.toContain("Eating out");
  });
});

describe("brief 2: a correction after a pause arrives as a second utterance", () => {
  it("'actually, groceries' after 'How much did I spend on food' gives Groceries", () => {
    const p = planned("actually, groceries", after("How much did I spend on food"));
    expect(p.steps).toEqual(GROCERIES_NOW);
    expect(p.understood).toBe("Groceries this month");
    expect(p.context.subject.category).toBe("Groceries");
  });

  it("replaces the chart that was showing, and keeps its month", () => {
    expect(steps("actually, groceries", after("How much did I spend on restaurants?"))).toEqual(GROCERIES_NOW);
    expect(steps("actually, groceries", after("How much did I spend on restaurants in October?"))).toEqual([trend("Groceries", "2026-10")]);
    expect(steps("actually, groceries", after("How much did I spend on food in October"))).toEqual([trend("Groceries", "2026-10")]);
  });

  it.each([
    ["no, I meant October", "How much did I spend on groceries in September?", [trend("Groceries", "2026-10")]],
    ["sorry, eating out", "How much did I spend on groceries?", [trend("Eating out", "2026-11")]],
    ["wait, groceries", "How much did I spend on restaurants?", GROCERIES_NOW],
    ["Change that to Tesco", "Show my Sainsbury's transactions", [{ type: "navigate", to: "/account/spending", filters: { merchant: "Tesco" } }]],
  ] as [string, string, DialStep[]][])("'%s' after '%s'", (second, first, expected) => {
    expect(steps(second, after(first))).toEqual(expected);
  });

  it("after a backend answer the correction goes back with the question it corrects", () => {
    expect(steps("actually, Sainsbury's", afterBackend("How much did I spend at Tesco?"))).toEqual([
      { type: "ask", question: "actually, Sainsbury's", previousQuestion: "How much did I spend at Tesco?" },
    ]);
  });

  it("with nothing to correct it is just the fragment, with nothing invented", () => {
    expect(steps("actually, groceries")).toEqual(GROCERIES_NOW);
  });

  // components/dial/session.tsx plans a correction that arrives while the first question is still with the backend
  // with `replaces` set to that question (its context only learns a question once the answer is back).
  it("a correction spoken while the first question is still with the backend corrects that question", () => {
    expect(opensWithCorrection("actually, groceries")).toBe(true);
    expect(plan({ text: "actually, groceries", replaces: "How much did I spend on food in October" }, env()).steps).toEqual([trend("Groceries", "2026-10")]);
    expect(plan({ text: "no, I meant Tesco", replaces: "How much did I spend at Sainsbury's?" }, env()).steps).toEqual([
      { type: "ask", question: "How much did I spend at Tesco?" },
    ]);
    // A whole new question still replaces the one in flight rather than being merged into it.
    expect(plan({ text: "Actually, how much do I owe?", replaces: "How much did I spend on food" }, env()).steps).toEqual([{ type: "ask", question: "Actually, how much do I owe?" }]);
  });

  it("only an utterance that opens with a correction is treated as one", () => {
    expect(opensWithCorrection("Actually, how much do I owe?")).toBe(true);
    expect(opensWithCorrection("I actually want to see my balance")).toBe(false);
    expect(opensWithCorrection("Can I wait until next month to pay?")).toBe(false);
    expect(opensWithCorrection("actually")).toBe(false);
    expect(opensWithCorrection("How much on food? Actually, groceries")).toBe(false);
  });

  it("a whole new sentence starting 'Actually' isn't merged into anything", () => {
    expect(steps("Actually, how much do I owe?", after("How much did I spend on food"))).toEqual([{ type: "ask", question: "Actually, how much do I owe?" }]);
    expect(steps("Actually, open settings", after("How much did I spend on food"))).toEqual([{ type: "navigate", to: "/account/settings" }]);
  });

  it("'change' only counts as a correction in 'change that to': 'change my budget' is still a request", () => {
    const budget = { type: "navigate", to: "/account/spend-pause", say: expect.stringContaining("budget") };
    expect(steps("Take me to pay. Actually, change my budget")).toEqual([budget]);
    expect(steps("Open settings, then change my budget")).toEqual([{ type: "navigate", to: "/account/settings" }, budget]);
  });
});

describe("brief 3: ordinary speech isn't rewritten", () => {
  it.each(["I actually want to see my balance", "what did I actually spend in October", "show me the bus stop transactions", "Did Tesco actually charge me twice?"])(
    "%s isn't a correction",
    (text) => {
      expect(splitCorrection(text)).toBeNull();
      expect(buildTranscript(1, text, "").snapshot).toMatchObject({ text, corrected: false });
    },
  );

  it("a spoken 'actually' doesn't change what is planned", () => {
    expect(steps("I actually want to see my balance")).toEqual(steps("I want to see my balance"));
    expect(steps("I actually want to see my balance")).toEqual([{ type: "navigate", to: "/account", focus: "balance" }]);
    expect(steps("what did I actually spend in October")).toEqual([visual({ kind: "category_breakdown", months: ["2026-10"] })]);
  });

  it("the backend gets the person's own words", () => {
    expect(steps("Did Tesco actually charge me twice?")).toEqual([{ type: "ask", question: "Did Tesco actually charge me twice?" }]);
  });

  it("'bus stop' is about transport, not a stop", () => {
    expect(isStopWord("show me the bus stop transactions")).toBe(false);
    expect(steps("show me the bus stop transactions")).toEqual([{ type: "navigate", to: "/account/spending", filters: { category: "Transport" } }, trend("Transport", "2026-11")]);
  });
});

describe("brief 4: endsWithContinuation decides when to wait longer", () => {
  it.each(["How much did I spend and", "groceries or", "groceries but", "How much did I spend on", "Show my spending for", "How much did I spend at", "Show me the", "Take me to", "Food, actually", "How much on food, I mean", "um", "uh"])(
    "waits after: %s",
    (t) => {
      expect(endsWithContinuation(t)).toBe(true);
    },
  );
  it.each(["How much did I spend in October?", "How much did I spend in October", "Take me to spending", "Is this right?", "What is this charge for?", "Show me the money."])(
    "doesn't wait after: %s",
    (t) => {
      expect(endsWithContinuation(t)).toBe(false);
    },
  );
  it("a sentence that really ends on 'on' only costs a slightly longer wait, never a wrong answer", () => {
    expect(endsWithContinuation("Turn Spend Pause on")).toBe(true);
    expect(steps("Turn Spend Pause on")).toEqual(steps("Turn on Spend Pause"));
  });
});

describe("brief 5: several instructions in one utterance", () => {
  const TEXT = "Show my spending for October, compare it with September, and make the interface simpler.";

  it("gives ordered steps: spending for October, the comparison, then a display preview", () => {
    expect(steps(TEXT)).toEqual([
      { type: "navigate", to: "/account/spending", filters: { month: "2026-10" } },
      visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] }),
      { type: "preferences", actions: [{ type: "density", value: "calm" }] },
    ]);
  });

  it("segments into three parts when each stands alone", () => {
    expect(segment(TEXT, () => true)).toEqual(["Show my spending for October", "compare it with September", "make the interface simpler."]);
  });

  it("a comma only splits before an instruction that stands alone", () => {
    expect(segment("Show groceries, make", (p) => p !== "make")).toEqual(["Show groceries, make"]);
    expect(segment("Make it bigger, use more contrast", () => true)).toEqual(["Make it bigger", "use more contrast"]);
  });

  it("'groceries and eating out' stays one request", () => {
    expect(steps("groceries and eating out")).toEqual([trend("Groceries", "2026-11"), trend("Eating out", "2026-11")]);
    expect(planned("groceries and eating out").understood).toBe("Groceries this month and Eating out this month");
  });

  it("'compare October and September' stays one request", () => {
    expect(steps("compare October and September")).toEqual([visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] })]);
  });
});

describe("brief 6: follow-ups use the conversation and never invent it", () => {
  const SPENDING = "How much did I spend on groceries in October?";
  const AT_TESCO = "How much did I spend at Tesco?";

  it("'What about last month?' keeps the subject", () => {
    expect(steps("What about last month?", after("How much did I spend on groceries?"))).toEqual([trend("Groceries", "2026-10")]);
    expect(steps("What about last month?", afterBackend(AT_TESCO))).toEqual([{ type: "ask", question: "What about last month?", previousQuestion: AT_TESCO }]);
  });

  it("'Has that increased?' compares what was on screen", () => {
    expect(steps("Has that increased?", after(SPENDING))).toEqual([visual({ kind: "month_comparison", category: "Groceries", months: ["2026-10", "2026-09"] })]);
    expect(steps("Has that increased?", afterBackend(AT_TESCO))).toEqual([{ type: "ask", question: "Has that increased?", previousQuestion: AT_TESCO }]);
  });

  it("'Show me the biggest one.' is the biggest purchase in what was on screen", () => {
    expect(steps("Show me the biggest one.", after(SPENDING))).toEqual([visual({ kind: "biggest_purchases", limit: 1, category: "Groceries", months: ["2026-10"] })]);
    expect(steps("Show me the biggest one.", afterBackend(AT_TESCO))).toEqual([{ type: "ask", question: "Show me the biggest one.", previousQuestion: AT_TESCO }]);
  });

  it("'Show me the biggest one.' never drops the shop, and shows one month of a comparison", () => {
    const tescoOctober = "How much did I spend at Tesco in October?";
    expect(steps("Show me the biggest one.", afterBackend(tescoOctober))).toEqual([{ type: "ask", question: "Show me the biggest one.", previousQuestion: tescoOctober }]);
    expect(steps("Show me the biggest one.", after("Compare October with September"))).toEqual([visual({ kind: "biggest_purchases", limit: 1, months: ["2026-10"] })]);
  });

  it("'Can you explain that again?' shows the chart again, or goes back to the backend with its question", () => {
    expect(steps("Can you explain that again?", after(SPENDING))).toEqual([trend("Groceries", "2026-10")]);
    expect(steps("Can you explain that again?", afterBackend(AT_TESCO))).toEqual([{ type: "ask", question: "Can you explain that again?", previousQuestion: AT_TESCO }]);
  });

  it("'Why?' is made explicit from what was on screen", () => {
    expect(steps("Why?", after(SPENDING))).toEqual([{ type: "ask", question: "Why did my Groceries spending change from September to October?" }]);
    expect(steps("Why?", afterBackend(AT_TESCO))).toEqual([{ type: "ask", question: "Why?", previousQuestion: AT_TESCO }]);
  });

  describe("with an empty context nothing is fabricated", () => {
    const INVENTED = /Groceries|Eating out|Tesco|Transport/;
    it.each(["What about last month?", "Has that increased?", "Show me the biggest one.", "Can you explain that again?", "Why?", "Can you show me instead?"])("%s", (text) => {
      const p = planned(text);
      expect(JSON.stringify(p.steps)).not.toMatch(INVENTED);
      expect(p.context.subject.category).toBeUndefined();
      expect(p.steps.some((s) => s.type === "ask" && s.previousQuestion)).toBe(false);
    });
    it("what they become", () => {
      expect(steps("What about last month?")).toEqual([visual({ kind: "category_breakdown", months: ["2026-10"] })]);
      expect(steps("Has that increased?")).toEqual([{ type: "ask", question: "Has that increased?" }]);
      expect(steps("Why?")).toEqual([{ type: "ask", question: "Why?" }]);
      expect(steps("Can you explain that again?")).toEqual([{ type: "ask", question: "Can you explain that again?" }]);
      expect(steps("Show me the biggest one.")).toEqual([{ type: "unsupported", say: NOT_UNDERSTOOD }]);
    });
  });
});

describe("brief 7: short interruptions", () => {
  const STOP = [{ type: "control", command: "stop" }];
  const pending: DialStep = { type: "preferences", actions: [{ type: "textSize", value: 125 }] };

  it.each(["Stop.", "Cancel.", "Wait.", "Hang on."])("%s is a stop word, and plans to stop when nothing is pending", (text) => {
    expect(isStopWord(text)).toBe(true);
    expect(steps(text)).toEqual(STOP);
  });

  it("with a preview waiting, 'Cancel.' answers no and 'Wait.' stops; either way the preview is withdrawn and nothing is kept", async () => {
    expect(steps("Cancel.", { pending })).toEqual([{ type: "control", command: "no" }]);
    expect(steps("Wait.", { pending })).toEqual(STOP);
    const offer = { step: pending, description: "" };
    for (const text of ["Cancel.", "Wait."]) {
      const d = fakeRunner();
      await runSteps(steps(text, { pending }), d, offer, new AbortController().signal);
      expect(d.settle, text).toHaveBeenCalledWith(offer, false);
    }
  });

  it("'Stop reading' on its own still stops", () => {
    for (const text of ["Stop reading", "stop talking please", "please stop speaking", "Stop reading your answers out loud"]) expect(steps(text), text).toEqual(STOP);
  });

  it("'Start again.' is the reset command, which is previewed and never applied silently", async () => {
    expect(isStopWord("Start again.")).toBe(false);
    expect(interpret("Start again.")).toEqual({ kind: "control", command: "reset" });
    expect(steps("Start again.")).toEqual([{ type: "control", command: "reset" }]);
    const d = fakeRunner();
    const out = await runSteps(steps("Start again."), d, null, new AbortController().signal);
    expect(d.previewPreferences).toHaveBeenCalledWith({ type: "preferences", actions: [{ type: "reset" }] });
    expect(d.settle).not.toHaveBeenCalled();
    expect(out.offer?.step.type).toBe("preferences");
  });

  it("'how much did I spend at the bus stop' is a spending question", () => {
    const text = "how much did I spend at the bus stop";
    expect(isStopWord(text)).toBe(false);
    expect(steps(text)).toEqual([trend("Transport", "2026-11")]);
  });

  it("'stop reading long explanations' is a display preference", () => {
    const text = "stop reading long explanations";
    expect(isStopWord(text)).toBe(false);
    expect(interpret(text)).toEqual({ kind: "ui", actions: [{ type: "answerStyle", value: "brief" }] });
    expect(steps(text)).toEqual([{ type: "preferences", actions: [{ type: "answerStyle", value: "brief" }] }]);
  });

  it("'don't stop Spend Pause' isn't a stop and doesn't offer to turn it off", () => {
    const text = "don't stop Spend Pause";
    expect(isStopWord(text)).toBe(false);
    const s = steps(text);
    expect(s.some((x) => x.type === "control")).toBe(false);
    expect(JSON.stringify(s)).not.toContain("confirm=off");
  });
});

function fakeRunner(): RunnerDeps {
  const never = () => {
    throw new Error("must not be called");
  };
  return {
    mode: "simple",
    navigate: vi.fn(async () => true),
    back: vi.fn(() => true),
    previewPreferences: vi.fn(),
    previewAdapt: vi.fn(),
    previewMode: vi.fn(),
    settle: vi.fn(() => "Done."),
    control: vi.fn(() => null),
    visual: never,
    whatIf: never,
    goals: vi.fn(() => []),
    describeGoal: vi.fn(() => ""),
    ask: never,
    offline: vi.fn(() => null),
  };
}

describe("brief 8: changing the interface by voice", () => {
  const PREVIEWS: [string, DialStep][] = [
    ["Make everything bigger.", { type: "preferences", actions: [{ type: "textSize", value: 125 }] }],
    ["Use fewer numbers.", { type: "preferences", actions: [{ type: "answerStyle", value: "brief" }, { type: "density", value: "calm" }] }],
    ["I want a simpler dashboard.", { type: "preferences", actions: [{ type: "density", value: "calm" }] }],
    ["Show me more detail.", { type: "setMode", mode: "complex" }],
    ["Use voice-first mode.", { type: "preferences", actions: [{ type: "voiceFirst", value: true }] }],
    ["Stop reading long explanations.", { type: "preferences", actions: [{ type: "answerStyle", value: "brief" }] }],
    ["Go back to the simpler layout.", { type: "preferences", actions: [{ type: "density", value: "calm" }] }],
  ];

  it.each(PREVIEWS)("%s maps to an existing setting", (text, expected) => {
    expect(steps(text)).toEqual([expected]);
    expect(CONFIRMED_STEPS.has(expected.type)).toBe(true);
    expect(validateStep(expected)).toEqual(expected);
  });

  it.each(PREVIEWS)("%s is only previewed: nothing changes until 'Keep it'", async (text) => {
    const d = fakeRunner();
    const out = await runSteps(steps(text), d, null, new AbortController().signal);
    expect(out.offer).not.toBeNull();
    expect(out.items[0]).toMatchObject({ kind: "offer", text: expect.stringContaining("Do you want to keep it?") });
    expect(vi.mocked(d.previewPreferences).mock.calls.length + vi.mocked(d.previewMode).mock.calls.length).toBe(1);
    expect(d.settle).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("in Detailed view a simpler layout is Simple view, also previewed", () => {
    expect(steps("I want a simpler dashboard.", { mode: "complex" })).toEqual([{ type: "setMode", mode: "simple" }]);
    expect(steps("Go back to the simpler layout.", { mode: "complex" })).toEqual([{ type: "setMode", mode: "simple" }]);
  });

  it("'Can you show me instead?' opens the list for what was just discussed", () => {
    expect(steps("Can you show me instead?", after("How much did I spend on groceries in October?"))).toEqual([
      { type: "navigate", to: "/account/spending", filters: { category: "Groceries", month: "2026-10" } },
    ]);
    expect(steps("Can you show me instead?", after("How much did I spend at Tesco?"))).toEqual([{ type: "navigate", to: "/account/spending", filters: { merchant: "Tesco" } }]);
    expect(steps("Can you show me instead?")).toEqual([{ type: "ask", question: "Can you show me instead?" }]);
  });

  it("'Explain that more simply.' changes nothing and is asked as a question", () => {
    expect(steps("Explain that more simply.")).toEqual([{ type: "ask", question: "Explain that more simply." }]);
    const ctx = afterBackend("How much did I spend at Tesco?");
    expect(steps("Explain that more simply.", ctx)).toEqual([{ type: "ask", question: "Explain that more simply.", previousQuestion: "How much did I spend at Tesco?" }]);
  });
  // lib/dial/plan.ts: after a chart built on the device there is no lastQuestion, so the backend isn't told what "that"
  // is. Deciding between re-explaining and offering plainer explanations needs a product decision, and /api/ask
  // (lib/ai) would need the chart as context.
  it.todo("'Explain that more simply.' after a chart re-explains that chart in plainer words");

  it("nothing said here can pay, change Spend Pause or move money", () => {
    const said = [...PREVIEWS.map(([t]) => t), "Can you show me instead?", "Explain that more simply.", "Stop.", "Cancel.", "Wait.", "Start again.", "don't stop Spend Pause"];
    for (const context of [{}, after("How much did I spend on groceries in October?")]) {
      for (const text of said) {
        for (const s of steps(text, context)) {
          expect(validateStep(s), text).toEqual(s);
          expect(s.type, text).not.toBe("goal");
          const json = JSON.stringify(s);
          expect(json, text).not.toMatch(/account\/pay|spend-pause/);
        }
      }
    }
  });
});
