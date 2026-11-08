// Dial can focus the Spending by category, Coming up and Your progress sections on Home (product review, Task C).
import { describe, expect, it } from "vitest";
import { toSteps } from "../ai/command-model";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { paymentReply } from "../payments/dial";
import { WIDGETS } from "../preferences/schema";
import { spendPauseReply } from "../spend-pause/dial";
import { plan, type PlanEnvWithTransactions } from "./plan";
import { SECTION_INFO, stepHref, validateStep } from "./registry";
import { EMPTY_CONTEXT, HOME_SECTIONS, type DialStep } from "./types";

/** The demo account with the real Pay and Spend Pause answers, as the session builds it. */
const env: PlanEnvWithTransactions = {
  context: EMPTY_CONTEXT,
  textSize: 100,
  merchants: [...new Set(SEED_TRANSACTIONS.map((t) => t.merchant))],
  transactionIds: SEED_TRANSACTIONS.map((t) => t.id),
  months: ["2026-09", "2026-10", "2026-11"],
  today: "2026-11-08",
  transactions: SEED_TRANSACTIONS,
  localReply: (text) => {
    const sp = spendPauseReply(text, { enabled: false, singlePurchaseThreshold: null, monthlyBudget: 50000, quietHours: null }, { activatedAt: null, deactivatedAt: null });
    if (sp) return sp.action ? { text: sp.text, link: { label: sp.action.label, href: sp.action.href } } : { text: sp.text };
    const p = paymentReply(text, { account: SEED_ACCOUNT, transactions: SEED_TRANSACTIONS, payments: [] });
    return p ? { text: p } : null;
  },
};
const steps = (text: string) => plan({ text }, env).steps;
const focus = (section: string) => [{ type: "navigate", to: "/account", focus: section }];

describe("the three sections are registered", () => {
  it("are real Home widgets with names", () => {
    for (const s of ["categories", "upcoming", "progress"] as const) {
      expect(HOME_SECTIONS).toContain(s);
      expect(WIDGETS).toContain(s);
      expect(SECTION_INFO[s].name).toBeTruthy();
    }
  });

  it("every Home section is a Home widget (Home focuses by data-widget)", () => {
    for (const s of HOME_SECTIONS) expect(WIDGETS).toContain(s);
  });

  it("navigation to each validates and links to Home with that focus", () => {
    for (const s of ["categories", "upcoming", "progress"] as const) {
      const step = validateStep({ type: "navigate", to: "/account", focus: s });
      expect(step).toEqual({ type: "navigate", to: "/account", focus: s });
      expect(stepHref(step as DialStep)).toBe(`/account?focus=${s}`);
    }
    expect(validateStep({ type: "navigate", to: "/account", focus: "payments-history" })).toBeNull();
  });
});

describe("the product review's phrases", () => {
  it('"Show me my progress." focuses Your progress', () => {
    expect(steps("Show me my progress.")).toEqual(focus("progress"));
  });

  it('"Show my upcoming payments." focuses Coming up, not Pay', () => {
    expect(steps("Show my upcoming payments.")).toEqual(focus("upcoming"));
  });

  it('"Show my spending categories." focuses Spending by category', () => {
    expect(steps("Show my spending categories.")).toEqual(focus("categories"));
  });
});

describe("other ways of asking", () => {
  it.each([
    ["Take me to my progress", "progress"],
    ["my progress", "progress"],
    ["Show me my progress on my goals", "progress"],
    ["What's coming up?", "upcoming"],
    ["What payments are coming up?", "upcoming"],
    ["Show me what's due before my bill", "upcoming"],
    ["upcoming bills", "upcoming"],
    ["Open my spending categories", "categories"],
    ["Show me my spending by category", "categories"],
  ])("%s", (text, section) => {
    expect(steps(text)).toEqual(focus(section));
  });
});

describe("existing behaviour is unchanged", () => {
  it("a breakdown request still draws the chart in Dial", () => {
    expect(steps("Where does my money go?")).toEqual([{ type: "visual", request: { kind: "category_breakdown" } }]);
    expect(steps("Break down my spending by category")).toEqual([{ type: "visual", request: { kind: "category_breakdown" } }]);
  });

  it("naming a month or a category still charts or filters, rather than opening a section", () => {
    expect(steps("Show my spending categories for October")[0]).toMatchObject({ type: "visual" });
    expect(steps("Show my grocery spending in October").some((s) => s.type === "navigate" && s.to === "/account")).toBe(false);
  });

  it("goals and Pay are still goals and Pay", () => {
    expect(steps("Show me my goals")).toEqual([{ type: "navigate", to: "/account/goals" }]);
    expect(steps("Take me to pay")[0]).toMatchObject({ type: "navigate", to: "/account/pay" });
    expect(steps("Show my payments")[0]).toMatchObject({ type: "navigate", to: "/account/pay" });
  });

  it("existing sections are focused as before", () => {
    expect(steps("Show me my balance")).toEqual(focus("balance"));
    expect(steps("Show me my bill")).toEqual(focus("bill"));
  });

  it('"Is Spend Pause on?" is still a question, not a place (a regression this work caught and fixed)', () => {
    const noLocal = plan({ text: "Is Spend Pause on?" }, { ...env, localReply: undefined }).steps;
    expect(noLocal).toEqual([{ type: "ask", question: "Is Spend Pause on?" }]);
  });
});

describe("the Groq fallback can focus the new sections", () => {
  it("accepts them and refuses an unknown one", () => {
    const screen = { route: "/account", mode: "complex" as const, textSize: 100 as const };
    expect(toSteps([{ do: "go", page: "/account", focus: "upcoming" }], screen)).toEqual(focus("upcoming"));
    expect(toSteps([{ do: "go", page: "/account", focus: "made-up" }], screen)).toEqual([{ type: "navigate", to: "/account" }]);
  });
});
