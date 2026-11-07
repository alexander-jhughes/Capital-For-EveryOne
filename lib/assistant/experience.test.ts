import { describe, expect, it, vi } from "vitest";
import { askDial } from "./client";
import { GENERAL, parseExperience } from "./experience";

describe("parseExperience (backend contract, allowlisted)", () => {
  it("accepts each template with its intent", () => {
    const pairs = [
      ["statement", "statement_balance"],
      ["spending", "spending_insights"],
      ["subscriptions", "subscription_query"],
      ["transaction", "transaction_investigation"],
      ["payment", "payment_planning"],
      ["general", "general"],
    ] as const;
    for (const [template, intent] of pairs) expect(parseExperience({ template, intent })).toEqual({ template, intent });
  });
  it("keeps a valid template when the intent is missing or unknown", () => {
    expect(parseExperience({ template: "payment" })).toEqual({ template: "payment", intent: null });
    expect(parseExperience({ template: "payment", intent: "drop_tables" })).toEqual({ template: "payment", intent: null });
  });
  it("falls back to general for anything else", () => {
    for (const bad of [undefined, null, "statement", 3, [], {}, { template: "STATEMENT" }, { template: "dashboard" }, { template: 1 }, { intent: "payment_planning" }])
      expect(parseExperience(bad)).toEqual(GENERAL);
  });
  it("ignores extra fields", () => {
    expect(parseExperience({ template: "spending", intent: "spending_insights", script: "alert(1)" })).toEqual({ template: "spending", intent: "spending_insights" });
  });
});

describe("askDial carries the experience without risking the answer", () => {
  const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const base = { answer: "Your bill is £486.20.", evidenceIds: [], source: "cache" };
  it("passes a valid experience through", async () => {
    const r = await askDial("When is my bill due?", { fetchImpl: reply({ ...base, experience: { template: "payment", intent: "payment_planning" } }) });
    expect(r).toMatchObject({ kind: "answer", experience: { template: "payment", intent: "payment_planning" } });
  });
  it("an invalid experience still returns the answer, as general", async () => {
    const r = await askDial("x", { fetchImpl: reply({ ...base, experience: { template: "hack" } }) });
    expect(r).toEqual({ kind: "answer", response: base, experience: GENERAL, followUps: [] });
  });
  it("no experience field means general", async () => {
    const r = await askDial("x", { fetchImpl: reply(base) });
    expect(r).toMatchObject({ kind: "answer", experience: GENERAL });
  });
});
