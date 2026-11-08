import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFromState, parseClientState } from "../ai/live-state";
import { liveState } from "../assistant/live-state";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE, RESET_SPEND_PAUSE } from "../demo-config";
import type { Goal } from "../dial/types";
import { deriveAccount } from "../state/derive-account";
import type { PendingPurchase, SpendPauseSettings } from "../types";
import { contextFromSession, deriveState, type AccountStateBody } from "./account";
import { createHandlers, MESSAGES } from "./handlers";
import { emptySession, type Session } from "./session";
import { createCookieStore, createMemoryStore, type SessionStore } from "./store";

const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
const BASE = "http://localhost/api";
const headphones: PendingPurchase = { id: "demo-1", merchant: "Northwind Audio", item: "Wireless headphones", amount: 12000, createdAt: DEMO_NOW.toISOString() };
const cap: Goal = { id: "g-1", spec: { kind: "category_cap", category: "Eating out", monthlyLimit: 8000 }, createdOn: DEMO_TODAY };

type Reply = { status: number; body: AccountStateBody & { error?: string; payment?: unknown; repeat?: boolean }; headers: Headers };

/** One visitor: carries the cookie from each reply into the next request, as a browser would. */
function visitor(store: SessionStore) {
  const handlers = createHandlers(store);
  let cookie: string | undefined;
  const send = async (response: Promise<Response>): Promise<Reply> => {
    const res = await response;
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const request = (path: string, method = "GET", body?: unknown) =>
    new Request(`${BASE}${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), headers: cookie ? { cookie } : {} });
  return {
    cookie: () => cookie,
    account: () => send(handlers.getAccount(request("/account"))),
    pay: (body: unknown) => send(handlers.postPayment(request("/payments", "POST", body))),
    undo: (id: string) => send(handlers.deletePayment(request(`/payments/${id}`, "DELETE"), id)),
    settings: (settings: unknown) => send(handlers.putSpendPause(request("/spend-pause", "PUT", { settings }))),
    purchase: (purchase: unknown) => send(handlers.postPurchase(request("/purchases", "POST", { purchase }))),
    goals: (goals: unknown) => send(handlers.putGoals(request("/goals", "PUT", { goals }))),
    getGoals: () => send(handlers.getGoals(request("/goals"))),
    raw: (path: string, method: string, body: string, headers: Record<string, string> = {}) =>
      send(handlers.postPayment(new Request(`${BASE}${path}`, { method, body, headers: { ...(cookie ? { cookie } : {}), ...headers } }))),
  };
}

const stores = [
  ["the cookie store", () => createCookieStore({ secret, now: () => DEMO_NOW.getTime() })],
  ["the memory store", () => createMemoryStore()],
] as const;

afterEach(() => vi.restoreAllMocks());

describe.each(stores)("the account API over %s", (_, make) => {
  it("starts every visitor from the seed, without setting a cookie", async () => {
    const me = visitor(make());
    const { status, body, headers } = await me.account();
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("content-type")).toContain("application/json");
    expect(headers.get("set-cookie")).toBeNull();
    expect(body.account).toEqual(SEED_ACCOUNT);
    expect(body.transactions).toEqual(SEED_TRANSACTIONS);
    expect(body).toMatchObject({ settings: INITIAL_SPEND_PAUSE, spendPauseActivity: { activatedAt: null, deactivatedAt: null }, payments: [], purchases: [], goals: [], saved: true });
  });

  it("records a payment, keeps it across requests, and pays the same id only once", async () => {
    const me = visitor(make());
    const first = await me.pay({ id: "pay-1", amount: 10000, kind: "custom" });
    expect(first.status).toBe(200);
    expect(first.body.repeat).toBe(false);
    expect(first.body.payment).toEqual({ id: "pay-1", amount: 10000, date: DEMO_TODAY, kind: "custom" });
    expect(first.body.account.currentBalance).toBe(SEED_ACCOUNT.currentBalance - 10000);
    expect(first.body.account.statementBalance).toBe(SEED_ACCOUNT.statementBalance - 10000);
    expect(first.body.transactions.at(-1)).toMatchObject({ id: "pay-1", amount: -10000, category: "Payments", status: "pending" });

    const again = await me.pay({ id: "pay-1", amount: 10000, kind: "custom" });
    expect(again.body.repeat).toBe(true);
    expect(again.body.payments).toEqual(first.body.payments);
    expect(again.body.account).toEqual(first.body.account);
    // Even with a different amount: the id was paid, so nothing else happens.
    expect((await me.pay({ id: "pay-1", amount: 1, kind: "minimum" })).body.account).toEqual(first.body.account);

    const { body } = await me.account();
    expect(body.payments).toHaveLength(1);
    expect(body.account).toEqual(first.body.account);
  });

  it("refuses a payment the rules refuse, with the rules' own message, and pays nothing", async () => {
    const me = visitor(make());
    const over = await me.pay({ id: "pay-1", amount: SEED_ACCOUNT.currentBalance + 1, kind: "custom" });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain("more than your current balance");
    for (const bad of [{ id: "t001", amount: 100, kind: "custom" }, { id: "pay-1", amount: 10.5, kind: "custom" }, { id: "pay-1", amount: 100, kind: "cheque" }, { id: "pay-1", amount: -5, kind: "custom" }, {}]) {
      const reply = await me.pay(bad);
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(reply.body.error).toBe("That payment couldn't be recorded. Nothing has been paid.");
    }
    expect((await me.account()).body.payments).toEqual([]);
  });

  it("undoes a payment, and undoing it twice changes nothing", async () => {
    const me = visitor(make());
    await me.pay({ id: "pay-1", amount: 100, kind: "custom" });
    await me.pay({ id: "pay-2", amount: 200, kind: "custom" });
    const undone = await me.undo("pay-1");
    expect(undone.status).toBe(200);
    expect(undone.body.payments.map((p) => p.id)).toEqual(["pay-2"]);
    expect(undone.body.account.currentBalance).toBe(SEED_ACCOUNT.currentBalance - 200);
    expect((await me.undo("pay-1")).body.payments.map((p) => p.id)).toEqual(["pay-2"]);
    expect((await me.undo("nothing")).status).toBe(200);
    // The id is free again: the same tap can be paid after an undo.
    expect((await me.pay({ id: "pay-1", amount: 100, kind: "custom" })).body.repeat).toBe(false);
  });

  it("saves Spend Pause choices and stamps when it was turned on and off", async () => {
    const me = visitor(make());
    const on = await me.settings(RESET_SPEND_PAUSE);
    expect(on.status).toBe(200);
    expect(on.body.settings).toEqual(RESET_SPEND_PAUSE);
    expect(on.body.spendPauseActivity).toEqual({ activatedAt: DEMO_NOW.toISOString(), deactivatedAt: null });
    // Changing a choice while on is not a change of state.
    const tweaked = await me.settings({ ...RESET_SPEND_PAUSE, monthlyBudget: 60000 });
    expect(tweaked.body.spendPauseActivity).toEqual(on.body.spendPauseActivity);
    const off = await me.settings({ ...RESET_SPEND_PAUSE, enabled: false });
    expect(off.body.spendPauseActivity).toEqual({ activatedAt: DEMO_NOW.toISOString(), deactivatedAt: DEMO_NOW.toISOString() });
    expect((await me.account()).body.settings).toEqual({ ...RESET_SPEND_PAUSE, enabled: false });
    expect((await me.account()).body.account).toEqual(SEED_ACCOUNT);
  });

  it("refuses settings the live state would refuse", async () => {
    const me = visitor(make());
    const bad: unknown[] = [
      { ...RESET_SPEND_PAUSE, singlePurchaseThreshold: 0 },
      { ...RESET_SPEND_PAUSE, monthlyBudget: 10_000_001 },
      { ...RESET_SPEND_PAUSE, quietHours: { start: "25:00", end: "06:00" } },
      { enabled: "yes" },
      undefined,
    ];
    for (const settings of bad) {
      const reply = await me.settings(settings);
      expect(reply.status, JSON.stringify(settings)).toBe(400);
      expect(reply.body.error).toContain("couldn't be saved");
    }
    expect((await me.account()).body.settings).toEqual(INITIAL_SPEND_PAUSE);
  });

  it("records an approved purchase once, as a pending Shopping transaction", async () => {
    const me = visitor(make());
    const bought = await me.purchase(headphones);
    expect(bought.status).toBe(200);
    expect(bought.body.repeat).toBe(false);
    expect(bought.body.purchases).toEqual([{ id: "demo-1", date: DEMO_TODAY, merchant: "Northwind Audio", amount: 12000, category: "Shopping", status: "pending" }]);
    expect(bought.body.account.currentBalance).toBe(SEED_ACCOUNT.currentBalance + 12000);
    expect((await me.purchase(headphones)).body.repeat).toBe(true);
    expect((await me.account()).body.purchases).toHaveLength(1);
    // A payment can now cover the purchase too.
    const paid = await me.pay({ id: "pay-1", amount: SEED_ACCOUNT.currentBalance + 12000, kind: "custom" });
    expect(paid.status).toBe(200);
    expect(paid.body.account.currentBalance).toBe(0);
  });

  it("refuses a purchase the live state would refuse", async () => {
    const me = visitor(make());
    const bad: unknown[] = [
      { ...headphones, id: "t001" },
      { ...headphones, merchant: "<b>Shop</b>" },
      { ...headphones, amount: 0 },
      { ...headphones, amount: 12000.5 },
      { ...headphones, createdAt: "2026-11-09T10:00:00Z" },
      { ...headphones, createdAt: "soon" },
      "headphones",
      undefined,
    ];
    for (const purchase of bad) {
      const reply = await me.purchase(purchase);
      expect(reply.status, JSON.stringify(purchase)).toBe(400);
      expect(reply.body.error).toBe("That purchase couldn't be recorded.");
    }
    await me.pay({ id: "shared", amount: 100, kind: "custom" });
    expect((await me.purchase({ ...headphones, id: "shared" })).status).toBe(400);
    expect((await me.pay({ id: "demo-9", amount: 100, kind: "custom" })).status).toBe(200);
    await me.purchase({ ...headphones, id: "demo-2" });
    expect((await me.pay({ id: "demo-2", amount: 100, kind: "custom" })).status).toBe(400);
  });

  it("keeps up to 50 payments and purchases", async () => {
    const me = visitor(make());
    for (let i = 0; i < 49; i++) expect((await me.pay({ id: `pay-${i}`, amount: 1, kind: "custom" })).status).toBe(200);
    expect((await me.purchase(headphones)).status).toBe(200);
    const full = await me.pay({ id: "pay-50", amount: 1, kind: "custom" });
    expect(full.status).toBe(400);
    expect(full.body.error).toContain("up to 50");
    expect((await me.purchase({ ...headphones, id: "demo-2" })).body.error).toContain("up to 50");
    // A repeat is still fine: nothing is added.
    expect((await me.pay({ id: "pay-1", amount: 1, kind: "custom" })).status).toBe(200);
    expect((await me.undo("pay-1")).status).toBe(200);
    expect((await me.pay({ id: "pay-50", amount: 1, kind: "custom" })).status).toBe(200);
  });

  it("replaces the goals, and refuses the whole list if one goal is bad", async () => {
    const me = visitor(make());
    const saved = await me.goals([cap]);
    expect(saved.status).toBe(200);
    expect(saved.body.goals).toEqual([cap]);
    expect((await me.getGoals()).body.goals).toEqual([cap]);
    expect((await me.account()).body.goals).toEqual([cap]);
    for (const bad of [[cap, { id: "g-2", spec: { kind: "category_cap", category: "Payments", monthlyLimit: 1 }, createdOn: DEMO_TODAY }], "goals", [{ ...cap, createdOn: "today" }], Array.from({ length: 11 }, (_, i) => ({ ...cap, id: `g-${i}` }))]) {
      const reply = await me.goals(bad);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toContain("can't be tracked");
    }
    expect((await me.getGoals()).body.goals).toEqual([cap]);
    expect((await me.goals([])).body.goals).toEqual([]);
  });

  it("tells the person when a body can't be read", async () => {
    const me = visitor(make());
    for (const body of ["{oops", "[]", '"text"', ""]) {
      const reply = await me.raw("/payments", "POST", body);
      expect(reply.status, body).toBe(400);
      expect(reply.body.error).toBe(MESSAGES.unreadable);
    }
    const big = await me.raw("/payments", "POST", JSON.stringify({ id: "pay-1", amount: 100, kind: "custom", padding: "x".repeat(20_000) }));
    expect(big.status).toBe(400);
    const claimed = await me.raw("/payments", "POST", JSON.stringify({ id: "pay-1", amount: 100, kind: "custom" }), { "content-length": "99999" });
    expect(claimed.status).toBe(400);
  });

  it("never trusts balances in a body", async () => {
    const me = visitor(make());
    const reply = await me.pay({ id: "pay-1", amount: 100, kind: "custom", account: { currentBalance: 0 }, payments: [{ id: "pay-x", amount: 1 }] });
    expect(reply.status).toBe(200);
    expect(reply.body.account.currentBalance).toBe(SEED_ACCOUNT.currentBalance - 100);
    expect(reply.body.payments.map((p) => p.id)).toEqual(["pay-1"]);
  });
});

describe("the cookie store and the API", () => {
  it("ignores a tampered cookie and starts that visitor again from the seed", async () => {
    const store = createCookieStore({ secret, now: () => DEMO_NOW.getTime() });
    const me = visitor(store);
    await me.pay({ id: "pay-1", amount: 10000, kind: "custom" });
    const signed = me.cookie()!;
    const handlers = createHandlers(store);
    const forged = signed.slice(0, 20) + (signed[20] === "A" ? "B" : "A") + signed.slice(21);
    const reply = await handlers.getAccount(new Request(`${BASE}/account`, { headers: { cookie: forged } }));
    expect((await reply.json()).account).toEqual(SEED_ACCOUNT);
    const genuine = await handlers.getAccount(new Request(`${BASE}/account`, { headers: { cookie: signed } }));
    expect((await genuine.json()).account.currentBalance).toBe(SEED_ACCOUNT.currentBalance - 10000);
  });

  it("clears the cookie once everything is undone", async () => {
    const me = visitor(createCookieStore({ secret, now: () => DEMO_NOW.getTime() }));
    await me.pay({ id: "pay-1", amount: 100, kind: "custom" });
    const reply = await me.undo("pay-1");
    expect(reply.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("answers 500 with a friendly message when production has no SESSION_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    try {
      const me = visitor(createCookieStore());
      const reply = await me.pay({ id: "pay-1", amount: 100, kind: "custom" });
      expect(reply.status).toBe(500);
      expect(reply.body.error).toBe(MESSAGES.noSecret);
      expect((await me.account()).status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the server and the screens agree", () => {
  const session: Session = {
    ...emptySession(),
    settings: RESET_SPEND_PAUSE,
    purchases: [{ id: "demo-1", date: DEMO_TODAY, merchant: "Northwind Audio", amount: 12000, category: "Shopping", status: "pending" }],
    payments: [
      { id: "pay-1", amount: 100, date: DEMO_TODAY, kind: "custom" },
      { id: "pay-2", amount: 48620, date: DEMO_TODAY, kind: "statement" },
    ],
  };

  it("deriveState is exactly what the screens work out from the same events", () => {
    const state = deriveState(session);
    expect({ account: state.account, transactions: state.transactions }).toEqual(deriveAccount(session.purchases, session.payments));
  });

  it("Dial's facts from a session match its facts from the state the browser used to send", () => {
    const screens = deriveAccount(session.purchases, session.payments);
    const sent = parseClientState(JSON.parse(JSON.stringify(liveState(screens.transactions, RESET_SPEND_PAUSE))), DEMO_TODAY);
    const fromBody = contextFromState(sent!);
    const fromCookie = contextFromSession(session);
    expect(fromCookie.account).toEqual(fromBody.account);
    expect(fromCookie.settings).toEqual(fromBody.settings);
    expect(fromCookie.txns.map((t) => JSON.stringify(t)).sort()).toEqual(fromBody.txns.map((t) => JSON.stringify(t)).sort());
  });

  it("a visitor who has saved nothing about Spend Pause gets the app's starting settings, not the demo reset", () => {
    const settings: SpendPauseSettings = contextFromSession(emptySession()).settings;
    expect(settings).toEqual(INITIAL_SPEND_PAUSE);
  });
});
