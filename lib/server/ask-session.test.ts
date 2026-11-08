// POST /api/ask answers from the session cookie when there is one this server signed, and only otherwise from the
// `state` the browser sends. A browser can't talk Dial into a balance by sending one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAsk } from "../ai/ask";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { emptySession, type Session } from "./session";
import { createCookieStore } from "./store";

const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
const store = createCookieStore({ secret, now: () => DEMO_NOW.getTime() });
const paid: Session = { ...emptySession(), payments: [{ id: "pay-cookie", amount: 10000, date: DEMO_TODAY, kind: "custom" }] };
/** What a dishonest browser might claim: a far larger payment than the server knows about. */
const bodyState = { payments: [{ id: "pay-body", date: DEMO_TODAY, amount: 60000 }] };

const cookieFor = async (session: Session) => (await store.save(session, new Request("http://test/api/account")))["Set-Cookie"].split(";")[0];

async function ask(question: string, body: Record<string, unknown>, cookie?: string) {
  const request = new Request("http://test/api/ask", {
    method: "POST",
    body: JSON.stringify({ question, ...body }),
    headers: { "x-forwarded-for": "ask-session", ...(cookie ? { cookie } : {}) },
  });
  const response = await handleAsk(request, () => null, store);
  return { status: response.status, body: (await response.json()) as { answer: string; error?: string } };
}

afterEach(() => vi.restoreAllMocks());

describe("where /api/ask gets its facts", () => {
  it("the cookie wins over the body", async () => {
    const cookie = await cookieFor(paid);
    const { status, body } = await ask("What's my current balance?", { state: bodyState }, cookie);
    expect(status).toBe(200);
    expect(body.answer).toBe("Your current balance is £969.89.");
    expect(body.answer).not.toContain("£469.89");
  });

  it("without a cookie, the body still counts, as before", async () => {
    expect((await ask("What's my current balance?", { state: bodyState })).body.answer).toBe("Your current balance is £469.89.");
    expect((await ask("What's my current balance?", {})).body.answer).toBe("Your current balance is £1,069.89.");
  });

  it("a cookie another key signed, or an edited one, counts for nothing", async () => {
    const forged = await (async () => {
      const otherStore = createCookieStore({ secret: Buffer.from("some-other-secret-long-enough-to-count"), now: () => DEMO_NOW.getTime() });
      return (await otherStore.save(paid, new Request("http://test/api/account")))["Set-Cookie"].split(";")[0];
    })();
    expect((await ask("What's my current balance?", { state: bodyState }, forged)).body.answer).toBe("Your current balance is £469.89.");
    const edited = (await cookieFor(paid)).replace("cfe-session=", "cfe-session=A");
    expect((await ask("What's my current balance?", {}, edited)).body.answer).toBe("Your current balance is £1,069.89.");
  });

  it("with a cookie, a broken body state is ignored rather than refused", async () => {
    const cookie = await cookieFor(paid);
    const { status, body } = await ask("What's my current balance?", { state: { payments: "lots" } }, cookie);
    expect(status).toBe(200);
    expect(body.answer).toBe("Your current balance is £969.89.");
    expect((await ask("What's my current balance?", { state: { payments: "lots" } })).status).toBe(400);
  });

  it("an empty session cookie still wins: the visitor has undone everything", async () => {
    const cookie = await cookieFor({ ...emptySession(), settings: { enabled: false, singlePurchaseThreshold: null, monthlyBudget: null, quietHours: null } });
    expect((await ask("What's my current balance?", { state: bodyState }, cookie)).body.answer).toBe("Your current balance is £1,069.89.");
  });

  it("a production server with no SESSION_SECRET answers from the body, and says why in the log", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const request = new Request("http://test/api/ask", { method: "POST", body: JSON.stringify({ question: "What's my current balance?", state: bodyState }), headers: { cookie: "cfe-session=anything" } });
      const response = await handleAsk(request, () => null, createCookieStore());
      expect(response.status).toBe(200);
      expect((await response.json()).answer).toBe("Your current balance is £469.89.");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("session unavailable"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
