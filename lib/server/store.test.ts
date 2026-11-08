import { describe, expect, it } from "vitest";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import type { Payment } from "../types";
import { emptySession, type Session } from "./session";
import { createCookieStore, createMemoryStore, readCookie, SESSION_COOKIE, StoreError, type SessionStore } from "./store";

const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
const now = () => DEMO_NOW.getTime();
const pay = (id: string, amount: number): Payment => ({ id, amount, date: DEMO_TODAY, kind: "custom" });
const session: Session = { ...emptySession(), settings: RESET_SPEND_PAUSE, payments: [pay("pay-1", 100)] };

/** The cookie a browser would send back after this response. */
const cookieFrom = (headers: Record<string, string>) => headers["Set-Cookie"].split(";")[0];
const request = (cookie?: string, url = "http://localhost/api/account") => new Request(url, cookie === undefined ? {} : { headers: { cookie } });

describe("readCookie", () => {
  it("finds the named cookie among others, and nothing when it is absent", () => {
    const r = request(`cfe-mode=simple; ${SESSION_COOKIE}=abc.def; cfe-prefs=%7B%7D`);
    expect(readCookie(r, SESSION_COOKIE)).toBe("abc.def");
    expect(readCookie(r, "cfe-mode")).toBe("simple");
    expect(readCookie(r, "missing")).toBeUndefined();
    expect(readCookie(request(), SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(request("=nameless; cfe-session"), SESSION_COOKIE)).toBeUndefined();
  });
});

function behavesLikeAStore(name: string, make: () => SessionStore) {
  describe(name, () => {
    it("has nothing for a first visit", async () => {
      expect(await make().load(request())).toBeNull();
    });

    it("gives back what was saved, through the cookie it set", async () => {
      const store = make();
      const headers = await store.save(session, request());
      expect(headers["Set-Cookie"]).toMatch(/; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
      expect(await store.load(request(cookieFrom(headers)))).toEqual(session);
    });

    it("replaces the session on the next save", async () => {
      const store = make();
      const first = cookieFrom(await store.save(session, request()));
      const changed = { ...session, payments: [...session.payments, pay("pay-2", 200)] };
      const second = cookieFrom(await store.save(changed, request(first)));
      expect(await store.load(request(second))).toEqual(changed);
    });

    it("marks the cookie Secure when the app is served over HTTPS", async () => {
      const store = make();
      expect((await store.save(session, request(undefined, "https://example.com/api/account")))["Set-Cookie"]).toMatch(/; Secure$/);
      const forwarded = new Request("http://internal/api/account", { headers: { "x-forwarded-proto": "https" } });
      expect((await store.save(session, forwarded))["Set-Cookie"]).toMatch(/; Secure$/);
      expect((await store.save(session, request()))["Set-Cookie"]).not.toContain("Secure");
    });
  });
}

behavesLikeAStore("the cookie store", () => createCookieStore({ secret, now }));
behavesLikeAStore("the memory store", () => createMemoryStore());

describe("the cookie store", () => {
  const store = createCookieStore({ secret, now });

  it("ignores a cookie another key signed, or one that was edited", async () => {
    const value = cookieFrom(await createCookieStore({ secret: Buffer.from("some-other-secret-long-enough-to-count"), now }).save(session, request()));
    expect(await store.load(request(value))).toBeNull();
    const mine = cookieFrom(await store.save(session, request()));
    expect(await store.load(request(mine.replace("cfe-session=", "cfe-session=A")))).toBeNull();
    expect(await store.load(request("cfe-session=garbage"))).toBeNull();
  });

  it("clears the cookie when the session is back to empty", async () => {
    const headers = await store.save(emptySession(), request());
    expect(headers["Set-Cookie"]).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  });

  it("refuses a session that would not fit in a cookie", async () => {
    const huge: Session = {
      ...emptySession(),
      payments: Array.from({ length: 50 }, (_, i) => pay(`pay-${"abcdefghijklmnopqrstuvwxyz".slice(0, 20)}-${String(i).padStart(14, "0")}`, 1 + i)),
      goals: Array.from({ length: 10 }, (_, i) => ({ id: `g-${String(i).padStart(30, "0")}`, createdOn: DEMO_TODAY, spec: { kind: "spend_reduction" as const, target: 50000, by: "2027-01", baselineMonth: "2026-10" } })),
    };
    await expect(store.save(huge, request())).rejects.toBeInstanceOf(StoreError);
  });

  it("reads SESSION_SECRET from the environment when no key is given", async () => {
    const before = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "an-environment-secret-long-enough-to-count";
    try {
      const fromEnv = createCookieStore({ now });
      const value = cookieFrom(await fromEnv.save(session, request()));
      expect(await fromEnv.load(request(value))).toEqual(session);
      expect(await createCookieStore({ secret, now }).load(request(value))).toBeNull();
    } finally {
      if (before === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = before;
    }
  });
});

describe("the memory store", () => {
  it("keeps each visitor apart and keeps the same id across saves", async () => {
    let n = 0;
    const store = createMemoryStore(() => `visitor-${++n}`);
    const a = cookieFrom(await store.save(session, request()));
    const b = cookieFrom(await store.save(emptySession(), request()));
    expect(a).toBe("cfe-session=visitor-1");
    expect(b).toBe("cfe-session=visitor-2");
    expect(cookieFrom(await store.save({ ...session, goals: [] }, request(a)))).toBe(a);
    expect(store.sessions.size).toBe(2);
    expect(await store.load(request(b))).toEqual(emptySession());
    expect(await store.load(request("cfe-session=visitor-9"))).toBeNull();
  });
});
