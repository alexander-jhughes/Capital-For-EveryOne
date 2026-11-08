import { describe, expect, it } from "vitest";
import { DEMO_NOW } from "../demo-clock";
import { inferProfile } from "../profile/infer";
import { profileModel } from "../profile/model";
import { createProfileCookieStore, decodeProfile, encodeProfile, profileContext, profileInputs } from "../server/profile";
import { createCookieStore } from "../server/store";
import { selectDemoUser } from "./handler";
import { deriveState } from "../server/account";
import { decodeSession, emptySession, encodeSession, MAX_COOKIE_BYTES } from "../server/session";
import { buildDemoUser } from "./build";
import { DEMO_USERS } from "./users";

const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
const now = DEMO_NOW.getTime();

describe("synthetic demo users", () => {
  it("have unique, URL-safe ids and cover all six types", () => {
    expect(new Set(DEMO_USERS.map((u) => u.id)).size).toBe(DEMO_USERS.length);
    for (const u of DEMO_USERS) expect(u.id).toMatch(/^[a-z]{2,20}$/);
    expect(new Set(DEMO_USERS.map((u) => u.designedAs)).size).toBe(6);
  });

  it.each(DEMO_USERS.map((u) => [u.id, u] as const))("%s builds through the API's own rules and survives the signed cookies", (_, user) => {
    const { session, profile } = buildDemoUser(user);
    const cookie = encodeSession(session, secret, now);
    expect(cookie.length).toBeLessThan(MAX_COOKIE_BYTES);
    expect(decodeSession(cookie, secret, now)).toEqual(session);
    expect(decodeProfile(encodeProfile(profile, secret, now), secret, now)).toEqual(profile);
    // Figures come from the seed plus events, never from the demo file.
    expect(deriveState(session).account.creditLimit).toBe(150000);
  });

  it("the model agrees with how each user was designed for most of them, and says so honestly when not", () => {
    const model = profileModel()!;
    const rows = DEMO_USERS.map((u) => {
      const { session, profile } = buildDemoUser(u);
      const r = inferProfile(model, profileInputs(profile, session, u.view === "simple"));
      return { id: u.id, designedAs: u.designedAs, type: r.type, confidence: r.confidence };
    });
    const agree = rows.filter((r) => r.type === r.designedAs).length;
    // Abstaining (type null) is allowed; a confident wrong type is what we must keep rare.
    const wrong = rows.filter((r) => r.type !== null && r.type !== r.designedAs);
    expect(agree / rows.length).toBeGreaterThanOrEqual(0.8);
    expect(wrong.length).toBeLessThanOrEqual(1);
    console.info(rows.map((r) => `${r.id}: ${r.type ?? "not sure"} (${r.confidence}) designed as ${r.designedAs}`).join("\n"));
  });
});

const post = (id: string) =>
  selectDemoUser(new Request(`http://test/demo/user/${id}`, { method: "POST" }), id, {
    sessions: createCookieStore({ secret, now: () => now }),
    profiles: createProfileCookieStore({ secret, now: () => now }),
  });

describe("POST /demo/user/:id", () => {
  const sessions = createCookieStore({ secret, now: () => now });
  const profiles = createProfileCookieStore({ secret, now: () => now });

  it("signs this browser in as the synthetic user, and the server then tailors to them", async () => {
    const response = await post("dan");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://test/account");
    const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
    expect(cookies).toHaveLength(4);
    expect(cookies[3]).toBe("cfe-prefs=");
    expect(cookies[2]).toBe("cfe-mode=simple");
    const ctx = await profileContext(new Request("http://test/", { headers: { cookie: cookies.join("; ") } }), { sessions, profiles });
    expect(ctx?.result).toMatchObject({ type: "stretched", adaptations: { signpost: true } });
    // Dan's account figures come from the seed plus his events: a purchase, then the minimum payment.
    const session = await sessions.load(new Request("http://test/", { headers: { cookie: cookies[0] } }));
    expect(deriveState(session!).account.currentBalance).toBe(106989 + 12000 - 2500);
  });

  it("an unknown id changes nothing", async () => {
    const response = await post("nobody");
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("switching between demo users never mixes their data", () => {
  const sessions = createCookieStore({ secret, now: () => now });
  const profiles = createProfileCookieStore({ secret, now: () => now });

  /** A browser's cookie jar: applies Set-Cookie headers, including deletions. */
  const applyCookies = (jar: Map<string, string>, response: Response) => {
    for (const c of response.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      if (/Max-Age=0/i.test(c)) jar.delete(name);
      else jar.set(name, pair.slice(name.length + 1));
    }
  };
  const header = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const switchTo = async (jar: Map<string, string>, id: string) => {
    const response = await selectDemoUser(new Request(`http://test/demo/user/${id}`, { method: "POST", headers: { cookie: header(jar), "sec-fetch-site": "same-origin" } }), id, { sessions, profiles });
    expect(response.status).toBe(303);
    applyCookies(jar, response);
  };
  const state = async (jar: Map<string, string>) => {
    const request = new Request("http://test/", { headers: { cookie: header(jar) } });
    const session = (await sessions.load(request)) ?? emptySession();
    return { account: deriveState(session), profile: await profiles.load(request), mode: jar.get("cfe-mode") };
  };
  const expected = (id: string) => {
    const user = DEMO_USERS.find((u) => u.id === id)!;
    const { session, profile } = buildDemoUser(user);
    return { account: deriveState(session), profile, mode: user.view };
  };

  it("every one of the 324 switches (18 x 18, including to the same user) leaves exactly the new user's data", async () => {
    for (const from of DEMO_USERS) {
      for (const to of DEMO_USERS) {
        const jar = new Map<string, string>([["cfe-prefs", "someone-elses-display-settings"]]);
        await switchTo(jar, from.id);
        await switchTo(jar, to.id);
        const got = await state(jar);
        expect(got).toEqual(expected(to.id));
        // No event id from anyone else.
        const ids = [...got.account.payments, ...got.account.purchases, ...got.account.goals].map((e) => e.id);
        expect(ids.every((i) => i.startsWith(`demo-${to.id}-`))).toBe(true);
        expect(jar.has("cfe-prefs")).toBe(false);
      }
    }
  });

  it("a user with no account history clears the previous user's (Dan to Ruth)", async () => {
    const jar = new Map<string, string>();
    await switchTo(jar, "dan");
    expect((await state(jar)).account.purchases).toHaveLength(1);
    await switchTo(jar, "ruth");
    expect(jar.has("cfe-session")).toBe(false);
    const ruth = await state(jar);
    expect(ruth.account.account.currentBalance).toBe(106989);
    expect(ruth.account.settings.enabled).toBe(false);
  });

  it("asks the browser to clear storage, so a pending Spend Pause purchase can't follow into the next user", async () => {
    const response = await post("dan");
    expect(response.headers.get("Clear-Site-Data")).toBe('"storage"');
  });

  it("refuses a form posted from another website", async () => {
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example", host: "test" }] as Record<string, string>[]) {
      const response = await selectDemoUser(new Request("http://test/demo/user/dan", { method: "POST", headers }), "dan", { sessions, profiles });
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { origin: "http://test", host: "test" }, {}] as Record<string, string>[]) {
      expect((await selectDemoUser(new Request("http://test/demo/user/dan", { method: "POST", headers }), "dan", { sessions, profiles })).status).toBe(303);
    }
  });

  it("two browsers are separate: choosing a user in one changes nothing in the other", async () => {
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    await switchTo(a, "dan");
    await switchTo(b, "priya");
    expect(await state(a)).toEqual(expected("dan"));
    expect(await state(b)).toEqual(expected("priya"));
  });
});
