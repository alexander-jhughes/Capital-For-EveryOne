// Strict validation of request bodies. Anything unknown is rejected (400), never silently dropped, so a client bug
// shows up at once instead of becoming bad training data.
import { DIMENSIONS, isDimension, isItemId, type Dimension, type ItemId } from "../../recommender/catalog";
import { AGE_BANDS, isValidAnswers, type AgeBand, type ProfileAnswers, type ResearchAnswers } from "../../recommender/profile";
import { isSignalId, type FeedbackOutcome, type SignalId, type SignalSource } from "../../recommender/types";
import { sanitize, type Preferences } from "../../preferences/schema";
import type { Mode } from "../../types";
import { isFeedbackOutcome, isFeedbackVia, isSatisfaction, isSignalSource, LIMITS, type FeedbackVia, type Satisfaction } from "./domain";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(body: unknown, allowed: readonly string[]): Parsed<Obj> {
  if (!isObject(body)) return fail("The body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  return unknown.length ? fail(`Unknown field: ${unknown[0].slice(0, 40)}`) : ok(body);
}

/** Deep equality for JSON values: object key order ignored, array order kept. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

export interface ConsentChange {
  personalisation?: boolean;
  collaborative?: boolean;
  research?: boolean;
}

export function parseConsent(body: unknown): Parsed<ConsentChange> {
  const o = onlyKeys(body, ["personalisation", "collaborative", "research"]);
  if (!o.ok) return o;
  const out: ConsentChange = {};
  for (const k of ["personalisation", "collaborative", "research"] as const) {
    const v = o.value[k];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return fail(`${k} must be true or false`);
    out[k] = v;
  }
  return ok(out);
}

export function parseProfile(body: unknown): Parsed<ProfileAnswers> {
  const o = onlyKeys(body, ["answers"]);
  if (!o.ok) return o;
  if (!isValidAnswers(o.value.answers)) return fail("answers has an unknown question or value");
  return ok(o.value.answers);
}

export function parseResearch(body: unknown): Parsed<ResearchAnswers> {
  const o = onlyKeys(body, ["ageBand"]);
  if (!o.ok) return o;
  const v = o.value.ageBand;
  if (v === undefined || v === null) return ok({});
  if (!(AGE_BANDS as readonly unknown[]).includes(v)) return fail("ageBand isn't one of the listed bands");
  return ok({ ageBand: v as AgeBand });
}

export function parseSignals(body: unknown): Parsed<{ id: SignalId; source: SignalSource }[]> {
  const o = onlyKeys(body, ["signals"]);
  if (!o.ok) return o;
  const list = o.value.signals;
  if (!Array.isArray(list) || list.length === 0) return fail("signals must be a non-empty list");
  if (list.length > LIMITS.signalsPerRequest) return fail(`At most ${LIMITS.signalsPerRequest} signals per request`);
  const out: { id: SignalId; source: SignalSource }[] = [];
  for (const s of list) {
    const e = onlyKeys(s, ["id", "source"]);
    if (!e.ok) return e;
    if (!isSignalId(e.value.id)) return fail("Unknown signal id");
    if (!isSignalSource(e.value.source)) return fail("Unknown signal source");
    out.push({ id: e.value.id, source: e.value.source });
  }
  return ok(out);
}

export interface RecommendationRequest {
  preferences: Preferences;
  view: Mode;
  explicit: Dimension[];
}

export function parseRecommendationRequest(body: unknown): Parsed<RecommendationRequest> {
  const o = onlyKeys(body, ["preferences", "view", "explicit"]);
  if (!o.ok) return o;
  const { preferences, view, explicit } = o.value;
  if (!isObject(preferences)) return fail("preferences must be an object");
  const clean = sanitize(preferences);
  if (!jsonEqual(clean, preferences)) return fail("preferences has an unknown or invalid setting");
  if (view !== "simple" && view !== "complex") return fail("view must be simple or complex");
  if (!Array.isArray(explicit) || explicit.length > DIMENSIONS.length * 2) return fail("explicit must be a list of dimensions");
  if (!explicit.every(isDimension)) return fail("explicit has an unknown dimension");
  return ok({ preferences: clean, view, explicit: DIMENSIONS.filter((d) => explicit.includes(d)) });
}

export interface FeedbackRequest {
  outcome: FeedbackOutcome;
  items?: ItemId[];
  via?: FeedbackVia;
}

export function parseFeedback(body: unknown): Parsed<FeedbackRequest> {
  const o = onlyKeys(body, ["outcome", "items", "via"]);
  if (!o.ok) return o;
  const { outcome, items, via } = o.value;
  if (!isFeedbackOutcome(outcome)) return fail("Unknown outcome");
  const out: FeedbackRequest = { outcome };
  if (items !== undefined) {
    if (!Array.isArray(items) || items.length > 16) return fail("items must be a list of item ids");
    if (!items.every(isItemId)) return fail("items has an unknown item");
    out.items = [...new Set(items)];
  }
  if (via !== undefined && via !== null) {
    if (!isFeedbackVia(via)) return fail("Unknown via");
    out.via = via;
  }
  return ok(out);
}

export function parseRating(body: unknown): Parsed<Satisfaction> {
  const o = onlyKeys(body, ["satisfaction"]);
  if (!o.ok) return o;
  return isSatisfaction(o.value.satisfaction) ? ok(o.value.satisfaction) : fail("satisfaction must be -1, 0 or 1");
}

/** Recommendation ids are UUIDs. Anything else can't be one of ours (404, not 400, so ids can't be probed). */
export const isRecommendationId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
