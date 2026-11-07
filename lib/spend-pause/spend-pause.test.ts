import { describe, expect, it, vi } from "vitest";
import { seedContext } from "../ai/facts";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_NOW } from "../demo-clock";
import { INITIAL_SPEND_PAUSE, RESET_SPEND_PAUSE } from "../demo-config";
import { evaluatePurchase } from "../finance";
import type { PendingPurchase, SpendPauseSettings } from "../types";
import { activeSince, confirmationFor, matchSpendPauseRequest, proposeSpendPause, spendPauseReply, spendPauseStatus } from "./dial";
import { explainPause } from "./explain";
import { describeChecks, formFromSettings, hasChecks, parsePounds, settingsFromForm, validateForm, type SettingsForm } from "./settings";
import { initialSpendPauseState, purchasesTotal, spendPauseReducer as reduce } from "./state";
import { ACTIVITY_KEY, browserStore, readActivity, readSession, readSettings, SESSION_KEY, SETTINGS_KEY, writeActivity, writeSession, writeSettings } from "./storage";

const ON = RESET_SPEND_PAUSE;
const AT = DEMO_NOW.toISOString();
const NEVER = { activatedAt: null, deactivatedAt: null };
const OFF: SpendPauseSettings = { ...ON, enabled: false };
const NOTHING: SpendPauseSettings = { enabled: false, singlePurchaseThreshold: null, monthlyBudget: null, quietHours: null };
const headphones: PendingPurchase = { id: "p1", merchant: "Northwind Audio", item: "Wireless headphones", amount: 12000, createdAt: DEMO_NOW.toISOString() };
const start = (settings = ON) => initialSpendPauseState(settings);
const held = (state = start()) => reduce(state, { type: "hold-purchase", purchase: headphones, checked: true });

const memoryStore = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const brokenStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("state transitions", () => {
  it("starts from the configured settings, with nothing waiting", () => {
    expect(start()).toEqual({ settings: ON, activity: NEVER, pendingPurchase: null, pendingChecked: false, purchases: [], history: [] });
  });

  it("turns on and off", () => {
    const off = reduce(start(ON), { type: "update-settings", settings: OFF, at: AT });
    expect(off.settings.enabled).toBe(false);
    expect(reduce(off, { type: "update-settings", settings: ON, at: AT }).settings.enabled).toBe(true);
  });

  it("repeating an activation or deactivation changes nothing", () => {
    const on = start(ON);
    expect(reduce(on, { type: "update-settings", settings: { ...ON }, at: AT })).toBe(on);
    const off = start(OFF);
    expect(reduce(off, { type: "update-settings", settings: { ...OFF }, at: AT })).toBe(off);
  });

  it("holds one purchase at a time, so a double tap can't queue two", () => {
    const first = held();
    const second = reduce(first, { type: "hold-purchase", purchase: { ...headphones, id: "p2" }, checked: false });
    expect(second).toBe(first);
  });

  it("going ahead adds one pending transaction and leaves the seed alone", () => {
    const before = JSON.stringify(SEED_TRANSACTIONS);
    const state = reduce(held(), { type: "resolve-purchase", id: "p1", outcome: "go" });
    expect(state.pendingPurchase).toBeNull();
    expect(state.purchases).toEqual([{ id: "p1", date: "2026-11-08", merchant: "Northwind Audio", amount: 12000, category: "Shopping", status: "pending" }]);
    expect(state.history).toEqual([{ purchase: headphones, outcome: "go", checked: true }]);
    expect(JSON.stringify(SEED_TRANSACTIONS)).toBe(before);
  });

  it("cancelling adds no transaction and no balance", () => {
    const state = reduce(held(), { type: "resolve-purchase", id: "p1", outcome: "cancel" });
    expect(state.purchases).toEqual([]);
    expect(purchasesTotal(state.purchases)).toBe(0);
    expect(state.history[0].outcome).toBe("cancel");
  });

  it("answering twice can't charge twice", () => {
    const once = reduce(held(), { type: "resolve-purchase", id: "p1", outcome: "go" });
    expect(reduce(once, { type: "resolve-purchase", id: "p1", outcome: "go" })).toBe(once);
  });

  it("an answer for a different purchase is ignored", () => {
    const state = held();
    expect(reduce(state, { type: "resolve-purchase", id: "other", outcome: "go" })).toBe(state);
  });

  it("restores saved state and keeps defaults for anything missing", () => {
    expect(reduce(start(ON), { type: "restore" }).settings).toEqual(ON);
    expect(reduce(start(ON), { type: "restore", settings: OFF }).settings).toEqual(OFF);
  });
});

describe("the pause decision", () => {
  it("checks the demo purchase when on, and not when off", () => {
    expect(evaluatePurchase(SEED_ACCOUNT, SEED_TRANSACTIONS, ON, headphones, DEMO_NOW).reasons).toEqual(["over_threshold", "over_budget"]);
    expect(evaluatePurchase(SEED_ACCOUNT, SEED_TRANSACTIONS, OFF, headphones, DEMO_NOW).shouldPause).toBe(false);
  });

  it("uses the brief's exact figures", () => {
    const explained = explainPause({ ...seedContext(), settings: ON }, headphones);
    expect(explained.sentence).toBe("This £120.00 purchase is over the £100.00 you asked us to check, and would take you £22.35 over your £500.00 monthly budget.");
    expect(explained.balanceAfter).toBe("£1,189.89");
    expect(explained.availableCreditAfter).toBe("£310.11");
    expect(explained.budget).toEqual({ label: "Over the budget after this purchase by", value: "£22.35" });
  });

  it("reads well with only one reason, and for quiet hours", () => {
    const budgetOnly = { ...ON, singlePurchaseThreshold: null };
    expect(explainPause({ ...seedContext(), settings: budgetOnly }, headphones).sentence).toBe("This purchase would take you £22.35 over your £500.00 monthly budget.");
    const quiet = { ...NOTHING, enabled: true, quietHours: { start: "09:00", end: "11:00" } };
    expect(explainPause({ ...seedContext(), settings: quiet }, headphones).sentence).toBe("This purchase is during your quiet hours, 09:00 to 11:00.");
  });
});

describe("amounts", () => {
  it.each<[string, number]>([["100", 10000], ["75.50", 7550], ["75.5", 7550], ["£1,200", 120000], [" 0.05 ", 5], ["19.99", 1999]])("%s is %i pence", (text, pence) => {
    expect(parsePounds(text)).toBe(pence);
  });

  it.each(["", "abc", "-5", "1.999", "1.2.3", "12345678"])("%j isn't an amount", (text) => expect(parsePounds(text)).toBeNull());
});

describe("the settings form", () => {
  const form = (over: Partial<SettingsForm> = {}): SettingsForm => ({ ...formFromSettings(ON), ...over });

  it("round-trips the settings", () => {
    expect(settingsFromForm(formFromSettings(ON), true)).toEqual(ON);
    const custom: SpendPauseSettings = { enabled: false, singlePurchaseThreshold: 7550, monthlyBudget: null, quietHours: { start: "22:00", end: "06:00" } };
    expect(settingsFromForm(formFromSettings(custom), false)).toEqual(custom);
  });

  it("offers the presets and other", () => {
    expect(formFromSettings(ON).threshold).toBe("10000");
    expect(formFromSettings({ ...ON, singlePurchaseThreshold: 7550 })).toMatchObject({ threshold: "other", otherAmount: "75.50" });
  });

  it("never changes whether it's on", () => {
    expect(settingsFromForm(form(), false).enabled).toBe(false);
  });

  it("explains each mistake", () => {
    expect(validateForm(form({ threshold: "other", otherAmount: "lots" })).otherAmount).toBe("Enter an amount in pounds, like 75 or 75.50.");
    expect(validateForm(form({ threshold: "other", otherAmount: "0" })).otherAmount).toBe("An amount needs to be more than £0.");
    expect(validateForm(form({ budgetAmount: "99999999" })).budgetAmount).toBeDefined();
    expect(validateForm(form({ quietOn: true, quietStart: "22:00", quietEnd: "22:00" })).quietHours).toBe("The start and end times need to be different.");
    expect(validateForm(form({ quietOn: true, quietStart: "", quietEnd: "06:00" })).quietHours).toBe("Enter both times.");
  });

  it("needs at least one check", () => {
    const empty = form({ threshold: "none", budgetOn: false, quietOn: false });
    expect(validateForm(empty).threshold).toBe("Choose at least one thing for Spend Pause to check.");
    expect(validateForm(empty, "threshold")).toEqual({});
  });

  it("validates one screen at a time", () => {
    const f = form({ threshold: "other", otherAmount: "x", budgetAmount: "y" });
    expect(Object.keys(validateForm(f, "budget"))).toEqual(["budgetAmount"]);
  });

  it("describes what is checked", () => {
    expect(describeChecks(ON)).toEqual(["Any purchase over £100.00", "Any purchase that would go over your £500.00 monthly budget"]);
    expect(hasChecks(NOTHING)).toBe(false);
  });
});

describe("storage", () => {
  it("settings persist", () => {
    const store = memoryStore();
    expect(writeSettings(store, OFF)).toBe(true);
    expect(readSettings(store)).toEqual(OFF);
  });

  it("the session persists", () => {
    const store = memoryStore();
    const { pendingPurchase, pendingChecked, purchases, history } = reduce(held(), { type: "resolve-purchase", id: "p1", outcome: "go" });
    writeSession(store, { pendingPurchase, pendingChecked, purchases, history });
    expect(readSession(store)).toEqual({ pendingPurchase, pendingChecked, purchases, history });
  });

  it.each([
    ["not JSON", "{oops"],
    ["the wrong shape", '{"enabled":"yes"}'],
    ["a float amount", '{"enabled":true,"singlePurchaseThreshold":10.5,"monthlyBudget":null,"quietHours":null}'],
    ["a bad time", '{"enabled":true,"singlePurchaseThreshold":null,"monthlyBudget":null,"quietHours":{"start":"25:00","end":"06:00"}}'],
  ])("ignores %s", (_, raw) => {
    expect(readSettings(memoryStore({ [SETTINGS_KEY]: raw }))).toBeUndefined();
  });

  it("ignores a damaged session", () => {
    expect(readSession(memoryStore({ [SESSION_KEY]: '{"purchases":"x"}' }))).toBeUndefined();
    expect(readSession(memoryStore({ [SESSION_KEY]: '{"pendingPurchase":null,"pendingChecked":false,"purchases":[{"id":"x"}],"history":[]}' }))).toBeUndefined();
  });

  it("survives blocked storage", () => {
    expect(readSettings(brokenStore)).toBeUndefined();
    expect(writeSettings(brokenStore, ON)).toBe(false);
    expect(readSettings(null)).toBeUndefined();
    expect(writeSettings(null, ON)).toBe(false);
  });

  it("handles window storage throwing on access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("denied");
      },
    });
    expect(browserStore("localStorage")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("Dial actions", () => {
  it.each<[string, ReturnType<typeof matchSpendPauseRequest>]>([
    ["Help me avoid unnecessary spending.", "help"],
    ["Is Spend Pause enabled?", "status"],
    ["Is Spend Pause on?", "status"],
    ["Turn on Spend Pause.", "turn_on"],
    ["Please switch Spend Pause on", "turn_on"],
    ["Turn off Spend Pause", "turn_off"],
    ["Can I turn it off?", "can_turn_off"],
    ["What did I spend this month?", null],
  ])("%s", (text, request) => expect(matchSpendPauseRequest(text)).toBe(request));

  it("describes the status honestly", () => {
    expect(spendPauseStatus(OFF)).toBe("Spend Pause is off.");
    expect(spendPauseStatus(ON)).toContain("in the demo shop");
  });

  it("only ever proposes a confirmation, and never a change", () => {
    expect(proposeSpendPause(OFF, true)?.href).toBe("/account/spend-pause?confirm=on");
    expect(proposeSpendPause(ON, false)?.href).toBe("/account/spend-pause?confirm=off");
  });

  it("proposes nothing when it's already that way", () => {
    expect(proposeSpendPause(ON, true)).toBeNull();
    expect(proposeSpendPause(OFF, false)).toBeNull();
  });

  it("sends someone with no checks to choose them first", () => {
    expect(proposeSpendPause(NOTHING, true)?.href).toBe("/account/spend-pause");
  });

  it("a confirmation link can only open the question when it would change something", () => {
    expect(confirmationFor(OFF, "on")).toBe("on");
    expect(confirmationFor(ON, "off")).toBe("off");
    expect(confirmationFor(ON, "on")).toBeNull();
    expect(confirmationFor(OFF, "off")).toBeNull();
    expect(confirmationFor(NOTHING, "on")).toBeNull();
    expect(confirmationFor(ON, "maybe")).toBeNull();
    expect(confirmationFor(ON, undefined)).toBeNull();
  });
});

describe("Spend Pause activity", () => {
  const later = "2026-11-08T11:00:00.000Z";

  it("is off on first run, and only a demo reset starts it on", () => {
    expect(INITIAL_SPEND_PAUSE.enabled).toBe(false);
    expect(RESET_SPEND_PAUSE.enabled).toBe(true);
    expect({ ...INITIAL_SPEND_PAUSE, enabled: true }).toEqual(RESET_SPEND_PAUSE);
  });

  it("records when it was turned on and off", () => {
    const on = reduce(start(OFF), { type: "update-settings", settings: ON, at: AT });
    expect(on.activity).toEqual({ activatedAt: AT, deactivatedAt: null });
    const off = reduce(on, { type: "update-settings", settings: OFF, at: later });
    expect(off.activity).toEqual({ activatedAt: AT, deactivatedAt: later });
  });

  it("keeps the first time when turned on twice, and changing a choice isn't a change of state", () => {
    const on = reduce(start(OFF), { type: "update-settings", settings: ON, at: AT });
    expect(reduce(on, { type: "update-settings", settings: { ...ON }, at: later })).toBe(on);
    expect(reduce(on, { type: "update-settings", settings: { ...ON, monthlyBudget: 60000 }, at: later }).activity.activatedAt).toBe(AT);
  });

  it("never touches money, purchases or history", () => {
    const before = reduce(reduce(held(), { type: "resolve-purchase", id: "p1", outcome: "go" }), { type: "hold-purchase", purchase: { ...headphones, id: "p2" }, checked: true });
    const after = reduce(before, { type: "update-settings", settings: OFF, at: AT });
    expect(after.purchases).toBe(before.purchases);
    expect(after.history).toBe(before.history);
    expect(after.pendingPurchase).toBe(before.pendingPurchase);
    expect(purchasesTotal(after.purchases)).toBe(12000);
  });

  it("saves and restores, and ignores anything damaged", () => {
    const store = memoryStore();
    expect(writeActivity(store, { activatedAt: AT, deactivatedAt: null })).toBe(true);
    expect(readActivity(store)).toEqual({ activatedAt: AT, deactivatedAt: null });
    for (const bad of ["not json", "null", "[]", '{"activatedAt":"nope","deactivatedAt":null}', '{"activatedAt":5,"deactivatedAt":null}', "{}"]) {
      expect(readActivity(memoryStore({ [ACTIVITY_KEY]: bad }))).toBeUndefined();
    }
    expect(readActivity(brokenStore)).toBeUndefined();
    expect(reduce(start(OFF), { type: "restore", settings: ON, activity: { activatedAt: AT, deactivatedAt: null } }).activity.activatedAt).toBe(AT);
  });

  it("only says how long it has been on while it is on", () => {
    expect(activeSince(ON, { activatedAt: AT, deactivatedAt: null })).toBe("Sunday 8 November at 10:00");
    expect(activeSince(OFF, { activatedAt: AT, deactivatedAt: later })).toBeNull();
    expect(activeSince(ON, NEVER)).toBeNull();
  });
});

describe("Dial answers about Spend Pause", () => {
  const onActivity = { activatedAt: AT, deactivatedAt: null };
  const reply = (q: string, settings = ON, activity: { activatedAt: string | null; deactivatedAt: string | null } = onActivity) => spendPauseReply(q, settings, activity);

  it("answers whether it is active, from live state", () => {
    expect(reply("Is Spend Pause active?")?.text).toContain("Spend Pause is on");
    expect(reply("Is Spend Pause active?")?.text).toContain("since Sunday 8 November at 10:00");
    expect(reply("Is Spend Pause active?", OFF, NEVER)?.text).toBe("Spend Pause is off.");
  });

  it("answers when it was activated", () => {
    expect(reply("When did I activate it?")?.text).toBe("You turned on Spend Pause on Sunday 8 November at 10:00.");
    expect(reply("When did I activate Spend Pause?", OFF, NEVER)?.text).toBe("You haven't turned on Spend Pause yet.");
    expect(reply("When did I activate it?", ON, NEVER)?.text).toContain("don't have a record");
    expect(reply("When did I activate it?", OFF, { activatedAt: AT, deactivatedAt: AT })?.text).toContain("and turned it off on");
  });

  it("explains what it does and doesn't claim to block a real card", () => {
    for (const q of ["What does Spend Pause do?", "What happens while it is active?", "What is Spend Pause?"]) {
      const text = reply(q)?.text ?? "";
      expect(text).toContain("simulated check");
      expect(text).toContain("final choice");
    }
  });

  it("says it doesn't affect the balance", () => {
    const text = reply("Is my account balance affected by Spend Pause?")?.text ?? "";
    expect(text).toMatch(/^No\./);
    expect(text).toContain("balance");
  });

  it("offers a confirmation for a change and never makes it", () => {
    expect(reply("Can I turn it off?")).toEqual({ text: "Yes, you can turn it off at any time.", action: { href: "/account/spend-pause?confirm=off", label: "Turn off Spend Pause" } });
    expect(reply("Turn on Spend Pause", OFF, NEVER)?.action?.href).toBe("/account/spend-pause?confirm=on");
    expect(reply("Turn on Spend Pause")?.text).toBe("Spend Pause is already on.");
    expect(reply("Turn off Spend Pause", OFF, NEVER)?.text).toBe("Spend Pause is already off.");
  });

  it("leaves everything else to the assistant", () => {
    for (const q of ["What did I spend this month?", "How much do I owe?", "Did I pay Tesco twice?", "What is my current balance?"]) expect(reply(q)).toBeNull();
  });
});
