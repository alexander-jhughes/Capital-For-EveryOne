// The /api/personalisation HTTP API (CONTRACT.md §7), framework-agnostic: (Request) => Promise<Response>.
// The Next.js route files are one-liners over these. Everything the handlers need is injected, so tests run them
// end to end with real Request objects, an in-memory database and a fake engine.
//
// Every response: JSON, `Cache-Control: no-store`. Mutations: same-origin only. Bodies: JSON, at most 16 KB.
// Answers, settings and signals are never logged.
import { isItemId } from "../../recommender/catalog";
import type { Configuration, ModelHeader, RecommendationResult, RecommenderInput, RecommendOptions, Warning } from "../../recommender/types";
import { describeDbError, type Database } from "../db/sqlite";
import { isEvidenceLevel, iso } from "./domain";
import type { LoadedModel } from "./model-registry";
import { purgeExpired } from "./pipeline-store";
import { clientAddress, createRateLimiter, type RateLimit } from "./rate-limit";
import { createSubject, forSubject, NO_CONSENT, type InputSnapshot, type RecommendationDto, type StoredRecommendation } from "./repository";
import { clearedSessionCookie, isSecureRequest, readSession, sessionCookie, type SessionCodec } from "./session";
import {
  isRecommendationId,
  parseConsent,
  parseFeedback,
  parseProfile,
  parseRating,
  parseRecommendationRequest,
  parseResearch,
  parseSignals,
  type Parsed,
} from "./validation";

export const MAX_BODY_BYTES = 16 * 1024;
const HOUR_MS = 60 * 60 * 1000;
/** last_seen_at is written (and the cookie renewed) at most this often per subject. */
const SEEN_INTERVAL_MS = 24 * HOUR_MS;

export const DEFAULT_LIMITS = {
  /** Requests per subject (or per address before a session exists). */
  requests: { windowMs: 60_000, max: 120 } as RateLimit,
  /** New subjects (turning personalisation on) per address. */
  newSubjects: { windowMs: HOUR_MS, max: 10 } as RateLimit,
};

export type Recommend<M extends ModelHeader> = (model: M, input: RecommenderInput, options?: RecommendOptions) => RecommendationResult;

export interface HandlerDeps<M extends ModelHeader = ModelHeader> {
  /** Null when the database can't be opened: the API answers 503 (GET / says `available: false`). */
  getDb: () => Database | null;
  /** The session cookie signer. Throwing (no usable secret) also means 503. */
  getCodec: () => SessionCodec;
  recommend: Recommend<M>;
  loadModel: (db: Database) => LoadedModel<M> | null;
  now?: () => number;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  log?: (message: string) => void;
}

type Params = { id?: string } | Promise<{ id?: string }>;
export type RouteContext = { params: Params };
export type Handler = (request: Request, context?: RouteContext) => Promise<Response>;

export interface Handlers {
  getState: Handler;
  putConsent: Handler;
  putProfile: Handler;
  putResearch: Handler;
  postSignals: Handler;
  postRecommendations: Handler;
  postFeedback: Handler;
  postRating: Handler;
  getExport: Handler;
  deleteAll: Handler;
  getModel: Handler;
}

// ------------------------------------------------------------------------------------------------------------------
// Responses
// ------------------------------------------------------------------------------------------------------------------

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}, cookie: string | null = null): Response {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  if (cookie) h.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers: h });
}

// ------------------------------------------------------------------------------------------------------------------
// Request checks
// ------------------------------------------------------------------------------------------------------------------

/** Mutations must come from this site. Browsers always send Origin on POST/PUT/DELETE; other clients may not. */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [new URL(request.url).host, request.headers.get("host"), request.headers.get("x-forwarded-host")?.split(",")[0].trim()];
  return allowed.some((a) => a && a.toLowerCase() === host.toLowerCase());
}

const isJson = (request: Request) => request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "The body is too big");
  if (!request.body) throw new HttpError(400, "The body must be JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "The body is too big");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "The body must be JSON");
  }
}

const unwrap = <T>(p: Parsed<T>): T => {
  if (!p.ok) throw new HttpError(400, p.error);
  return p.value;
};

// ------------------------------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------------------------------

interface Spec {
  mutation: boolean;
  body: boolean;
  /** "none": don't read the session at all (public endpoint). */
  session: "required" | "optional" | "none";
  /** Answer for an unavailable database instead of 503. */
  whenUnavailable?: () => Reply;
}

interface Ctx {
  request: Request;
  db: Database;
  codec: SessionCodec;
  subjectId: string | null;
  body: unknown;
  now: number;
  secure: boolean;
  setCookie(value: string): void;
  params: Params | undefined;
}

const MODEL_UNAVAILABLE: Warning = { code: "model_unavailable", text: "Suggestions aren't available right now." };

/** The engine is trusted, but nothing malformed is stored or sent. */
function isUsableConfiguration(c: unknown): c is Configuration {
  const x = c as Configuration | null;
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray(x.items) &&
    x.items.length > 0 &&
    x.items.every(isItemId) &&
    Array.isArray(x.actions) &&
    typeof x.title === "string" &&
    typeof x.offer === "string" &&
    typeof x.confidence === "number" &&
    Number.isFinite(x.confidence) &&
    isEvidenceLevel(x.evidence)
  );
}

const publicDto = (r: StoredRecommendation): RecommendationDto => ({
  id: r.id,
  modelVersion: r.modelVersion,
  trainedOn: r.trainedOn,
  configuration: r.configuration,
  alternatives: r.alternatives,
  explanation: r.explanation,
  warnings: r.warnings,
});

export function createHandlers<M extends ModelHeader>(deps: HandlerDeps<M>): Handlers {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const requestLimiter = createRateLimiter(limits.requests);
  const subjectLimiter = createRateLimiter(limits.newSubjects);
  let lastPurge = Number.NEGATIVE_INFINITY;

  const loadModel = (db: Database): LoadedModel<M> | null => {
    try {
      return deps.loadModel(db);
    } catch (error) {
      log(`[personalisation] model load failed: ${describeDbError(error)}`);
      return null;
    }
  };

  const maybePurge = (db: Database, at: number) => {
    if (at - lastPurge < HOUR_MS) return;
    lastPurge = at;
    try {
      purgeExpired(db, at);
    } catch (error) {
      log(`[personalisation] retention purge failed: ${describeDbError(error)}`);
    }
  };

  const state = (db: Database, subjectId: string | null) => {
    const loaded = loadModel(db);
    const repo = subjectId ? forSubject(db, subjectId) : null;
    const profile = repo?.profile() ?? null;
    return {
      available: true,
      consent: repo?.consent() ?? NO_CONSENT,
      profile: profile ? { answers: profile.answers, answered: profile.answered } : null,
      research: repo?.research() ?? null,
      model: loaded ? { version: loaded.record.version, trainedOn: loaded.record.trainedOn } : null,
    };
  };

  function route(spec: Spec, fn: (ctx: Ctx) => Reply | Promise<Reply>): Handler {
    return async (request, context) => {
      let cookie: string | null = null;
      try {
        const at = now();
        if (spec.mutation && !isSameOrigin(request)) throw new HttpError(403, "Cross-site requests are not allowed");
        if (spec.body && !isJson(request)) throw new HttpError(415, "Send JSON (Content-Type: application/json)");
        if (spec.body && Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new HttpError(413, "The body is too big");

        const db = deps.getDb();
        if (!db) {
          if (spec.whenUnavailable) {
            const r = spec.whenUnavailable();
            return respond(r.status ?? 200, r.body, r.headers);
          }
          throw new HttpError(503, "Personalisation is unavailable right now");
        }
        let codec: SessionCodec;
        try {
          codec = deps.getCodec();
        } catch (error) {
          log(`[personalisation] session secret unavailable: ${describeDbError(error)}`);
          throw new HttpError(503, "Personalisation is unavailable right now");
        }
        maybePurge(db, at);

        const secure = isSecureRequest(request);
        let subjectId: string | null = null;
        if (spec.session !== "none") {
          const session = readSession(request, db, codec);
          subjectId = session.subjectId;
          if (session.stale) cookie = clearedSessionCookie(secure);
        }

        const wait = requestLimiter.hit(subjectId ? `s:${subjectId}` : `a:${clientAddress(request)}`, at);
        if (wait > 0) throw new HttpError(429, "Too many requests. Please try again shortly.", { "Retry-After": String(wait) });
        if (spec.session === "required" && !subjectId) throw new HttpError(401, "Personalisation isn't turned on");

        const body = spec.body ? await readBody(request) : undefined;
        // Renew the cookie when we note the visit, so an active person's cookie never runs out.
        if (subjectId && forSubject(db, subjectId).touch(at, SEEN_INTERVAL_MS)) cookie = sessionCookie(codec, subjectId, secure);

        const reply = await fn({
          request,
          db,
          codec,
          subjectId,
          body,
          now: at,
          secure,
          setCookie: (value) => (cookie = value),
          params: context?.params,
        });
        return respond(reply.status ?? 200, reply.body, reply.headers, cookie);
      } catch (error) {
        if (error instanceof HttpError) return respond(error.status, { error: error.message }, error.headers, cookie);
        log(`[personalisation] request failed: ${describeDbError(error)}`);
        return respond(500, { error: "Something went wrong" }, {}, cookie);
      }
    };
  }

  const recommendationId = async (ctx: Ctx): Promise<string> => {
    const id = (await ctx.params)?.id;
    if (!isRecommendationId(id)) throw new HttpError(404, "Suggestion not found");
    return id;
  };

  const unavailableState = (): Reply => ({ body: { available: false, consent: NO_CONSENT, profile: null, research: null, model: null } });

  return {
    getState: route({ mutation: false, body: false, session: "optional", whenUnavailable: unavailableState }, ({ db, subjectId }) => ({ body: state(db, subjectId) })),

    putConsent: route({ mutation: true, body: true, session: "optional" }, ({ db, codec, subjectId, body, now: at, secure, setCookie, request }) => {
      const change = unwrap(parseConsent(body));
      const personalisation = change.personalisation ?? subjectId !== null;
      if (!personalisation && (change.collaborative === true || change.research === true))
        throw new HttpError(409, "Turn on personalisation before collaborative learning or research");
      if (change.personalisation === false) {
        if (subjectId) forSubject(db, subjectId).deleteAll();
        setCookie(clearedSessionCookie(secure));
        return { body: state(db, null) };
      }
      if (!subjectId && change.personalisation === true) {
        const wait = subjectLimiter.hit(`a:${clientAddress(request)}`, at);
        if (wait > 0) throw new HttpError(429, "Too many requests. Please try again later.", { "Retry-After": String(wait) });
        const id = createSubject(db, at, { collaborative: change.collaborative, research: change.research });
        setCookie(sessionCookie(codec, id, secure));
        return { body: state(db, id) };
      }
      if (subjectId) forSubject(db, subjectId).setConsent({ collaborative: change.collaborative, research: change.research }, at);
      return { body: state(db, subjectId) };
    }),

    putProfile: route({ mutation: true, body: true, session: "required" }, ({ db, subjectId, body, now: at }) => {
      const answers = unwrap(parseProfile(body));
      return { body: forSubject(db, subjectId!).saveAnswers(answers, at) };
    }),

    putResearch: route({ mutation: true, body: true, session: "required" }, ({ db, subjectId, body, now: at }) => {
      const repo = forSubject(db, subjectId!);
      if (!repo.consent().research) throw new HttpError(403, "Research consent isn't given");
      const answers = unwrap(parseResearch(body));
      repo.saveResearch(answers, at);
      return { body: repo.research() ?? {} };
    }),

    postSignals: route({ mutation: true, body: true, session: "required" }, ({ db, subjectId, body, now: at }) => {
      const signals = unwrap(parseSignals(body));
      return { status: 202, body: { accepted: forSubject(db, subjectId!).addSignals(signals, at) } };
    }),

    postRecommendations: route({ mutation: true, body: true, session: "required" }, ({ db, subjectId, body, now: at }) => {
      const request = unwrap(parseRecommendationRequest(body));
      const repo = forSubject(db, subjectId!);
      const settings = repo.savePreferences(request, at);
      const snapshot: InputSnapshot = {
        answers: repo.profile()?.answers ?? {},
        preferences: settings.preferences,
        view: settings.view,
        explicit: settings.explicit,
        signals: repo.signalCounts(at),
      };
      const unavailable = { body: { recommendation: null, status: "unavailable", warnings: [MODEL_UNAVAILABLE] } };
      const loaded = loadModel(db);
      if (!loaded) return unavailable;
      let result: RecommendationResult;
      try {
        result = deps.recommend(loaded.model, { ...snapshot, history: repo.historyFor() }, { now: at });
      } catch (error) {
        log(`[personalisation] recommend failed: ${describeDbError(error)}`);
        return unavailable;
      }
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      if (result?.status !== "ok") return { body: { recommendation: null, status: result?.status ?? "unavailable", warnings } };
      const alternatives = Array.isArray(result.alternatives) ? result.alternatives : [];
      if (!isUsableConfiguration(result.configuration) || !alternatives.every(isUsableConfiguration)) {
        log("[personalisation] recommend returned a malformed configuration, so nothing was suggested");
        return unavailable;
      }
      const { id } = repo.recordRecommendation(
        {
          modelVersion: loaded.record.version,
          configuration: result.configuration,
          alternatives,
          scores: Array.isArray(result.scores) ? result.scores : [],
          explanation: { summary: String(result.explanation?.summary ?? ""), reasons: (result.explanation?.reasons ?? []).map(String) },
          warnings,
          snapshot,
        },
        at,
      );
      const stored = repo.recommendation(id);
      return { body: { recommendation: stored ? publicDto(stored) : null, status: "ok", warnings } };
    }),

    postFeedback: route({ mutation: true, body: true, session: "required" }, async (ctx) => {
      const id = await recommendationId(ctx);
      const feedback = unwrap(parseFeedback(ctx.body));
      const result = forSubject(ctx.db, ctx.subjectId!).recordFeedback(id, feedback, ctx.now);
      if (!result.ok) throw new HttpError(result.status, result.error);
      return { body: { ok: true } };
    }),

    postRating: route({ mutation: true, body: true, session: "required" }, async (ctx) => {
      const id = await recommendationId(ctx);
      const satisfaction = unwrap(parseRating(ctx.body));
      const result = forSubject(ctx.db, ctx.subjectId!).rate(id, satisfaction, ctx.now);
      if (!result.ok) throw new HttpError(result.status, result.error);
      return { body: { ok: true } };
    }),

    getExport: route({ mutation: false, body: false, session: "required" }, ({ db, subjectId, now: at }) => ({
      body: forSubject(db, subjectId!).exportAll(at),
      headers: { "Content-Disposition": 'attachment; filename="dial-personalisation-data.json"' },
    })),

    deleteAll: route({ mutation: true, body: false, session: "optional" }, ({ db, subjectId, secure, setCookie }) => {
      if (subjectId) forSubject(db, subjectId).deleteAll();
      setCookie(clearedSessionCookie(secure));
      return { body: { deleted: true } };
    }),

    getModel: route({ mutation: false, body: false, session: "none" }, ({ db }) => {
      const loaded = loadModel(db);
      if (!loaded) throw new HttpError(503, "No model is available right now");
      const r = loaded.record;
      return { body: { version: r.version, algorithm: r.algorithm, trainedOn: r.trainedOn, createdAt: iso(r.createdAt), metrics: r.metrics } };
    }),
  };
}
