import { describe, expect, it } from "vitest";
import { DEMO_NOW } from "../demo-clock";
import { inferProfile } from "../profile/infer";
import { profileModel } from "../profile/model";
import { createProfileCookieStore, decodeProfile, encodeProfile, profileContext, profileInputs } from "../server/profile";
import { createCookieStore } from "../server/store";
import { selectDemoUser } from "./handler";
import { deriveState } from "../server/account";
import { decodeSession, encodeSession, MAX_COOKIE_BYTES } from "../server/session";
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

describe("POST /demo/user/:id", () => {
  const sessions = createCookieStore({ secret, now: () => now });
  const profiles = createProfileCookieStore({ secret, now: () => now });
  const post = (id: string) => selectDemoUser(new Request(`http://test/demo/user/${id}`, { method: "POST" }), id, { sessions, profiles });

  it("signs this browser in as the synthetic user, and the server then tailors to them", async () => {
    const response = await post("dan");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://test/account");
    const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
    expect(cookies).toHaveLength(3);
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
