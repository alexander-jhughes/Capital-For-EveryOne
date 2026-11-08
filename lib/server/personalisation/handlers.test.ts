import { describe, expect, it, vi } from "vitest";
import type { RecommendationResult, RecommenderInput } from "../../recommender/types";
import type { Database } from "../db/sqlite";
import { createHandlers, MAX_BODY_BYTES, type Handler, type HandlerDeps, type Handlers } from "./handlers";
import { createModelLoader } from "./model-registry";
import { createSessionCodec } from "./session";
import { DAY, fakeBundled, fakeRecommend, fakeValidate, HOUR, prefs, rowsFor, T0, testDb, type FakeModel } from "./test-helpers";

const ORIGIN = "http://localhost:3000";
const codec = createSessionCodec("k".repeat(40));

interface Reply {
  status: number;
  body: Record<string, unknown> & { error?: string };
  headers: Headers;
  setCookie: string | null;
}

function setup(over: Partial<HandlerDeps<FakeModel>> = {}) {
  const db = testDb();
  let clock = T0;
  const logs: string[] = [];
  const recommend = vi.fn((model: FakeModel, input: RecommenderInput) => fakeRecommend(model, input));
  const deps: HandlerDeps<FakeModel> = {
    getDb: () => db,
    getCodec: () => codec,
    recommend,
    loadModel: createModelLoader({ bundled: fakeBundled(), validate: fakeValidate, log: (m) => logs.push(m) }),
    now: () => clock,
    log: (m) => logs.push(m),
    ...over,
  };
  const h = createHandlers(deps);
  return { db, h, logs, recommend, advance: (ms: number) => (clock += ms), now: () => clock };
}

/** A browser with its own cookie jar and address. */
class Browser {
  cookie: string | null = null;
  constructor(
    readonly address = "203.0.113.1",
    readonly base = ORIGIN,
  ) {}

  async send(handler: Handler, method: string, body?: unknown, opts: { headers?: Record<string, string>; id?: string; raw?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { "x-forwarded-for": this.address };
    if (method !== "GET") headers.origin = this.base;
    if (body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = `cfe-pid=${this.cookie}`;
    Object.assign(headers, opts.headers);
    for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
    const request = new Request(`${this.base}/api/personalisation/x`, { method, headers, body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const response = await handler(request, opts.id === undefined ? undefined : { params: Promise.resolve({ id: opts.id }) });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const value = /^cfe-pid=([^;]*)/.exec(setCookie)?.[1] ?? "";
      this.cookie = value === "" ? null : value;
    }
    return { status: response.status, body: (await response.json()) as Reply["body"], headers: response.headers, setCookie };
  }

  state = (h: Handlers) => this.send(h.getState, "GET");
  consent = (h: Handlers, body: unknown) => this.send(h.putConsent, "PUT", body);
  recommend = (h: Handlers, body: unknown = { preferences: prefs(), view: "simple", explicit: [] }) => this.send(h.postRecommendations, "POST", body);
  feedback = (h: Handlers, id: string, body: unknown) => this.send(h.postFeedback, "POST", body, { id });
}

const subjectCount = (db: Database) => (db.prepare("SELECT COUNT(*) AS n FROM subjects").get() as { n: number }).n;
const subjectOf = (db: Database) => (db.prepare("SELECT id FROM subjects ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id;

async function joined(h: Handlers, extra: Record<string, boolean> = {}) {
  const b = new Browser(`198.51.100.${Math.floor(Math.random() * 200)}`);
  const r = await b.consent(h, { personalisation: true, ...extra });
  expect(r.status).toBe(200);
  return b;
}

describe("consent and sessions", () => {
  it("GET / never creates a session or a row", async () => {
    const { db, h } = setup();
    const b = new Browser();
    const r = await b.state(h);
    expect(r.status).toBe(200);
    expect(r.setCookie).toBeNull();
    expect(r.body).toEqual({
      available: true,
      consent: { personalisation: false, collaborative: false, research: false },
      profile: null,
      research: null,
      model: { version: fakeBundled().model.version, trainedOn: "synthetic" },
    });
    expect(subjectCount(db)).toBe(0);
  });

  it("refuses collaborative or research consent without personalisation, storing nothing", async () => {
    const { db, h } = setup();
    const b = new Browser();
    expect((await b.consent(h, { collaborative: true })).status).toBe(409);
    expect((await b.consent(h, { research: true, personalisation: false })).status).toBe(409);
    const nothing = await b.consent(h, { collaborative: false });
    expect(nothing.status).toBe(200);
    expect(nothing.setCookie).toBeNull();
    expect(subjectCount(db)).toBe(0);
  });

  it("granting personalisation creates the subject and sets a locked-down cookie", async () => {
    const { db, h } = setup();
    const b = new Browser();
    const r = await b.consent(h, { personalisation: true, collaborative: true });
    expect(r.body.consent).toEqual({ personalisation: true, collaborative: true, research: false });
    expect(r.body.profile).toEqual({ answers: {}, answered: 0 });
    expect(r.setCookie).toMatch(/^cfe-pid=v1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/api\/personalisation; HttpOnly; SameSite=Lax$/);
    expect(subjectCount(db)).toBe(1);
    expect((await b.state(h)).body.consent).toEqual({ personalisation: true, collaborative: true, research: false });
  });

  it("marks the cookie Secure on https", async () => {
    const { h } = setup();
    const b = new Browser("192.0.2.9", "https://dial.example");
    expect((await b.consent(h, { personalisation: true })).setCookie).toContain("; Secure");
  });

  it("granting again re-uses the same subject", async () => {
    const { db, h } = setup();
    const b = await joined(h);
    await b.consent(h, { personalisation: true, research: true });
    expect(subjectCount(db)).toBe(1);
    expect((await b.state(h)).body.consent).toMatchObject({ research: true });
  });

  it("withdrawing personalisation erases everything and clears the cookie", async () => {
    const { db, h } = setup();
    const b = await joined(h, { collaborative: true, research: true });
    const id = subjectOf(db);
    await b.send(h.putProfile, "PUT", { answers: { detailLevel: "keyFacts" } });
    await b.send(h.putResearch, "PUT", { ageBand: "35-49" });
    await b.recommend(h);
    const r = await b.consent(h, { personalisation: false });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/^cfe-pid=; Max-Age=0/);
    expect(r.body.consent).toEqual({ personalisation: false, collaborative: false, research: false });
    expect(Object.values(rowsFor(db, id)).every((n) => n === 0)).toBe(true);
  });

  it("DELETE / erases everything; the old cookie then means nothing and is cleared", async () => {
    const { db, h } = setup();
    const b = await joined(h);
    const id = subjectOf(db);
    const old = b.cookie;
    const r = await b.send(h.deleteAll, "DELETE");
    expect(r.body).toEqual({ deleted: true });
    expect(r.setCookie).toMatch(/Max-Age=0/);
    expect(rowsFor(db, id).subjects).toBe(0);
    b.cookie = old;
    const after = await b.send(h.getExport, "GET");
    expect(after.status).toBe(401);
    expect(after.setCookie).toMatch(/^cfe-pid=; Max-Age=0/);
  });

  it("treats a tampered cookie as no session", async () => {
    const { h } = setup();
    const b = await joined(h);
    b.cookie = b.cookie!.replace(/\.[0-9a-f]/, (m) => (m === ".0" ? ".1" : ".0"));
    const r = await b.send(h.getExport, "GET");
    expect(r.status).toBe(401);
    expect(r.setCookie).toMatch(/Max-Age=0/);
  });

  it("answers 401 to every personal endpoint without a session", async () => {
    const { h } = setup();
    const b = new Browser();
    const id = crypto.randomUUID();
    const calls: [Handler, string, unknown, string?][] = [
      [h.putProfile, "PUT", { answers: {} }],
      [h.putResearch, "PUT", {}],
      [h.postSignals, "POST", { signals: [{ id: "textLarger", source: "settings" }] }],
      [h.postRecommendations, "POST", { preferences: prefs(), view: "simple", explicit: [] }],
      [h.postFeedback, "POST", { outcome: "accepted" }, id],
      [h.postRating, "POST", { satisfaction: 1 }, id],
      [h.getExport, "GET", undefined],
    ];
    for (const [handler, method, body, recId] of calls) {
      const r = await b.send(handler, method, body, { id: recId });
      expect({ status: r.status, error: typeof r.body.error }).toEqual({ status: 401, error: "string" });
    }
  });

  it("renews the cookie at most once a day when the person comes back", async () => {
    const { h, advance } = setup();
    const b = await joined(h);
    expect((await b.state(h)).setCookie).toBeNull();
    advance(DAY + 1);
    expect((await b.state(h)).setCookie).toMatch(/^cfe-pid=v1\./);
    expect((await b.state(h)).setCookie).toBeNull();
  });
});

describe("profile, research and signals", () => {
  it("saves answers and rejects unknown questions or values", async () => {
    const { h } = setup();
    const b = await joined(h);
    const ok = await b.send(h.putProfile, "PUT", { answers: { detailLevel: "keyFacts", screenReader: "yes" } });
    expect(ok.body).toEqual({ answers: { detailLevel: "keyFacts", screenReader: "yes" }, answered: 2 });
    expect((await b.send(h.putProfile, "PUT", { answers: { income: "high" } })).status).toBe(400);
    expect((await b.send(h.putProfile, "PUT", { answers: { detailLevel: "lots" } })).status).toBe(400);
    expect((await b.send(h.putProfile, "PUT", { answers: { detailLevel: "keyFacts" }, extra: 1 })).status).toBe(400);
    expect((await b.state(h)).body.profile).toEqual({ answers: { detailLevel: "keyFacts", screenReader: "yes" }, answered: 2 });
  });

  it("research needs its own consent; withdrawing it deletes the age band", async () => {
    const { db, h } = setup();
    const b = await joined(h);
    expect((await b.send(h.putResearch, "PUT", { ageBand: "25-34" })).status).toBe(403);
    await b.consent(h, { research: true });
    expect((await b.send(h.putResearch, "PUT", { ageBand: "40" })).status).toBe(400);
    expect((await b.send(h.putResearch, "PUT", { ageBand: "25-34" })).body).toEqual({ ageBand: "25-34" });
    expect((await b.state(h)).body.research).toEqual({ ageBand: "25-34" });
    expect((await b.send(h.putResearch, "PUT", {})).body).toEqual({});
    await b.send(h.putResearch, "PUT", { ageBand: "65+" });
    await b.consent(h, { research: false });
    expect((await b.state(h)).body.research).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_research").get()).toEqual({ n: 0 });
  });

  it("accepts allowlisted signals with 202 and rejects anything else", async () => {
    const { h } = setup();
    const b = await joined(h);
    const ok = await b.send(h.postSignals, "POST", { signals: [{ id: "shorterAnswers", source: "voice" }] });
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ accepted: 1 });
    for (const bad of [
      { signals: [{ id: "transcript", source: "voice" }] },
      { signals: [{ id: "textLarger", source: "gemini" }] },
      { signals: [{ id: "textLarger", source: "voice", text: "what did I spend" }] },
      { signals: Array.from({ length: 21 }, () => ({ id: "textLarger", source: "settings" })) },
      { signals: [] },
    ])
      expect((await b.send(h.postSignals, "POST", bad)).status).toBe(400);
  });
});

describe("recommendations", () => {
  it("returns a suggestion and stores it with the settings snapshot", async () => {
    const { db, h, recommend } = setup();
    const b = await joined(h);
    await b.send(h.putProfile, "PUT", { answers: { detailLevel: "keyFacts" } });
    await b.send(h.postSignals, "POST", { signals: [{ id: "textLarger", source: "settings" }] });
    const r = await b.recommend(h);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    const rec = r.body.recommendation as Record<string, unknown>;
    expect(rec).toMatchObject({ modelVersion: fakeBundled().model.version, trainedOn: "synthetic", configuration: { items: ["textSize.125", "contrast.high"] } });
    expect(Object.keys(rec).sort()).toEqual(["alternatives", "configuration", "explanation", "id", "modelVersion", "trainedOn", "warnings"]);
    expect(recommend).toHaveBeenCalledWith(
      expect.objectContaining({ version: fakeBundled().model.version }),
      { answers: { detailLevel: "keyFacts" }, preferences: prefs(), view: "simple", explicit: [], signals: { textLarger: 1 }, history: [] },
      { now: T0 },
    );
    const stored = db.prepare("SELECT input_snapshot, status FROM recommendations").get() as { input_snapshot: string; status: string };
    expect(JSON.parse(stored.input_snapshot)).toEqual({ answers: { detailLevel: "keyFacts" }, preferences: prefs(), view: "simple", explicit: [], signals: { textLarger: 1 } });
    expect(stored.status).toBe("shown");
    expect(db.prepare("SELECT view FROM user_preferences").get()).toEqual({ view: "simple" });
  });

  it("re-uses the open, identical suggestion instead of storing another", async () => {
    const { db, h } = setup();
    const b = await joined(h);
    const one = await b.recommend(h);
    const two = await b.recommend(h);
    expect((two.body.recommendation as { id: string }).id).toBe((one.body.recommendation as { id: string }).id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 1 });
  });

  it("keeps explicit dimensions sticky across requests", async () => {
    const { h, recommend } = setup();
    const b = await joined(h);
    await b.recommend(h, { preferences: prefs({ textSize: 125 }), view: "simple", explicit: ["motion"] });
    // After a reload the client forgot, and the text was put back to normal: both stay explicit.
    await b.recommend(h, { preferences: prefs(), view: "simple", explicit: [] });
    expect(recommend.mock.calls[1][1].explicit).toEqual(["textSize", "motion"]);
    expect(recommend.mock.calls[1][1].preferences).toEqual(prefs());
  });

  it("stores nothing and returns null when the engine has no suggestion", async () => {
    const noSuggestion = (m: FakeModel, i: RecommenderInput): RecommendationResult => ({ ...fakeRecommend(m, i), status: "insufficient_data", configuration: null, alternatives: [] });
    const { db, h } = setup({ recommend: vi.fn(noSuggestion) });
    const b = await joined(h);
    const r = await b.recommend(h);
    expect(r.body).toMatchObject({ recommendation: null, status: "insufficient_data" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 0 });
  });

  it("returns 'unavailable' (not 500) when the engine throws or returns junk", async () => {
    for (const recommend of [
      () => {
        throw new Error("boom");
      },
      (m: FakeModel, i: RecommenderInput) => ({ ...fakeRecommend(m, i), configuration: { ...fakeRecommend(m, i).configuration!, items: ["delete.everything"] } }) as unknown as RecommendationResult,
    ]) {
      const { db, h } = setup({ recommend: vi.fn(recommend) });
      const b = await joined(h);
      const r = await b.recommend(h);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ recommendation: null, status: "unavailable", warnings: [{ code: "model_unavailable" }] });
      expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 0 });
    }
  });

  it("validates the settings strictly", async () => {
    const { h } = setup();
    const b = await joined(h);
    for (const bad of [
      { preferences: { ...prefs(), textSize: 175 }, view: "simple", explicit: [] },
      { preferences: { ...prefs(), secret: true }, view: "simple", explicit: [] },
      { preferences: prefs(), view: "fancy", explicit: [] },
      { preferences: prefs(), view: "simple", explicit: ["theme"] },
      { preferences: prefs(), view: "simple" },
      { preferences: prefs(), view: "simple", explicit: [], answers: { detailLevel: "keyFacts" } },
    ])
      expect((await b.recommend(h, bad)).status).toBe(400);
  });
});

describe("feedback and rating", () => {
  async function withSuggestion() {
    const s = setup();
    const b = await joined(s.h);
    const r = await b.recommend(s.h);
    return { ...s, b, id: (r.body.recommendation as { id: string }).id };
  }

  it("records feedback and moves the status on", async () => {
    const { db, h, b, id } = await withSuggestion();
    expect((await b.feedback(h, id, { outcome: "modified", items: ["textSize.125"], via: "card" })).body).toEqual({ ok: true });
    expect((await b.send(h.postRating, "POST", { satisfaction: 1 }, { id })).body).toEqual({ ok: true });
    expect((await b.feedback(h, id, { outcome: "reverted", via: "undo" })).body).toEqual({ ok: true });
    expect(db.prepare("SELECT status FROM recommendations").get()).toEqual({ status: "reverted" });
  });

  it("answers 409 for an impossible transition and 400 for items not in the suggestion", async () => {
    const { h, b, id } = await withSuggestion();
    expect((await b.feedback(h, id, { outcome: "reverted" })).status).toBe(409);
    expect((await b.send(h.postRating, "POST", { satisfaction: 1 }, { id })).status).toBe(409);
    expect((await b.feedback(h, id, { outcome: "modified", items: ["voiceFirst.on"] })).status).toBe(400);
    expect((await b.feedback(h, id, { outcome: "modified", items: ["not.an.item"] })).status).toBe(400);
    expect((await b.feedback(h, id, { outcome: "loved" })).status).toBe(400);
    expect((await b.feedback(h, id, { outcome: "accepted", via: "telepathy" })).status).toBe(400);
    expect((await b.send(h.postRating, "POST", { satisfaction: 5 }, { id })).status).toBe(400);
    expect((await b.feedback(h, id, { outcome: "dismissed" })).status).toBe(200);
    expect((await b.feedback(h, id, { outcome: "accepted" })).status).toBe(409);
  });

  it("answers 404, not 403, for another person's suggestion, and for ids that aren't ours", async () => {
    const { db, h, id } = await withSuggestion();
    const other = await joined(h);
    expect((await other.feedback(h, id, { outcome: "rejected" })).status).toBe(404);
    expect((await other.send(h.postRating, "POST", { satisfaction: -1 }, { id })).status).toBe(404);
    expect((await other.feedback(h, crypto.randomUUID(), { outcome: "rejected" })).status).toBe(404);
    expect((await other.feedback(h, "../../etc", { outcome: "rejected" })).status).toBe(404);
    expect(db.prepare("SELECT status FROM recommendations WHERE id = ?").get(id)).toEqual({ status: "shown" });
  });
});

describe("export", () => {
  it("returns only this person's data, as a download", async () => {
    const { h } = setup();
    const a = await joined(h);
    const b = await joined(h);
    await a.send(h.putProfile, "PUT", { answers: { detailLevel: "everything" } });
    await b.send(h.putProfile, "PUT", { answers: { creditFamiliarity: "new" } });
    const aRec = ((await a.recommend(h)).body.recommendation as { id: string }).id;
    const r = await b.send(h.getExport, "GET");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const text = JSON.stringify(r.body);
    expect(text).toContain("creditFamiliarity");
    expect(text).not.toContain("detailLevel");
    expect(text).not.toContain(aRec);
  });
});

describe("request checks", () => {
  it("only takes JSON (415), at most 16 KB (413), well formed (400)", async () => {
    const { h } = setup();
    const b = await joined(h);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: "answers=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
    const big = JSON.stringify({ answers: { detailLevel: "keyFacts" }, pad: "x".repeat(MAX_BODY_BYTES) });
    // Declared too big (refused before reading), and too big without a declared length (counted while reading).
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: "{}", headers: { "content-length": String(MAX_BODY_BYTES + 1) } })).status).toBe(413);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: big })).status).toBe(413);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: JSON.stringify({ answers: {} }).padEnd(MAX_BODY_BYTES, " ") })).status).toBe(200);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: "{not json" })).status).toBe(400);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: "[]" })).status).toBe(400);
    expect((await b.send(h.putProfile, "PUT", undefined, { raw: "null" })).status).toBe(400);
  });

  it("refuses cross-site mutations (403) but allows same-origin and non-browser clients", async () => {
    const { db, h } = setup();
    const b = new Browser();
    expect((await b.send(h.putConsent, "PUT", { personalisation: true }, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await b.send(h.putConsent, "PUT", { personalisation: true }, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await b.send(h.putConsent, "PUT", { personalisation: true }, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await b.send(h.putConsent, "PUT", { personalisation: true }, { headers: { origin: "null" } })).status).toBe(403);
    expect(subjectCount(db)).toBe(0);
    const viaCurl = new Browser("192.0.2.50");
    expect((await viaCurl.send(h.putConsent, "PUT", { personalisation: true }, { headers: { origin: "" } })).status).toBe(200);
    expect((await b.send(h.putConsent, "PUT", { personalisation: true }, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  it("rate-limits per subject, and per address before a session exists (429)", async () => {
    const { h } = setup({ limits: { requests: { windowMs: 60_000, max: 3 } } });
    const anon = new Browser("192.0.2.77");
    for (let i = 0; i < 3; i++) expect((await anon.state(h)).status).toBe(200);
    const limited = await anon.state(h);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address still gets in, and its session gets its own allowance.
    const other = new Browser("192.0.2.78");
    expect((await other.consent(h, { personalisation: true })).status).toBe(200);
    expect((await other.state(h)).status).toBe(200);
    expect((await other.state(h)).status).toBe(200);
    expect((await other.state(h)).status).toBe(200);
    expect((await other.state(h)).status).toBe(429);
  });

  it("limits how many subjects one address can create", async () => {
    const { h } = setup({ limits: { newSubjects: { windowMs: HOUR, max: 2 } } });
    const ip = "192.0.2.99";
    expect((await new Browser(ip).consent(h, { personalisation: true })).status).toBe(200);
    expect((await new Browser(ip).consent(h, { personalisation: true })).status).toBe(200);
    expect((await new Browser(ip).consent(h, { personalisation: true })).status).toBe(429);
  });

  it("sends Cache-Control: no-store on every response, errors included", async () => {
    const { h } = setup();
    const b = new Browser();
    for (const r of [await b.state(h), await b.send(h.getExport, "GET"), await b.consent(h, { collaborative: true }), await b.send(h.getModel, "GET")])
      expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("database unavailable", () => {
  it("GET / says unavailable; everything else answers 503", async () => {
    const { h } = setup({ getDb: () => null });
    const b = new Browser();
    const state = await b.state(h);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ available: false, consent: { personalisation: false }, model: null });
    expect((await b.consent(h, { personalisation: true })).status).toBe(503);
    expect((await b.recommend(h)).status).toBe(503);
    expect((await b.send(h.getModel, "GET")).status).toBe(503);
  });

  it("answers 503 when the session secret can't be loaded", async () => {
    const { h } = setup({
      getCodec: () => {
        throw new Error("read-only disk");
      },
    });
    expect((await new Browser().consent(h, { personalisation: true })).status).toBe(503);
  });
});

describe("model endpoint", () => {
  it("is public and describes the serving model", async () => {
    const { h } = setup();
    const r = await new Browser().send(h.getModel, "GET");
    expect(r.body).toEqual({ version: fakeBundled().model.version, algorithm: "fake-hybrid", trainedOn: "synthetic", createdAt: new Date(T0 - 30 * DAY).toISOString(), metrics: fakeBundled().metrics });
  });
});

describe("housekeeping", () => {
  it("purges expired data lazily, at most once an hour", async () => {
    const { db, h, advance } = setup();
    const b = await joined(h);
    await b.send(h.postSignals, "POST", { signals: [{ id: "textLarger", source: "settings" }] });
    advance(181 * DAY);
    await b.state(h);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interaction_signals").get()).toEqual({ n: 0 });
    await b.send(h.postSignals, "POST", { signals: [{ id: "textLarger", source: "settings" }] });
    db.prepare("UPDATE interaction_signals SET created_at = ?").run(T0);
    advance(30 * 60 * 1000);
    await b.state(h);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interaction_signals").get()).toEqual({ n: 1 });
    advance(HOUR);
    await b.state(h);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interaction_signals").get()).toEqual({ n: 0 });
  });

  it("never logs answers or settings", async () => {
    const { h, logs } = setup({
      recommend: vi.fn(() => {
        throw new Error("answers: keyFacts, textSize 150");
      }),
    });
    const b = await joined(h);
    await b.send(h.putProfile, "PUT", { answers: { detailLevel: "keyFacts" } });
    await b.recommend(h, { preferences: prefs({ textSize: 150 }), view: "simple", explicit: [] });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toMatch(/keyFacts|textSize|150/);
  });
});
