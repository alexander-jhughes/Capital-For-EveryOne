import { describe, expect, it, vi } from "vitest";
import { SEED_TRANSACTIONS } from "../data/seed";
import { parseClientState } from "../ai/live-state";
import { DEMO_TODAY } from "../demo-clock";
import { askDial } from "./client";
import { liveState } from "./live-state";

const settings = { enabled: true, singlePurchaseThreshold: 0, monthlyBudget: 30000, quietHours: null };

describe("liveState (ClientState sent to /api/ask)", () => {
  it("seed only: no events, zero thresholds become null", () => {
    expect(liveState(SEED_TRANSACTIONS, settings)).toEqual({ spendPause: { ...settings, singlePurchaseThreshold: null }, purchases: [], payments: [] });
  });
  it("new purchases and payments keep their IDs; payments oldest first, as positive pence", () => {
    const txns = [
      ...SEED_TRANSACTIONS,
      { id: "pay-2", date: "2026-11-07", merchant: "Payment received", amount: -5000, category: "Payments" as const, status: "pending" as const },
      { id: "sp-1", date: "2026-11-06", merchant: "Argos", amount: 2599, category: "Shopping" as const, status: "pending" as const },
      { id: "pay-1", date: "2026-11-02", merchant: "Payment received", amount: -1000, category: "Payments" as const, status: "pending" as const },
    ];
    const s = liveState(txns, settings);
    expect(s.purchases).toEqual([{ id: "sp-1", date: "2026-11-06", merchant: "Argos", amount: 2599 }]);
    expect(s.payments).toEqual([{ id: "pay-1", date: "2026-11-02", amount: 1000 }, { id: "pay-2", date: "2026-11-07", amount: 5000 }]);
    // The backend's own validator accepts it.
    expect(parseClientState(s, DEMO_TODAY)).not.toBeNull();
  });
  it("askDial sends the state in the request body", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ answer: "ok", evidenceIds: [], source: "template" }), { status: 200 }));
    const state = liveState(SEED_TRANSACTIONS, settings);
    await askDial("Check my balance", { fetchImpl: f as unknown as typeof fetch, state });
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ question: "Check my balance", state });
  });
});

describe("previousQuestion (follow-ups)", () => {
  const reply = () => vi.fn(async () => new Response(JSON.stringify({ answer: "ok", evidenceIds: [], source: "template" }), { status: 200 }));
  const body = (f: ReturnType<typeof reply>) => JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  it("is sent trimmed and capped at 300 characters", async () => {
    const f = reply();
    await askDial("and last month?", { fetchImpl: f as unknown as typeof fetch, previousQuestion: `  ${"x".repeat(400)}  ` });
    expect(body(f).previousQuestion).toHaveLength(300);
  });
  it("is left out when there is none, and the body has only allowlisted keys", async () => {
    const f = reply();
    await askDial("Check my balance", { fetchImpl: f as unknown as typeof fetch, previousQuestion: "  " });
    expect(Object.keys(body(f))).toEqual(["question"]);
  });
});
