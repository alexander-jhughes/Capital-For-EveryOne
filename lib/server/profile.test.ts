// The saved profile: signed, consent-gated, and unable to reach anything about money.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAsk } from "../ai/ask";
import { CANT_TELL } from "../ai/guard";
import { HELP_ANSWER, SIGNPOST_SENTENCE } from "../ai/answer-style";
import type { AskModel, ModelInterpretation } from "../ai/model";
import { handleDial } from "../ai/command-handler";
import type { CommandModel } from "../ai/command-model";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { emptyUsage } from "../profile/features";
import type { AnswerStyle } from "../profile/infer";
import { createProfileHandlers } from "./profile-handlers";
import { applyProfileChange, countUsage, createProfileCookieStore, createProfileMemoryStore, decodeProfile, emptyProfile, encodeProfile, PROFILE_COOKIE, profileContext, profileFromWire, type ProfileRecord } from "./profile";
import { emptySession, encodeSession, type Session } from "./session";
import { createCookieStore, createMemoryStore } from "./store";

const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
const now = () => DEMO_NOW.getTime();
const profiles = createProfileCookieStore({ secret, now });
const sessions = createCookieStore({ secret, now });

const record = (over: Partial<ProfileRecord> = {}): ProfileRecord => ({ ...emptyProfile(), consent: true, ...over });
const cookieOf = (headers: Record<string, string>) => headers["Set-Cookie"].split(";")[0];
const profileCookie = async (r: ProfileRecord) => cookieOf(await profiles.save(r, new Request("http://test/")));
const sessionCookie = async (s: Session) => cookieOf(await sessions.save(s, new Request("http://test/")));

afterEach(() => vi.restoreAllMocks());

describe("the profile cookie", () => {
  it("round-trips", () => {
    const r = record({ sensitiveConsent: true, needs: ["reading", "money_tight"], chosen: "stretched", usage: { ...emptyUsage(), dial: 3 } });
    expect(decodeProfile(encodeProfile(r, secret, now()), secret, now())).toEqual(r);
  });

  it("an edited, forged or expired cookie counts for nothing", () => {
    const value = encodeProfile(record({ needs: ["money_tight"] }), secret, now());
    expect(decodeProfile(`A${value}`, secret, now())).toBeNull();
    expect(decodeProfile(value, Buffer.from("some-other-secret-long-enough-to-count"), now())).toBeNull();
    expect(decodeProfile(value, secret, now() + 31 * 24 * 3600 * 1000)).toBeNull();
  });

  it("a session cookie can't be replayed as a profile, or the reverse", () => {
    const session = encodeSession(emptySession(), secret, now());
    expect(decodeProfile(session, secret, now())).toBeNull();
  });

  it("a health need without its consent is refused even inside a signed cookie", () => {
    expect(profileFromWire({ v: 1, t: Math.floor(now() / 1000), n: [0] }, Math.floor(now() / 1000))).toBeNull();
    expect(profileFromWire({ v: 1, t: Math.floor(now() / 1000), h: 1, n: [0] }, Math.floor(now() / 1000))?.needs).toEqual(["reading"]);
  });

  it("without consent nothing is stored: the cookie is cleared", async () => {
    const headers = await profiles.save(emptyProfile(), new Request("http://test/"));
    expect(headers["Set-Cookie"]).toMatch(new RegExp(`^${PROFILE_COOKIE}=; .*Max-Age=0`));
    expect(headers["Set-Cookie"]).toContain("HttpOnly");
  });
});

describe("changing the profile", () => {
  it("can't save anything before consent", () => {
    expect(applyProfileChange(emptyProfile(), { needs: ["money_tight"] })).toMatchObject({ ok: false });
    expect(applyProfileChange(emptyProfile(), { consent: true, needs: ["money_tight"] })).toMatchObject({ ok: true, record: { needs: ["money_tight"] } });
  });

  it("refuses health needs without the extra consent, and drops them when it's withdrawn", () => {
    expect(applyProfileChange(record(), { needs: ["memory"] })).toMatchObject({ ok: false });
    const kept = applyProfileChange(record(), { sensitiveConsent: true, needs: ["memory", "money_tight"] });
    expect(kept).toMatchObject({ ok: true, record: { needs: ["memory", "money_tight"] } });
    const withdrawn = applyProfileChange((kept as { record: ProfileRecord }).record, { sensitiveConsent: false });
    expect(withdrawn).toMatchObject({ ok: true, record: { sensitiveConsent: false, needs: ["money_tight"] } });
  });

  it("turning consent off deletes everything", () => {
    expect(applyProfileChange(record({ needs: ["money_tight"], chosen: "planner" }), { consent: false })).toEqual({ ok: true, record: emptyProfile() });
  });

  it("refuses unknown keys and values whole, including attempts to reach money", () => {
    for (const body of [{ needs: ["rich"] }, { chosen: "vip" }, { creditLimit: 900000 }, { payment: { amount: 1 } }, { consent: "yes" }, [], null, "x"]) {
      expect(applyProfileChange(record(), body)).toMatchObject({ ok: false });
    }
  });

  it("usage counts stop at 10 and need consent", () => {
    let r = record();
    for (let i = 0; i < 15; i++) r = countUsage(r, "dial")!;
    expect(r.usage.dial).toBe(10);
    expect(countUsage(emptyProfile(), "dial")).toBeNull();
    expect(countUsage(record(), "payments")).toBeNull();
  });
});

describe("/api/profile", () => {
  const store = createProfileMemoryStore();
  const api = createProfileHandlers({ profiles: store, sessions: createMemoryStore() });
  const call = async (method: "get" | "put" | "delete" | "usage", body?: unknown, cookie?: string) => {
    const request = new Request("http://test/api/profile", { method: method === "usage" ? "POST" : method.toUpperCase(), headers: cookie ? { cookie } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await api[method](request);
    return { status: response.status, body: await response.json(), cookie: response.headers.get("Set-Cookie")?.split(";")[0] };
  };

  it("starts empty and works out a type once the person opts in", async () => {
    expect((await call("get")).body).toMatchObject({ consent: false, needs: [], result: null });
    const on = await call("put", { consent: true, needs: ["money_tight", "behind_bills"] });
    expect(on.status).toBe(200);
    expect(on.body.result).toMatchObject({ type: "stretched", source: "model", adaptations: { signpost: true } });
    const again = await call("get", undefined, on.cookie);
    expect(again.body.result.type).toBe("stretched");
  });

  it("says why a health need wasn't saved", async () => {
    const r = await call("put", { consent: true, needs: ["reading"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/extra consent/);
  });

  it("counts usage only with consent", async () => {
    expect((await call("usage", { kind: "dial" })).body).toEqual({ counted: false });
    const on = await call("put", { consent: true });
    expect((await call("usage", { kind: "dial" }, on.cookie)).body).toEqual({ counted: true });
  });

  it("DELETE removes everything", async () => {
    const on = await call("put", { consent: true, needs: ["new_to_credit"] });
    const gone = await call("delete", undefined, on.cookie);
    expect(gone.body).toMatchObject({ consent: false, needs: [], result: null });
    expect((await call("get", undefined, on.cookie)).body.consent).toBe(false);
  });

  it("with no model file, shows no type rather than a wrong one", async () => {
    const noModel = createProfileHandlers({ profiles: createProfileMemoryStore(), sessions: createMemoryStore(), model: null });
    const response = await noModel.put(new Request("http://test/api/profile", { method: "PUT", body: JSON.stringify({ consent: true, needs: ["money_tight"] }) }));
    expect((await response.json()).result).toBeNull();
  });
});

describe("the profile reads the server's account, not the browser's", () => {
  it("uses the session's payments", async () => {
    const paid: Session = { ...emptySession(), payments: [{ id: "pay-1", amount: 48620, date: DEMO_TODAY, kind: "statement" }] };
    const cookie = `${await profileCookie(record())}; ${await sessionCookie(paid)}`;
    const ctx = await profileContext(new Request("http://test/", { headers: { cookie } }), { profiles, sessions });
    expect(ctx?.record.consent).toBe(true);
    expect(ctx?.result?.probabilities.steady).toBeGreaterThan((await profileContext(new Request("http://test/", { headers: { cookie: await profileCookie(record()) } }), { profiles, sessions }))!.result!.probabilities.steady);
  });

  it("never throws, whatever the profile store does", async () => {
    const broken = { load: async () => Promise.reject(new Error("db down")), save: async () => ({}) };
    expect(await profileContext(new Request("http://test/"), { profiles: broken, sessions })).toBeNull();
  });
});

// ---- /api/ask with a profile ----

/** Not one of the fixed demo questions, which skip the model on purpose. */
const MODEL_Q = "When do I have to pay my bill?";
const GOOD_BILL = "Your bill, the statement balance, is £486.20, due on Friday 13 November.";
const billModel = (phrase: AskModel["phrase"]): AskModel => ({
  classify: vi.fn(async (): Promise<ModelInterpretation | null> => ({ intent: "days_until_due", confidence: "high" })),
  phrase,
});

async function ask(question: string, model: AskModel | null, cookie?: string, extra: Record<string, unknown> = {}) {
  const request = new Request("http://test/api/ask", { method: "POST", body: JSON.stringify({ question, ...extra }), headers: { "x-forwarded-for": `profile-${Math.random()}`, ...(cookie ? { cookie } : {}) } });
  const response = await handleAsk(request, () => model, sessions, profiles);
  return { status: response.status, body: (await response.json()) as { answer: string; source: string; evidenceIds: string[]; signposted?: true; tailored?: true } };
}

describe("/api/ask uses the profile for wording only", () => {
  it("passes the person's style to the model, and nothing without a profile", async () => {
    const phrase = vi.fn<AskModel["phrase"]>(async () => GOOD_BILL);
    await ask(MODEL_Q, billModel(phrase));
    expect(phrase.mock.calls[0][3]).toBeUndefined();

    const cookie = await profileCookie(record({ needs: ["plain_words", "step_by_step"] }));
    const r = await ask(MODEL_Q, billModel(phrase), cookie);
    expect(phrase.mock.calls[1][3]).toMatchObject<Partial<AnswerStyle>>({ plain: true, stepByStep: true });
    expect(r.body.source).toBe("model");
    expect(r.body.tailored).toBe(true);
  });

  it("the display setting's style reaches the model too", async () => {
    const phrase = vi.fn<AskModel["phrase"]>(async () => GOOD_BILL);
    await ask(MODEL_Q, billModel(phrase), undefined, { style: "brief" });
    expect(phrase.mock.calls[0][3]).toMatchObject({ brief: true });
  });

  it("a styled reply with an invented figure is still rejected: the guard doesn't care about style", async () => {
    const cookie = await profileCookie(record({ needs: ["plain_words"] }));
    const r = await ask(MODEL_Q, billModel(async () => "Your bill is £5.00, due on Friday 13 November."), cookie);
    expect(r.body.answer).not.toContain("£5.00");
    expect(r.body.source).toBe("template");
  });

  it("adds free-help signposting to bill answers for someone who asked for it, with the same figures", async () => {
    const plain = await ask("When is my bill due?", null);
    const cookie = await profileCookie(record({ needs: ["money_tight", "behind_bills"] }));
    const tailored = await ask("When is my bill due?", null, cookie);
    expect(tailored.body.answer).toBe(`${plain.body.answer} ${SIGNPOST_SENTENCE}`);
    expect(tailored.body.evidenceIds).toEqual(plain.body.evidenceIds);
    expect(tailored.body.signposted).toBe(true);
  });

  it("doesn't signpost answers that aren't about the bill", async () => {
    const cookie = await profileCookie(record({ needs: ["money_tight"] }));
    expect((await ask("Has any subscription gone up?", null, cookie)).body.answer).not.toContain("StepChange");
  });

  it("a profile cookie without consent, or a forged one, changes nothing", async () => {
    const plain = await ask("When is my bill due?", null);
    const forged = (await profileCookie(record({ needs: ["money_tight"] }))).replace(`${PROFILE_COOKIE}=`, `${PROFILE_COOKIE}=A`);
    expect((await ask("When is my bill due?", null, forged)).body).toEqual(plain.body);
  });
});

describe("/api/ask safety with or without a profile", () => {
  const stretched = () => profileCookie(record({ needs: ["money_tight", "behind_bills"] }));

  it("answers a request for help with free, impartial advice and no figures", async () => {
    for (const q of ["Where can I get free help with money?", "I can't afford my bill", "I'm struggling with debt", "I'm worried about money"]) {
      const r = await ask(q, null);
      expect(r.body).toMatchObject({ answer: HELP_ANSWER, evidenceIds: [], source: "template", signposted: true });
    }
  });

  it("an ordinary bill question is not mistaken for a request for help", async () => {
    for (const q of ["What is my minimum payment?", "When is my bill due?", "How much do I owe?", "Can I pay less than the minimum?", "How do I pay my bill?", "Help me find my spending on eating out", "Can you help me understand my statement?"]) {
      expect((await ask(q, null)).body.answer).not.toBe(HELP_ANSWER);
    }
  });

  it("catches requests for help worded many ways (the tuning set from the unseen evaluation)", async () => {
    for (const q of ["I'm drowning in debt", "I need help with money", "Money is really tight, what can I do?", "I'm behind on my credit card", "Help, I've missed a payment", "Is there a debt charity I can talk to?", "I don't know how I'll pay this", "I'm skint until payday", "I can't make this month's payment"]) {
      expect((await ask(q, null)).body.answer).toBe(HELP_ANSWER);
    }
  });

  it("never invents a credit score, whatever the model says", async () => {
    const liar: AskModel = { classify: async () => ({ intent: null, confidence: "high" }), phrase: async () => "Your credit score is 742." };
    for (const model of [null, liar]) {
      const r = await ask("What is my credit score?", model, await stretched());
      expect(r.body.answer).not.toMatch(/\d{3}/);
      expect(r.body.answer).toBe(CANT_TELL);
    }
  });

  it("a payment request through /api/ask can't pay anything", async () => {
    const store = createMemoryStore();
    const save = vi.spyOn(store, "save");
    const request = new Request("http://test/api/ask", { method: "POST", body: JSON.stringify({ question: "Pay my bill of £486.20 now" }), headers: { cookie: await stretched() } });
    const response = await handleAsk(request, () => null, store, profiles);
    expect(response.status).toBe(200);
    expect(save).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(((await response.json()) as { answer: string }).answer).not.toMatch(/\b(paid|done|sent)\b/i);
  });

  it("/api/dial still only returns validated steps and never a payment, with a profile cookie present", async () => {
    const model: CommandModel = { interpret: async () => ({ actions: [{ do: "pay", amount: 48620 }, { do: "transfer", to: "attacker" }, { do: "go", page: "/account/pay" }] }) };
    const request = new Request("http://test/api/dial", { method: "POST", body: JSON.stringify({ text: "pay it all now", screen: { mode: "simple", textSize: 100 } }), headers: { cookie: await stretched() } });
    const response = await handleDial(request, () => model);
    const body = (await response.json()) as { steps: { type: string; to?: string }[]; source: string };
    expect(response.status).toBe(200);
    expect(body.source).toBe("model");
    // Only the navigation survives: the person still confirms any payment on the Pay screen themselves.
    expect(body.steps).toEqual([{ type: "navigate", to: "/account/pay" }]);
  });

  it("a provider failure or bad key falls back to the checked wording, styled or not", async () => {
    const failing = billModel(async () => {
      throw Object.assign(new Error("401 invalid api key"), { status: 401 });
    });
    const r = await ask(MODEL_Q, failing, await stretched());
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("template");
    expect(r.body.answer).toContain("£486.20");
    expect(r.body.answer).not.toMatch(/api key|401/i);
  });
});

describe("the tailored flag is honest", () => {
  it("isn't set when the profile changed nothing in a template answer", async () => {
    const cookie = await profileCookie(record({ needs: ["plain_words"] }));
    const r = await ask("What is my credit score?", null, cookie);
    expect(r.body.tailored).toBeUndefined();
    expect(r.body.source).toBe("template");
  });
});
