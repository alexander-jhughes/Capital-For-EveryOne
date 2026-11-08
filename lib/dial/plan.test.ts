import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { paymentReply } from "../payments/dial";
import { spendPauseReply } from "../spend-pause/dial";
import type { SpendPauseSettings } from "../types";
import { plan, type PlanEnvWithTransactions } from "./plan";
import { PAY_NOTE, validateStep } from "./registry";
import { EMPTY_CONTEXT, type DialContext, type DialStep } from "./types";

const SETTINGS: SpendPauseSettings = { enabled: false, singlePurchaseThreshold: null, monthlyBudget: 50000, quietHours: null };

/** The demo account as the runner would describe it, with the real Pay and Spend Pause answers. */
function env(context: Partial<DialContext> = {}, extra: Partial<PlanEnvWithTransactions> = {}): PlanEnvWithTransactions {
  return {
    context: { ...EMPTY_CONTEXT, ...context },
    textSize: 100,
    merchants: [...new Set(SEED_TRANSACTIONS.map((t) => t.merchant))],
    transactionIds: SEED_TRANSACTIONS.map((t) => t.id),
    months: ["2026-09", "2026-10", "2026-11"],
    today: "2026-11-08",
    transactions: SEED_TRANSACTIONS,
    localReply: (text) => {
      const sp = spendPauseReply(text, SETTINGS, { activatedAt: null, deactivatedAt: null });
      if (sp) return sp.action ? { text: sp.text, link: { label: sp.action.label, href: sp.action.href } } : { text: sp.text };
      const p = paymentReply(text, { account: SEED_ACCOUNT, transactions: SEED_TRANSACTIONS, payments: [] });
      return p ? { text: p } : null;
    },
    ...extra,
  };
}

const steps = (text: string, context: Partial<DialContext> = {}, extra: Partial<PlanEnvWithTransactions> = {}) => plan({ text }, env(context, extra)).steps;
const one = (text: string, context: Partial<DialContext> = {}) => {
  const s = steps(text, context);
  expect(s, `${text}: ${JSON.stringify(s)}`).toHaveLength(1);
  return s[0];
};

const prefs = (...actions: object[]) => [{ type: "preferences", actions }];
const nav = (to: string, more: object = {}) => [{ type: "navigate", to, ...more }];
const visual = (request: object) => ({ type: "visual", request });

// Every example from the brief, with exactly the steps it should produce (simple view, nothing pending).
const EXAMPLES: [string, unknown[]][] = [
  // Display preferences and view
  ["Make everything bigger", prefs({ type: "textSize", value: 125 })],
  ["Use fewer numbers", prefs({ type: "answerStyle", value: "brief" }, { type: "density", value: "calm" })],
  ["Show me more detail", [{ type: "setMode", mode: "complex" }]],
  ["Simplify my dashboard", prefs({ type: "density", value: "calm" })],
  ["Switch to voice-first mode", prefs({ type: "voiceFirst", value: true })],
  ["larger buttons", prefs({ type: "targets", value: "large" })],
  ["high contrast", prefs({ type: "contrast", value: "high" })],
  ["reduce motion", prefs({ type: "motion", value: "reduced" })],
  ["step by step", prefs({ type: "explanations", value: "stepByStep" })],
  ["shorter explanations", prefs({ type: "answerStyle", value: "brief" })],
  ["Make this easier to understand", prefs({ type: "density", value: "calm" }, { type: "explanations", value: "stepByStep" })],
  // Navigation, to real routes only
  ["Take me to my spending", nav("/account/spending")],
  ["Show me my transactions", nav("/account/spending")],
  ["Go back to the dashboard", nav("/account")],
  ["go back", [{ type: "back" }]],
  ["previous page", [{ type: "back" }]],
  ["open payments", nav("/account/pay", { say: PAY_NOTE })],
  ["I want to pay my bill", nav("/account/pay", { say: PAY_NOTE })],
  ["credit information", nav("/account", { focus: "balance" })],
  ["my credit limit", nav("/account", { focus: "balance" })],
  ["budgets", nav("/account", { focus: "budget", say: "Your monthly budget is set in Spend Pause." })],
  ["financial insights", nav("/account", { focus: "insights" })],
  ["What has Dial noticed?", nav("/account", { focus: "insights" })],
  ["settings", nav("/account/settings")],
  ["accessibility preferences", nav("/account/settings")],
  ["display and voice", nav("/account/settings")],
  ["personalise", nav("/account/personalise")],
  ["make it mine", nav("/account/personalise")],
  ["spend pause", nav("/account/spend-pause")],
  ["goals", nav("/account/goals")],
  ["my savings goal", nav("/account/goals")],
  ["Open the Argos transaction", nav("/account/spending", { filters: { txn: "t060" } })],
  ["transaction t012", nav("/account/spending", { filters: { txn: "t012" } })],
  ["Show my Tesco transactions", nav("/account/spending", { filters: { merchant: "Tesco" } })],
  // A list and a chart together
  [
    "Show my groceries spending for October",
    [...nav("/account/spending", { filters: { category: "Groceries", month: "2026-10" } }), visual({ kind: "category_trend", category: "Groceries", months: ["2026-10"] })],
  ],
  // Visual questions, answered on the device
  ["Where does most of my money go?", [visual({ kind: "category_breakdown" })]],
  ["How has my spending changed?", [visual({ kind: "month_comparison", months: ["2026-11", "2026-10"] })]],
  ["Show me my biggest purchases", [visual({ kind: "biggest_purchases", limit: 5 })]],
  ["Show me the biggest expense", [visual({ kind: "biggest_purchases", limit: 1 })]],
  ["How much budget do I have left?", [visual({ kind: "budget_progress" })]],
  ["Compare my spending across the last three months", [visual({ kind: "monthly_trend", months: ["2026-09", "2026-10", "2026-11"] })]],
  ["Compare October with September", [visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] })]],
  ["How much did I spend on groceries this month?", [visual({ kind: "category_trend", category: "Groceries", months: ["2026-11"] })]],
  ["How much did I spend on groceries in October?", [visual({ kind: "category_trend", category: "Groceries", months: ["2026-10"] })]],
  ["How much did I spend on groceries?", [visual({ kind: "category_trend", category: "Groceries", months: ["2026-11"] })]],
  // What-ifs
  ["What if I spend £100 less next month?", [{ type: "whatIf", scenario: { kind: "spend_less", amount: 10000 } }]],
  ["What if I spend £100 less on eating out next month?", [{ type: "whatIf", scenario: { kind: "spend_less", amount: 10000, category: "Eating out" } }]],
  ["Could I save £500 by January?", [{ type: "whatIf", scenario: { kind: "save_by", target: 50000, by: "2027-01" } }]],
  ["What if I paid £200 a month off my card?", [{ type: "whatIf", scenario: { kind: "pay_monthly", amount: 20000 } }]],
  // Goals
  ["Set a goal to save £500 by January", [{ type: "goal", op: "create", spec: { kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-10" } }]],
  ["I want to spend less than £80 on eating out each month", [{ type: "goal", op: "create", spec: { kind: "category_cap", category: "Eating out", monthlyLimit: 8000 } }]],
  ["Help me stay within my budget", [{ type: "goal", op: "create", spec: { kind: "stay_in_budget" } }]],
  ["Show my goals", nav("/account/goals")],
  // Pay and Spend Pause, from live state
  ["Is Spend Pause on?", [{ type: "local", text: "Spend Pause is off.", link: { label: "Open Spend Pause", href: "/account/spend-pause" } }]],
  ["Did my payment change my spending?", [{ type: "local", text: "No. Payments aren't spending, so they don't change your spending total. You've spent £402.35 this month." }]],
  // Open questions go to the backend
  ["Is my spending OK?", [{ type: "ask", question: "Is my spending OK?" }]],
  ["Explain my statement", [{ type: "ask", question: "Explain my statement" }]],
];

describe("plan: the brief's examples", () => {
  it.each(EXAMPLES)("%s", (text, expected) => {
    expect(steps(text)).toEqual(expected);
  });
});

// Other natural ways of saying the same things.
const MORE: [string, unknown][] = [
  ["Take me home", nav("/account")],
  ["Where can I find settings?", nav("/account/settings")],
  ["Show me my bill", nav("/account", { focus: "bill" })],
  ["Show me my balance", nav("/account", { focus: "balance" })],
  ["Anything I should know?", nav("/account", { focus: "insights" })],
  ["Open Sainsburys", nav("/account/spending", { filters: { merchant: "Sainsbury's" } })],
  ["Open the chart", nav("/account", { focus: "chart" })],
  ["How are my goals doing?", nav("/account/goals")],
  ["How much did I spend last month?", [visual({ kind: "category_breakdown", months: ["2026-10"] })]],
  ["What did I spend this month?", [visual({ kind: "category_breakdown", months: ["2026-11"] })]],
  ["How much did I spend between September and November?", [visual({ kind: "category_breakdown", months: ["2026-09", "2026-10", "2026-11"] })]],
  ["How much did I spend in October compared to September?", [visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] })]],
  ["Has my eating out gone up?", [visual({ kind: "month_comparison", category: "Eating out", months: ["2026-11", "2026-10"] })]],
  ["Is my spending going up?", [visual({ kind: "month_comparison", months: ["2026-11", "2026-10"] })]],
  ["What was my biggest purchase in October?", [visual({ kind: "biggest_purchases", limit: 1, months: ["2026-10"] })]],
  ["Show me my spending month by month", [visual({ kind: "monthly_trend" })]],
  ["Am I within my budget?", [visual({ kind: "budget_progress" })]],
  ["What if I cut my eating out by £50?", [{ type: "whatIf", scenario: { kind: "spend_less", amount: 5000, category: "Eating out" } }]],
  ["If I paid £150 a month, how long would it take to clear my card?", [{ type: "whatIf", scenario: { kind: "pay_monthly", amount: 15000 } }]],
  ["Keep my takeaways under £60 a month", [{ type: "goal", op: "create", spec: { kind: "category_cap", category: "Eating out", monthlyLimit: 6000 } }]],
  ["My goal is to spend less than £300 on groceries each month", [{ type: "goal", op: "create", spec: { kind: "category_cap", category: "Groceries", monthlyLimit: 30000 } }]],
  ["Show me more detail and take me to spending", [{ type: "setMode", mode: "complex" }, ...nav("/account/spending")]],
  ["Read this page aloud", [{ type: "control", command: "readPage" }]],
  // Prices, shops and judgements need the backend's checks
  ["Have my subscriptions gone up?", [{ type: "ask", question: "Have my subscriptions gone up?" }]],
  ["How much did I spend at Tesco?", [{ type: "ask", question: "How much did I spend at Tesco?" }]],
  ["Did I pay Tesco twice this month?", [{ type: "ask", question: "Did I pay Tesco twice this month?" }]],
  ["Should I spend less on eating out?", [{ type: "ask", question: "Should I spend less on eating out?" }]],
  ["Can you help me understand my bill?", [{ type: "ask", question: "Can you help me understand my bill?" }]],
];

describe("plan: more phrasings", () => {
  it.each(MORE)("%s", (text, expected) => {
    expect(steps(text)).toEqual(expected);
  });
});

describe("plan: view-aware display commands", () => {
  it("'Make this easier to understand' in Detailed view switches to Simple view", () => {
    expect(steps("Make this easier to understand", { mode: "complex" })).toEqual([{ type: "setMode", mode: "simple" }]);
  });
  it("'Simplify my dashboard' in Detailed view switches to Simple view; in Simple view it shows less", () => {
    expect(steps("Simplify my dashboard", { mode: "complex" })).toEqual([{ type: "setMode", mode: "simple" }]);
    expect(steps("Simplify my dashboard", { mode: "simple" })).toEqual(prefs({ type: "density", value: "calm" }));
  });
  it("layout words win over Spend Pause, and Spend Pause words win over hiding a section", () => {
    expect(one("Hide Spend Pause on the home screen")).toEqual({ type: "preferences", actions: [{ type: "hide", widget: "pause" }] });
    expect(one("Turn off Spend Pause").type).toBe("local");
    expect(one("Turn on Spend Pause")).toMatchObject({ type: "local", link: { href: "/account/spend-pause?confirm=on" } });
  });
  it("a ranking is not a layout change", () => {
    expect(one("Show me my top 3 purchases")).toEqual(visual({ kind: "biggest_purchases", limit: 3 }));
  });
});

describe("plan: navigation", () => {
  it("never invents a route", () => {
    for (const text of ["Open my mortgage", "Take me to my pension", "Go to my savings account", "Navigate to the casino"]) {
      const s = one(text);
      expect(s.type, text).toBe("unsupported");
      expect((s as { say: string }).say).toMatch(/I can open Home, Spending, Pay/);
    }
  });
  it("paying always opens Pay and never pays", () => {
    for (const text of ["Pay my bill", "Pay £50 now", "How do I pay my bill?", "Make a payment", "Take me to pay"]) expect(one(text), text).toMatchObject({ type: "navigate", to: "/account/pay" });
  });
  it("the budget is changed in Spend Pause", () => {
    expect(one("Change my budget")).toMatchObject({ type: "navigate", to: "/account/spend-pause" });
    expect(one("Reset my budget")).toMatchObject({ type: "navigate", to: "/account/spend-pause" });
  });
  it("shop and transaction filters", () => {
    expect(one("Show me my Deliveroo transactions in October")).toEqual({ type: "navigate", to: "/account/spending", filters: { merchant: "Deliveroo", month: "2026-10" } });
    expect(one("Open my biggest purchase")).toEqual({ type: "navigate", to: "/account/spending", filters: { sort: "highest" } });
    expect(one("Show me October")).toEqual({ type: "navigate", to: "/account/spending", filters: { month: "2026-10" } });
    expect(one("Open transaction t999")).toMatchObject({ type: "unsupported", say: expect.stringContaining("t999") });
  });
  it("a shop with several purchases opens the shop's list; without transaction details, any shop does", () => {
    expect(one("Open the Amazon purchase")).toEqual({ type: "navigate", to: "/account/spending", filters: { merchant: "Amazon" } });
    expect(steps("Open the Argos transaction", {}, { transactions: undefined })).toEqual(nav("/account/spending", { filters: { merchant: "Argos" } }));
  });
  it("a different business that shares a name is not the shop", () => {
    expect(one("Show my Tesco Mobile transactions")).toMatchObject({ type: "unsupported", say: expect.stringContaining("Tesco Mobile") });
    expect(one("Show my Lidl transactions")).toMatchObject({ type: "unsupported", say: expect.stringContaining("Lidl") });
  });
});

describe("plan: what-ifs and goals never invent a number", () => {
  it.each([
    ["What if I spend less next month?", /How much/],
    ["Could I save 500 pounds?", /By when/],
    ["Could I save some money by January?", /How much/],
    ["What if I paid more off my card each month?", /How much a month/],
    ["Set a goal", /What would you like your goal to be/],
    ["I want to spend less on eating out each month", /How much a month/],
    ["What if I spend £100 more?", /three kinds of what-if/],
    ["What if I spend £250,000 less?", /under £100,000/],
  ])("%s", (text, say) => {
    expect(one(text)).toMatchObject({ type: "unsupported", say: expect.stringMatching(say) });
  });
  it("reads amounts in words and with pence", () => {
    expect(one("What if I spend a hundred pounds less on takeaways?")).toEqual({ type: "whatIf", scenario: { kind: "spend_less", amount: 10000, category: "Eating out" } });
    expect(one("I want to save £1,250.50 by Christmas")).toEqual({ type: "goal", op: "create", spec: { kind: "spend_reduction", target: 125050, by: "2026-12", baselineMonth: "2026-10" } });
  });
  it("delete needs the goal, so it opens Goals with a plain instruction", () => {
    expect(one("Delete my eating out goal")).toMatchObject({ type: "navigate", to: "/account/goals", say: expect.stringContaining("Remove") });
  });
});

describe("plan: 'food' is never guessed", () => {
  it("a spending question shows both groceries and eating out", () => {
    expect(steps("How much did I spend on food?")).toEqual([
      visual({ kind: "category_trend", category: "Groceries", months: ["2026-11"] }),
      visual({ kind: "category_trend", category: "Eating out", months: ["2026-11"] }),
    ]);
    expect(plan({ text: "How much did I spend on food in October?" }, env()).understood).toBe("Food (groceries and eating out) in October");
  });
  it("opening Spending for food doesn't filter to one of them, and says why", () => {
    const s = steps("Show my food spending");
    expect(s[0]).toEqual({ type: "navigate", to: "/account/spending", say: expect.stringContaining("groceries and eating out") });
    expect(s.slice(1).map((x) => (x as { request: { category: string } }).request.category)).toEqual(["Groceries", "Eating out"]);
  });
  it("a goal or what-if asks which one", () => {
    expect(one("I want to spend less than £100 on food each month")).toMatchObject({ type: "unsupported", say: expect.stringContaining("groceries or eating out") });
    expect(one("What if I spend £50 less on food?")).toMatchObject({ type: "unsupported", say: expect.stringContaining("groceries or eating out") });
  });
  it("leaves no single subject behind, so 'why is that higher?' isn't pinned on one of them", () => {
    const p = plan({ text: "How much did I spend on food?" }, env({ subject: { category: "Transport" } }));
    expect(p.context.lastVisual).toBeNull();
    expect(p.context.subject.category).toBeUndefined();
  });
  it("supermarket words are groceries and takeaway words are eating out", () => {
    expect(one("How much did I spend on food shopping?")).toMatchObject({ request: { category: "Groceries" } });
    expect(one("How much did I spend at the supermarket last month?")).toMatchObject({ request: { category: "Groceries", months: ["2026-10"] } });
    expect(one("How much did I spend on takeaways?")).toMatchObject({ request: { category: "Eating out" } });
    expect(one("How much did I spend on the tube in October?")).toMatchObject({ request: { category: "Transport", months: ["2026-10"] } });
    expect(one("How much did I spend on trains?")).toMatchObject({ request: { category: "Travel" } });
  });
});

describe("plan: self-correction", () => {
  it("a fragment replaces the same slot", () => {
    expect(steps("How much did I spend on food? Actually, groceries.")).toEqual(steps("How much did I spend on groceries?"));
    expect(steps("How much did I spend on food? Actually, groceries.")).toEqual([visual({ kind: "category_trend", category: "Groceries", months: ["2026-11"] })]);
    expect(steps("Take me to pay, no wait, spending")).toEqual(nav("/account/spending"));
    expect(steps("Show October. No, I mean September")).toEqual(nav("/account/spending", { filters: { month: "2026-09" } }));
    expect(steps("Show my Tesco transactions, actually Sainsbury's")).toEqual(nav("/account/spending", { filters: { merchant: "Sainsbury's" } }));
    expect(steps("What if I spend £100 less, actually £50")).toEqual([{ type: "whatIf", scenario: { kind: "spend_less", amount: 5000 } }]);
    expect(steps("Show my groceries spending for October, I mean September")[1]).toEqual(visual({ kind: "category_trend", category: "Groceries", months: ["2026-09"] }));
  });
  it("a whole request replaces what came before", () => {
    expect(steps("Open settings, scratch that, open goals")).toEqual(nav("/account/goals"));
    expect(steps("How much did I spend on food? Actually, make the text bigger")).toEqual(prefs({ type: "textSize", value: 125 }));
  });
  it("uses the voice engine's split when it already made one", () => {
    expect(plan({ text: "groceries", replaces: "How much did I spend on food?" }, env()).steps).toEqual([visual({ kind: "category_trend", category: "Groceries", months: ["2026-11"] })]);
    expect(plan({ text: "open my goals", replaces: "Take me to pay" }, env()).steps).toEqual(nav("/account/goals"));
    expect(plan({ text: "spending", replaces: "Take me to pay" }, env()).steps).toEqual(nav("/account/spending"));
  });
  it("only the corrected request is understood", () => {
    expect(plan({ text: "How much did I spend on groceries in October? Actually, September" }, env()).understood).toBe("Groceries in September");
    expect(plan({ text: "Show my groceries for October. Actually, September" }, env()).understood).toBe("Open Spending: Groceries in September, with a chart");
  });
});

describe("plan: several instructions at once", () => {
  it("splits on 'and then', 'then' and sentence ends when every part stands alone", () => {
    expect(steps("Show my groceries spending for October and then take me to settings")).toEqual([
      ...nav("/account/spending", { filters: { category: "Groceries", month: "2026-10" } }),
      visual({ kind: "category_trend", category: "Groceries", months: ["2026-10"] }),
      ...nav("/account/settings"),
    ]);
    expect(steps("Take me to spending. Then show me my biggest purchases")).toEqual([...nav("/account/spending"), visual({ kind: "biggest_purchases", limit: 5 })]);
  });
  it("does not split a single request", () => {
    expect(steps("How much did I spend on groceries and eating out?")).toEqual([
      visual({ kind: "category_trend", category: "Groceries", months: ["2026-11"] }),
      visual({ kind: "category_trend", category: "Eating out", months: ["2026-11"] }),
    ]);
    expect(steps("Compare October and September")).toEqual([visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] })]);
    expect(steps("Compare October, and September")).toEqual([visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] })]);
  });
  it("joins display changes into one preview", () => {
    expect(steps("Make the text bigger. Use more contrast.")).toEqual(prefs({ type: "textSize", value: 125 }, { type: "contrast", value: "high" }));
    expect(steps("Hide the chart and put my bill at the top")).toEqual(prefs({ type: "hide", widget: "chart" }, { type: "moveToTop", widget: "bill" }));
  });
  it("stops at four steps and says what it left out", () => {
    const s = steps("Take me to spending, then show my biggest purchases, then open settings, then show my goals, then open pay");
    expect(s).toHaveLength(4);
    expect(s.slice(0, 3).map((x) => x.type)).toEqual(["navigate", "visual", "navigate"]);
    expect(s[3]).toEqual({ type: "unsupported", say: expect.stringContaining('"show my goals", "open pay"') });
  });
});

describe("plan: follow-ups from context", () => {
  const groceriesOctober = { subject: { category: "Groceries" as const, months: ["2026-10"] }, lastVisual: { kind: "category_trend" as const, category: "Groceries" as const, months: ["2026-10"] } };
  const groceriesNow = { subject: { category: "Groceries" as const }, lastVisual: { kind: "category_trend" as const, category: "Groceries" as const, months: ["2026-11"] } };

  it("'What about eating out?' keeps the chart and the month", () => {
    expect(steps("What about eating out?", groceriesOctober)).toEqual([visual({ kind: "category_trend", category: "Eating out", months: ["2026-10"] })]);
  });
  it("'and last month?' and 'what about September?' change the month", () => {
    expect(steps("and last month?", groceriesNow)).toEqual([visual({ kind: "category_trend", category: "Groceries", months: ["2026-10"] })]);
    expect(steps("What about September?", groceriesOctober)).toEqual([visual({ kind: "category_trend", category: "Groceries", months: ["2026-09"] })]);
    const compared = { lastVisual: { kind: "month_comparison" as const, months: ["2026-11", "2026-10"] } };
    expect(steps("what about October?", compared)).toEqual([visual({ kind: "month_comparison", months: ["2026-10", "2026-09"] })]);
  });
  it("'show it as a list' and 'show me those transactions' open Spending with the subject", () => {
    expect(steps("Show it as a list", groceriesOctober)).toEqual(nav("/account/spending", { filters: { category: "Groceries", month: "2026-10" } }));
    expect(steps("Show me those transactions", groceriesOctober)).toEqual(nav("/account/spending", { filters: { category: "Groceries", month: "2026-10" } }));
    expect(steps("Show me those transactions", { lastVisual: { kind: "biggest_purchases", limit: 5 } })).toEqual(nav("/account/spending", { filters: { sort: "highest" } }));
  });
  it("'Why is that higher?' is made explicit from what was on screen", () => {
    const ctx = { ...groceriesOctober, lastQuestion: "How much did I spend on groceries?" };
    expect(steps("Why is that higher?", ctx)).toEqual([
      { type: "ask", question: "Why was my Groceries spending higher in October than September?", previousQuestion: "How much did I spend on groceries?" },
    ]);
    expect(steps("Why did it go up?", { lastVisual: { kind: "month_comparison", months: ["2026-10", "2026-09"] } })).toEqual([
      { type: "ask", question: "Why was my spending higher in October than September?" },
    ]);
    expect(steps("Why is that lower?", groceriesNow)).toEqual([{ type: "ask", question: "Why is my Groceries spending lower in November than October?" }]);
  });
  it("never invents context: no subject means the plain question", () => {
    expect(steps("Why is that higher?")).toEqual([{ type: "ask", question: "Why is that higher?" }]);
    expect(steps("Why is that higher?", { lastQuestion: "What did I spend?" })).toEqual([{ type: "ask", question: "Why is that higher?", previousQuestion: "What did I spend?" }]);
    // September is the first month with data, so there is no earlier month to compare it with.
    expect(steps("Why is that higher?", { lastVisual: { kind: "category_trend", category: "Groceries", months: ["2026-09"] } })).toEqual([
      { type: "ask", question: "Why was my Groceries spending so high in September?" },
    ]);
  });
  it("after an answer from the backend, an elliptical follow-up goes back with previousQuestion", () => {
    expect(steps("What about Argos?", { lastQuestion: "How much did I spend at Tesco last month?" })).toEqual([
      { type: "ask", question: "What about Argos?", previousQuestion: "How much did I spend at Tesco last month?" },
    ]);
  });
  it("a whole conversation, with the context carried between turns", () => {
    let e = env();
    const say = (text: string) => {
      const p = plan({ text }, e);
      e = { ...e, context: p.context };
      return p;
    };
    expect(say("How much did I spend on groceries in October?").context).toMatchObject({ subject: { category: "Groceries", months: ["2026-10"] } });
    expect(say("What about eating out?").steps).toEqual([visual({ kind: "category_trend", category: "Eating out", months: ["2026-10"] })]);
    expect(e.context.subject).toEqual({ category: "Eating out", months: ["2026-10"] });
    expect(say("What about September?").steps).toEqual([visual({ kind: "category_trend", category: "Eating out", months: ["2026-09"] })]);
    expect(say("Show me those transactions").steps).toEqual(nav("/account/spending", { filters: { category: "Eating out", month: "2026-09" } }));
    expect(e.context.route).toBe("/account/spending");
    // A display change names nothing, so the subject stays.
    say("Make everything bigger");
    expect(e.context.subject).toEqual({ category: "Eating out", months: ["2026-09"] });
  });
  it("yes and no answer whatever is pending, and only that", () => {
    const pending: DialStep = { type: "goal", op: "create", spec: { kind: "stay_in_budget" } };
    expect(steps("Yes please", { pending })).toEqual([{ type: "control", command: "yes" }]);
    expect(steps("No thanks", { pending })).toEqual([{ type: "control", command: "no" }]);
    expect(one("Yes")).toMatchObject({ type: "unsupported" });
    expect(plan({ text: "yes" }, env({ pending })).context.pending).toEqual(pending);
  });
});

describe("plan: context, understood and local", () => {
  it("names only what the person said", () => {
    const p = plan({ text: "Show my Tesco transactions" }, env({ subject: { category: "Groceries", months: ["2026-10"] } }));
    expect(p.context.subject).toEqual({ merchant: "Tesco" });
    expect(plan({ text: "Open settings" }, env({ subject: { category: "Groceries" } })).context.subject).toEqual({ category: "Groceries" });
  });
  it("records the last chart, and an asked question moves on from it", () => {
    expect(plan({ text: "Where does most of my money go?" }, env()).context.lastVisual).toEqual({ kind: "category_breakdown" });
    expect(plan({ text: "Is my spending OK?" }, env({ lastVisual: { kind: "category_breakdown" } })).context.lastVisual).toBeNull();
  });
  it("never sets lastQuestion or pending itself", () => {
    const p = plan({ text: "Is my spending OK?" }, env({ lastQuestion: "earlier" }));
    expect(p.context.lastQuestion).toBe("earlier");
    expect(p.context.pending).toBeNull();
  });
  it.each([
    ["Show my groceries spending for October", "Open Spending: Groceries in October, with a chart"],
    ["How much did I spend on groceries in October?", "Groceries in October"],
    ["Take me to my spending", "Open Spending"],
    ["Compare October with September", "October compared with September"],
    ["Could I save £500 by January?", "What if: save £500 by January 2027"],
    ["Make everything bigger", "Make the text 125% of the standard size"],
    ["Is my spending OK?", "Is my spending OK?"],
    ["Show me my biggest purchases, then open settings", "Your 5 biggest purchases, then Open Settings"],
  ])("understood: %s", (text, understood) => {
    expect(plan({ text }, env()).understood).toBe(understood);
  });
  it("local is true exactly when there is no ask step", () => {
    expect(plan({ text: "Take me to my spending" }, env()).local).toBe(true);
    expect(plan({ text: "Is my spending OK?" }, env()).local).toBe(false);
  });
  it("works without local replies", () => {
    expect(steps("Is Spend Pause on?", {}, { localReply: undefined })).toEqual([{ type: "ask", question: "Is Spend Pause on?" }]);
  });
  it("is deterministic", () => {
    for (const [text] of EXAMPLES) expect(plan({ text }, env())).toEqual(plan({ text }, env()));
  });
  it("months without data are said plainly", () => {
    expect(one("How much did I spend in December?")).toEqual({ type: "unsupported", say: "I only have spending from September to November." });
  });
  it("cannot be talked into anything outside the allowlist", () => {
    expect(steps("pay my bill of £486.20 now and delete my account")).toEqual(nav("/account/pay", { say: PAY_NOTE }));
    expect(steps("What is <script>alert(1)</script> my balance?")).toEqual([{ type: "ask", question: "What is script alert(1) /script my balance?" }]);
  });
  it("empty input and nonsense are unsupported, never guessed", () => {
    expect(one("")).toMatchObject({ type: "unsupported" });
    expect(one("   ")).toMatchObject({ type: "unsupported" });
    expect(one("banana")).toMatchObject({ type: "unsupported" });
  });
});

// Every utterance used anywhere above, plus some awkward ones.
const ALL_UTTERANCES = [
  ...EXAMPLES.map(([t]) => t),
  ...MORE.map(([t]) => t),
  "Make this easier to understand",
  "Open my mortgage",
  "Pay £50 now",
  "Change my budget",
  "What if I spend £250,000 less?",
  "How much did I spend on food?",
  "Show my food spending",
  "Take me to spending, then show my biggest purchases, then open settings, then show my goals, then open pay",
  "pay my bill of £486.20 now and delete my account",
  "<script>alert(1)</script>",
  "Open transaction t999",
  "a".repeat(2000),
  "Show my Tesco Mobile transactions",
  "Why is that higher?",
  "And last month?",
  "What about Argos?",
  "Show it as a list",
  "How much did I spend in December?",
  "Could I save £500 by May?",
  "What if I paid £99,999.99 a month off my card?",
  "Show me my 7 biggest purchases in October",
];

describe("plan: every step passes validateStep", () => {
  const contexts: Partial<DialContext>[] = [
    {},
    { mode: "complex" },
    { subject: { category: "Groceries", months: ["2026-10"] }, lastVisual: { kind: "category_trend", category: "Groceries", months: ["2026-10"] }, lastQuestion: "How much on groceries?" },
    { lastVisual: { kind: "month_comparison", months: ["2026-11", "2026-10"] }, pending: { type: "back" } },
  ];
  it.each(contexts.map((c, i) => [i, c] as const))("context %i", (_, ctx) => {
    for (const text of ALL_UTTERANCES) {
      const p = plan({ text }, env(ctx));
      expect(p.steps.length, text).toBeGreaterThan(0);
      expect(p.steps.length, text).toBeLessThanOrEqual(4);
      for (const s of p.steps) expect(validateStep(s), `${text}: ${JSON.stringify(s)}`).toEqual(s);
      expect(p.local).toBe(!p.steps.some((s) => s.type === "ask"));
    }
  });
});

describe("plan: token efficiency", () => {
  // Common commands that must never cost a backend call.
  const COMMANDS = [
    "Make everything bigger",
    "Make the text smaller",
    "Use more contrast",
    "Turn off the animations",
    "Use fewer numbers",
    "Shorter explanations",
    "Explain things step by step",
    "Switch to voice-first mode",
    "Switch to simple view",
    "Show me more detail",
    "Simplify my dashboard",
    "Put my bill at the top",
    "Hide the spending chart",
    "Take me to my spending",
    "Show me my transactions",
    "Go back",
    "Go back to the dashboard",
    "Open settings",
    "Open payments",
    "I want to pay my bill",
    "Open Spend Pause",
    "Show my goals",
    "Personalise the app",
    "What has Dial noticed?",
    "Show my Tesco transactions",
    "Open transaction t012",
    "Where does most of my money go?",
    "How has my spending changed?",
    "Show me my biggest purchases",
    "How much budget do I have left?",
    "Compare October with September",
    "Compare my spending across the last three months",
    "How much did I spend on groceries this month?",
    "What did I spend this month?",
    "What if I spend £100 less next month?",
    "Could I save £500 by January?",
    "Set a goal to save £500 by January",
    "Is Spend Pause on?",
    "Stop",
    "Undo that",
    "Read my balance",
    "What can I say?",
  ];
  it("has about forty commands", () => expect(COMMANDS.length).toBeGreaterThanOrEqual(40));
  it.each(COMMANDS)("%s needs no backend", (text) => {
    const p = plan({ text }, env());
    expect(p.steps.some((s) => s.type === "ask"), JSON.stringify(p.steps)).toBe(false);
    expect(p.local).toBe(true);
  });
});
