import { describe, expect, it, vi } from "vitest";
import type { AskOutcome } from "../assistant/client";
import { runSteps, spokenText, type PendingOffer, type RunnerDeps } from "./runner";
import type { DialStep, Visual, WhatIfResult } from "./types";

const visual: Visual = { kind: "category_breakdown", title: "Where it went", chart: "bars", series: [], textAlternative: "Groceries £10.00", summary: "Most went on Groceries, £10.00.", limitations: [], evidenceIds: [] };

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    mode: "simple",
    navigate: vi.fn(async () => true),
    back: vi.fn(() => true),
    previewPreferences: vi.fn(),
    previewMode: vi.fn(),
    settle: vi.fn((_o: PendingOffer, yes: boolean) => (yes ? "Done." : "Okay, I've left it as it was.")),
    control: vi.fn(() => "Undone."),
    visual: vi.fn(() => visual),
    whatIf: vi.fn((): WhatIfResult => ({ scenario: { kind: "spend_less", amount: 100 }, hypothetical: true, title: "t", statement: "If you spend £1.00 less...", figures: [], assumptions: ["a"], outcome: "fits" })),
    goals: vi.fn(() => []),
    describeGoal: vi.fn(() => "Spend under £80 on eating out each month"),
    ask: vi.fn(async (): Promise<AskOutcome> => ({ kind: "answer", response: { answer: "You spent £10.", evidenceIds: ["t001"], source: "model" }, experience: { template: "general", intent: null }, followUps: [], resolvedQuestion: "What did I spend?" })),
    offline: vi.fn(() => null),
    ...over,
  };
}

const run = (steps: unknown[], d = deps(), pending: PendingOffer | null = null, signal = new AbortController().signal) => runSteps(steps, d, pending, signal);

describe("runSteps", () => {
  it("navigates through the router and says where it went, with no network", async () => {
    const d = deps();
    const out = await run([{ type: "navigate", to: "/account/spending", filters: { category: "Groceries", month: "2026-10" } }], d);
    expect(d.navigate).toHaveBeenCalledWith("/account/spending?category=Groceries&month=2026-10");
    expect(out.items[0]).toMatchObject({ kind: "say" });
    expect(out.network).toBe(0);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("reports a navigation that didn't arrive as a failure, not a success", async () => {
    const out = await run([{ type: "navigate", to: "/account/pay" }], deps({ navigate: async () => false }));
    expect(out.items).toEqual([{ kind: "failed", text: expect.stringContaining("couldn't open") }]);
  });

  it("refuses steps that fail validation and never runs them", async () => {
    const d = deps();
    const out = await run([{ type: "navigate", to: "/admin" }, { type: "eval", code: "alert(1)" }, { type: "pay", amount: 100 }], d);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(out.items.every((i) => i.kind === "failed")).toBe(true);
  });

  it("previews display changes and waits for yes; one offer per turn", async () => {
    const d = deps();
    const out = await run(
      [
        { type: "preferences", actions: [{ type: "textSize", value: 125 }] },
        { type: "setMode", mode: "complex" },
      ],
      d,
    );
    expect(d.previewPreferences).toHaveBeenCalledTimes(1);
    expect(d.previewMode).not.toHaveBeenCalled();
    expect(out.offer?.step.type).toBe("preferences");
    expect(spokenText(out.items)).toMatch(/Do you want to keep it\?.*one change at a time/i);
  });

  it("settles a pending offer on yes, and withdraws it when the person asks something else", async () => {
    const pending: PendingOffer = { step: { type: "preferences", actions: [{ type: "contrast", value: "high" }] }, description: "x" };
    const d = deps();
    await run([{ type: "control", command: "yes" }], d, pending);
    expect(d.settle).toHaveBeenCalledWith(pending, true);
    const d2 = deps();
    await run([{ type: "navigate", to: "/account" }], d2, pending);
    expect(d2.settle).toHaveBeenCalledWith(pending, false);
  });

  it("treats reset as a previewed display change", async () => {
    const d = deps();
    const out = await run([{ type: "control", command: "reset" }], d);
    expect(d.previewPreferences).toHaveBeenCalledWith({ type: "preferences", actions: [{ type: "reset" }] });
    expect(out.offer).not.toBeNull();
  });

  it("offers goals for confirmation rather than adding them", async () => {
    const out = await run([{ type: "goal", op: "create", spec: { kind: "category_cap", category: "Eating out", monthlyLimit: 8000 } }]);
    expect(out.offer?.step.type).toBe("goal");
    expect(spokenText(out.items)).toContain("Spend under £80 on eating out each month");
  });

  it("does not offer a view it's already in", async () => {
    const out = await run([{ type: "setMode", mode: "simple" }]);
    expect(out.offer).toBeNull();
    expect(spokenText(out.items)).toMatch(/already in Simple view/);
  });

  it("builds visuals and what-ifs locally, and labels what-ifs as estimates when read aloud", async () => {
    const d = deps();
    const out = await run([{ type: "visual", request: { kind: "category_breakdown" } }, { type: "whatIf", scenario: { kind: "spend_less", amount: 10000 } }], d);
    expect(out.network).toBe(0);
    expect(spokenText(out.items)).toContain("Most went on Groceries");
    expect(spokenText(out.items)).toContain("This is an estimate, not a forecast.");
  });

  it("asks the backend only for ask steps, passing the previous question", async () => {
    const d = deps();
    const out = await runSteps([{ type: "ask", question: "Why is that higher?" }], d, null, new AbortController().signal, "Compare October with September");
    expect(d.ask).toHaveBeenCalledWith("Why is that higher?", "Compare October with September", expect.anything());
    expect(out.network).toBe(1);
    expect(out.resolvedQuestion).toBe("What did I spend?");
  });

  it("falls back to deterministic facts, then to an honest message, when the backend is down", async () => {
    const down = async (): Promise<AskOutcome> => ({ kind: "unavailable" });
    const withFacts = await run([{ type: "ask", question: "When is my bill due?" }], deps({ ask: down, offline: () => ({ facts: [{ key: "k", label: "Due", value: "23 Nov" }] as never, evidenceIds: [] }) }));
    expect(withFacts.items[0].kind).toBe("offline");
    const none = await run([{ type: "ask", question: "Is my spending ok?" }], deps({ ask: down }));
    expect(none.items[0]).toMatchObject({ kind: "failed" });
  });

  it("stops when a newer turn cancels this one, and shows nothing for it", async () => {
    const c = new AbortController();
    const d = deps({
      ask: async () => {
        c.abort();
        return { kind: "cancelled" };
      },
    });
    const out = await run([{ type: "ask", question: "q" }, { type: "navigate", to: "/account" }] as DialStep[], d, null, c.signal);
    expect(out.cancelled).toBe(true);
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("says when there's nothing to answer yes to", async () => {
    const out = await run([{ type: "control", command: "yes" }]);
    expect(spokenText(out.items)).toMatch(/nothing waiting/);
  });
});
