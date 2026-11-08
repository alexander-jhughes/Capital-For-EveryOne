import { describe, expect, it } from "vitest";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import type { Goal } from "../dial/types";
import type { Payment, Transaction } from "../types";
import { MAX_AGE_SECONDS, MAX_COOKIE_BYTES, decodeSession, emptySession, encodeSession, fromWire, isEmpty, toWire, type Session } from "./session";

const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
const other = Buffer.from("another-secret-that-is-long-enough-to-count");
const now = DEMO_NOW.getTime();

const pay = (id: string, amount: number, kind: Payment["kind"] = "custom"): Payment => ({ id, amount, date: DEMO_TODAY, kind });
const buy = (id: string, amount = 12000): Transaction => ({ id, date: DEMO_TODAY, merchant: "Northwind Audio", amount, category: "Shopping", status: "pending" });
const goal = (id: string, spec: Goal["spec"] = { kind: "category_cap", category: "Eating out", monthlyLimit: 8000 }): Goal => ({ id, spec, createdOn: DEMO_TODAY });
/** The shape a real visit produces: a few payments with the client's long ids, one purchase, a couple of goals and some choices. */
const realistic = (): Session => ({
  settings: RESET_SPEND_PAUSE,
  activity: { activatedAt: DEMO_NOW.toISOString(), deactivatedAt: null },
  purchases: [buy("demo-1")],
  payments: Array.from({ length: 7 }, (_, i) => pay(`pay-mhq3x2k${i}-a1b2c3d${i}`, 1000 + i, (["minimum", "statement", "custom"] as const)[i % 3])),
  goals: [goal("g-abcdefgh"), goal("g-12345678", { kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-10" })],
});

const flip = (value: string, at: number) => value.slice(0, at) + (value[at] === "A" ? "B" : "A") + value.slice(at + 1);

describe("the session codec", () => {
  it("round-trips everything, including kinds, activity and goal specs", () => {
    const session = realistic();
    expect(decodeSession(encodeSession(session, secret, now), secret, now)).toEqual(session);
    expect(decodeSession(encodeSession(emptySession(), secret, now), secret, now)).toEqual(emptySession());
  });

  it("keeps the wire form short: no field for anything still at the seed", () => {
    expect(toWire(emptySession(), 1)).toEqual({ v: 1, t: 1 });
    const wire = toWire({ ...emptySession(), payments: [pay("pay-1", 100, "minimum")] }, 1);
    expect(wire).toEqual({ v: 1, t: 1, y: [["pay-1", DEMO_TODAY, 100, "m"]] });
  });

  it("refuses a payload with one byte changed", () => {
    const value = encodeSession(realistic(), secret, now);
    const dot = value.lastIndexOf(".");
    for (const at of [0, 5, Math.floor(dot / 2), dot - 1]) expect(decodeSession(flip(value, at), secret, now), `byte ${at}`).toBeNull();
  });

  it("refuses a signature with one byte changed, a different key, or none", () => {
    const value = encodeSession(realistic(), secret, now);
    const dot = value.lastIndexOf(".");
    expect(decodeSession(flip(value, dot + 3), secret, now)).toBeNull();
    expect(decodeSession(value, other, now)).toBeNull();
    expect(decodeSession(value.slice(0, dot), secret, now)).toBeNull();
    expect(decodeSession(`${value}.`, secret, now)).toBeNull();
  });

  it("treats garbage as no session", () => {
    for (const junk of [undefined, "", ".", "a.b", "not a cookie", "e30.e30", "x".repeat(5000)]) expect(decodeSession(junk, secret, now)).toBeNull();
  });

  it("treats an expired session as no session", () => {
    const value = encodeSession(realistic(), secret, now);
    expect(decodeSession(value, secret, now + (MAX_AGE_SECONDS - 60) * 1000)).not.toBeNull();
    expect(decodeSession(value, secret, now + (MAX_AGE_SECONDS + 60) * 1000)).toBeNull();
    // Issued in the future means a clock that can't be trusted.
    expect(decodeSession(value, secret, now - 3_600_000)).toBeNull();
  });

  it("refuses a signed payload that breaks the account rules, so a bug can't smuggle one in", () => {
    const t = Math.floor(now / 1000);
    const bad: unknown[] = [
      { v: 2, t },
      { v: 1, t, y: [["pay-1", DEMO_TODAY, 100, "x"]] },
      { v: 1, t, y: [["pay-1", DEMO_TODAY, 200_000_000, "c"]] },
      { v: 1, t, y: [["pay-1", DEMO_TODAY, 100, "c"], ["pay-1", DEMO_TODAY, 100, "c"]] },
      { v: 1, t, p: [["demo-1", DEMO_TODAY, "<script>", 100]] },
      { v: 1, t, p: [["t001", DEMO_TODAY, "Tesco", 100]] },
      { v: 1, t, p: [["demo-1", "2026-11-09", "Northwind Audio", 100]] },
      { v: 1, t, s: [2, null, null, null, null] },
      { v: 1, t, s: [1, 0, null, null, null] },
      { v: 1, t, s: [1, null, null, "22:00", null] },
      { v: 1, t, a: ["not a date", null] },
      { v: 1, t, g: [["g-1", DEMO_TODAY, ["c", "Payments", 100]]] },
      { v: 1, t, g: [["g-1", "yesterday", ["b"]]] },
      { v: 1, t, y: Array.from({ length: 51 }, (_, i) => [`pay-${i}`, DEMO_TODAY, 1, "c"]) },
    ];
    for (const wire of bad) expect(fromWire(wire, t), JSON.stringify(wire).slice(0, 80)).toBeNull();
  });

  it("knows when nothing has happened", () => {
    expect(isEmpty(emptySession())).toBe(true);
    expect(isEmpty({ ...emptySession(), goals: [goal("g-1")] })).toBe(false);
    expect(isEmpty({ ...emptySession(), settings: RESET_SPEND_PAUSE })).toBe(false);
  });
});

describe("the cookie stays small", () => {
  const size = (session: Session) => encodeSession(session, secret, now).length;

  it("the seed plus 10 events, settings and two goals fits with room to spare", () => {
    const session = realistic();
    session.payments.push(pay("pay-mhq3x2k7-a1b2c3d7", 50), pay("pay-mhq3x2k8-a1b2c3d8", 60));
    expect(session.payments.length + session.purchases.length).toBe(10);
    expect(size(session)).toBeLessThan(1200);
  });

  it("50 payments with the client's long ids still fit", () => {
    const session: Session = { ...emptySession(), settings: RESET_SPEND_PAUSE, payments: Array.from({ length: 50 }, (_, i) => pay(`pay-mhq3x2k${i}-a1b2c3d${i}`.slice(0, 21).padEnd(21, "z"), 1 + i)) };
    expect(size(session)).toBeLessThanOrEqual(MAX_COOKIE_BYTES);
  });
});
