// Dial navigation to the Credit Learning Lab, its topic pages and More (product review, Task A).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toSteps } from "../ai/command-model";
import { SEED_TRANSACTIONS } from "../data/seed";
import { TOPICS } from "../learn/topics";
import { plan, type PlanEnvWithTransactions } from "./plan";
import { CREDIT_SCORE_NOTE, LEARN_NOTE, ROUTE_INFO, stepHref, validateStep } from "./registry";
import { DIAL_ROUTES, EMPTY_CONTEXT, type DialStep } from "./types";

const env: PlanEnvWithTransactions = {
  context: EMPTY_CONTEXT,
  textSize: 100,
  merchants: [...new Set(SEED_TRANSACTIONS.map((t) => t.merchant))],
  transactionIds: SEED_TRANSACTIONS.map((t) => t.id),
  months: ["2026-09", "2026-10", "2026-11"],
  today: "2026-11-08",
  transactions: SEED_TRANSACTIONS,
};
const steps = (text: string) => plan({ text }, env).steps;
const nav = (to: string, more: object = {}) => [{ type: "navigate", to, ...more }];

describe("every Dial route is a real page", () => {
  const pageFile = (route: string) => {
    const dir = join(process.cwd(), "app", "(dial)", ...route.split("/").filter(Boolean));
    return join(dir, "page.tsx");
  };

  it("static routes have a page file", () => {
    for (const route of DIAL_ROUTES.filter((r) => !r.startsWith("/account/learn/"))) expect(existsSync(pageFile(route)), route).toBe(true);
  });

  it("Learning Lab topic routes are exactly the topics the [topic] page accepts", () => {
    const topicRoutes = DIAL_ROUTES.filter((r) => r.startsWith("/account/learn/"));
    expect([...topicRoutes].sort()).toEqual(TOPICS.map((t) => `/account/learn/${t.slug}`).sort());
    expect(existsSync(join(process.cwd(), "app", "(dial)", "account", "learn", "[topic]", "page.tsx"))).toBe(true);
  });

  it("every new route has a name and passes validation", () => {
    for (const to of ["/account/learn", "/account/learn/quiz", "/account/more"] as const) {
      expect(ROUTE_INFO[to].name).toBeTruthy();
      const step = validateStep({ type: "navigate", to });
      expect(step).toEqual({ type: "navigate", to });
      expect(stepHref(step as DialStep)).toBe(to);
    }
    expect(validateStep({ type: "navigate", to: "/account/learn/credit-score" })).toBeNull();
  });
});

describe("the product review's phrases", () => {
  it('"Open the Learning Lab." opens the hub', () => {
    expect(steps("Open the Learning Lab.")).toEqual(nav("/account/learn"));
  });

  it('"Teach me about credit scores." opens the hub and says, truthfully, that there is no credit score to show', () => {
    expect(steps("Teach me about credit scores.")).toEqual(nav("/account/learn", { say: CREDIT_SCORE_NOTE }));
    expect(CREDIT_SCORE_NOTE).not.toMatch(/\d/);
  });

  it('"Show me more features." opens More', () => {
    expect(steps("Show me more features.")).toEqual(nav("/account/more"));
  });
});

describe("Learning Lab topics", () => {
  it.each([
    ["Teach me about credit utilisation", "/account/learn/utilisation"],
    ["teach me about utilization", "/account/learn/utilisation"],
    ["Open the minimum payments lesson", "/account/learn/minimum-payments"],
    ["I want to learn about paying only the minimum", "/account/learn/minimum-payments"],
    ["How does interest work?", "/account/learn/interest"],
    ["Teach me about APR", "/account/learn/interest"],
    ["Explain my statement in a lesson", "/account/learn/statement"],
    ["Take me to the quiz", "/account/learn/quiz"],
    ["Test my knowledge", "/account/learn/quiz"],
  ])("%s", (text, to) => {
    expect(steps(text)).toEqual(nav(to));
  });

  it("a topic the Learning Lab doesn't have opens the hub and says what it covers", () => {
    expect(steps("Teach me about mortgages")).toEqual(nav("/account/learn", { say: LEARN_NOTE }));
  });

  it("other names for the hub", () => {
    for (const text of ["Take me to the lessons", "Go to the learning lab", "learning lab"]) expect(steps(text), text).toEqual(nav("/account/learn"));
  });

  it("other names for More", () => {
    for (const text of ["Open the more page", "Show me all the features", "take me to everything else"]) expect(steps(text), text).toEqual(nav("/account/more"));
  });
});

describe("existing behaviour is unchanged", () => {
  it("account words without a learning cue still go where they did", () => {
    expect(steps("Show me my statement")).toEqual(nav("/account", { focus: "bill" }));
    expect(steps("Show me my balance")).toEqual(nav("/account", { focus: "balance" }));
    expect(steps("Open my goals")).toEqual(nav("/account/goals"));
    expect(steps("Take me to pay")[0]).toMatchObject({ type: "navigate", to: "/account/pay" });
  });

  it("questions about the account are still questions", () => {
    for (const text of ["What's my APR?", "What is my minimum payment?", "How much interest will I pay?"]) {
      expect(steps(text).some((s) => s.type === "navigate" && s.to.startsWith("/account/learn")), text).toBe(false);
    }
  });

  it("display changes are still display changes", () => {
    expect(steps("Make everything bigger")[0]).toMatchObject({ type: "preferences" });
  });
});

describe("the Groq fallback can use the new routes too", () => {
  it("accepts a go action to a lesson, and refuses one that doesn't exist", () => {
    const screen = { route: "/account", mode: "simple" as const, textSize: 100 as const };
    expect(toSteps([{ do: "go", page: "/account/learn/quiz" }], screen)).toEqual([{ type: "navigate", to: "/account/learn/quiz" }]);
    expect(toSteps([{ do: "go", page: "/account/more" }], screen)).toEqual([{ type: "navigate", to: "/account/more" }]);
    expect(toSteps([{ do: "go", page: "/account/learn/credit-score" }], screen)).toEqual([]);
  });
});
