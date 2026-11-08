import { describe, expect, it } from "vitest";
import { ROUTE_INFO, SECTION_INFO, stepHref, validateStep } from "./registry";
import { DIAL_ROUTES, HOME_SECTIONS, type DialStep } from "./types";

const VALID: DialStep[] = [
  { type: "navigate", to: "/account/spending", filters: { category: "Groceries", month: "2026-10", merchant: "Sainsbury's", txn: "t012", sort: "highest", highlight: ["t001"] } },
  { type: "navigate", to: "/account", focus: "balance", say: "Here's your balance." },
  { type: "navigate", to: "/account/goals" },
  { type: "back" },
  { type: "setMode", mode: "simple" },
  {
    type: "preferences",
    actions: [
      { type: "textSize", value: 150 },
      { type: "contrast", value: "high" },
      { type: "voiceFirst", value: false },
      { type: "density", value: "calm" },
      { type: "answerStyle", value: "brief" },
      { type: "moveToTop", widget: "bill" },
      { type: "clearEmphasis" },
      { type: "reset" },
    ],
  },
  { type: "control", command: "readBalance" },
  { type: "visual", request: { kind: "month_comparison", months: ["2026-10", "2026-09"], category: "Eating out" } },
  { type: "visual", request: { kind: "biggest_purchases", limit: 10 } },
  { type: "whatIf", scenario: { kind: "spend_less", amount: 10000, category: "Groceries" } },
  { type: "whatIf", scenario: { kind: "save_by", target: 50000, by: "2027-01" } },
  { type: "whatIf", scenario: { kind: "pay_monthly", amount: 9_999_999 } },
  { type: "goal", op: "create", spec: { kind: "category_cap", category: "Eating out", monthlyLimit: 8000 } },
  { type: "goal", op: "create", spec: { kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-10" } },
  { type: "goal", op: "create", spec: { kind: "stay_in_budget" } },
  { type: "goal", op: "remove", goalId: "goal-1" },
  { type: "goal", op: "list" },
  { type: "local", text: "Spend Pause is off.", link: { label: "Turn on Spend Pause", href: "/account/spend-pause?confirm=on" } },
  { type: "ask", question: "Is my spending OK?", previousQuestion: "What did I spend?" },
  { type: "unsupported", say: "I can't open that." },
];

describe("validateStep", () => {
  it.each(VALID.map((s) => [s.type, s] as const))("accepts a valid %s step, rebuilt", (_, step) => {
    const v = validateStep(step);
    expect(v).toEqual(step);
    expect(v).not.toBe(step);
  });

  const INVALID: [string, unknown][] = [
    ["not an object", "navigate"],
    ["null", null],
    ["an array", [{ type: "back" }]],
    ["an unknown type", { type: "pay", amount: 100 }],
    ["an invented route", { type: "navigate", to: "/account/mortgage" }],
    ["another origin", { type: "navigate", to: "https://evil.example" }],
    ["filters off Spending", { type: "navigate", to: "/account/pay", filters: { category: "Groceries" } }],
    ["a section off Home", { type: "navigate", to: "/account/spending", focus: "bill" }],
    ["an unknown section", { type: "navigate", to: "/account", focus: "mortgage" }],
    ["the Payments category", { type: "navigate", to: "/account/spending", filters: { category: "Payments" } }],
    ["a bad month", { type: "navigate", to: "/account/spending", filters: { month: "2026-13" } }],
    ["a bad transaction id", { type: "navigate", to: "/account/spending", filters: { txn: "<script>" } }],
    ["a long merchant", { type: "navigate", to: "/account/spending", filters: { merchant: "a".repeat(41) } }],
    ["an unknown filter", { type: "navigate", to: "/account/spending", filters: { colour: "red" } }],
    ["markup in say", { type: "navigate", to: "/account", say: "<b>hi</b>" }],
    ["an extra key", { type: "back", to: "/account" }],
    ["a bad mode", { type: "setMode", mode: "fancy" }],
    ["no actions", { type: "preferences", actions: [] }],
    ["a text size off the scale", { type: "preferences", actions: [{ type: "textSize", value: 300 }] }],
    ["a string for a boolean", { type: "preferences", actions: [{ type: "voiceFirst", value: "true" }] }],
    ["an unknown widget", { type: "preferences", actions: [{ type: "hide", widget: "ads" }] }],
    ["an unknown action", { type: "preferences", actions: [{ type: "deleteAccount" }] }],
    ["an unknown control", { type: "control", command: "transfer" }],
    ["an unknown visual", { type: "visual", request: { kind: "pie" } }],
    ["a comparison of three months", { type: "visual", request: { kind: "month_comparison", months: ["2026-09", "2026-10", "2026-11"] } }],
    ["a limit of 50", { type: "visual", request: { kind: "biggest_purchases", limit: 50 } }],
    ["a negative amount", { type: "whatIf", scenario: { kind: "spend_less", amount: -100 } }],
    ["a fractional amount", { type: "whatIf", scenario: { kind: "pay_monthly", amount: 100.5 } }],
    ["£100,000", { type: "whatIf", scenario: { kind: "pay_monthly", amount: 10_000_000 } }],
    ["a string amount", { type: "whatIf", scenario: { kind: "save_by", target: "500", by: "2027-01" } }],
    ["a goal without a category", { type: "goal", op: "create", spec: { kind: "category_cap", monthlyLimit: 8000 } }],
    ["a bad goal id", { type: "goal", op: "remove", goalId: "../../etc" }],
    ["an unknown goal op", { type: "goal", op: "edit" }],
    ["an external link", { type: "local", text: "Hi", link: { label: "Go", href: "https://evil.example" } }],
    ["a script link", { type: "local", text: "Hi", link: { label: "Go", href: "javascript:alert(1)" } }],
    ["a protocol-relative link", { type: "local", text: "Hi", link: { label: "Go", href: "//evil.example/account" } }],
    ["a link to an invented route", { type: "local", text: "Hi", link: { label: "Go", href: "/admin" } }],
    ["an empty question", { type: "ask", question: "  " }],
    ["a long question", { type: "ask", question: "a".repeat(301) }],
    ["a control character", { type: "ask", question: "hi\u0000" }],
    ["a long unsupported", { type: "unsupported", say: "a".repeat(501) }],
  ];
  it.each(INVALID)("rejects %s", (_, step) => {
    expect(validateStep(step)).toBeNull();
  });
});

describe("stepHref", () => {
  it("builds Spending links with filters and Home links with a section", () => {
    expect(stepHref({ type: "navigate", to: "/account/spending", filters: { category: "Groceries", month: "2026-10" } })).toBe("/account/spending?category=Groceries&month=2026-10");
    expect(stepHref({ type: "navigate", to: "/account", focus: "budget" })).toBe("/account?focus=budget");
    expect(stepHref({ type: "navigate", to: "/account/pay" })).toBe("/account/pay");
  });
  it("is null for anything that isn't a valid navigation", () => {
    expect(stepHref({ type: "back" })).toBeNull();
    expect(stepHref({ type: "navigate", to: "/nope" } as unknown as DialStep)).toBeNull();
  });
});

describe("route and section names", () => {
  it("cover every real route and section", () => {
    expect(Object.keys(ROUTE_INFO).sort()).toEqual([...DIAL_ROUTES].sort());
    expect(Object.keys(SECTION_INFO).sort()).toEqual([...HOME_SECTIONS].sort());
    expect(ROUTE_INFO["/account/spending"]).toEqual({ name: "Spending", spoken: "your spending" });
  });
});
