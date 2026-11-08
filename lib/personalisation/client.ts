// Browser client for Dial's own personalisation API (/api/personalisation). No third parties, no Gemini.
// Never throws: if the server or database is unavailable, calls resolve to null/false and the app carries on
// without suggestions ("Make it yours" and every setting keep working).
//
// Defence in depth: a suggestion's preview actions are rebuilt here from catalog item ids, so only actions from
// lib/recommender/catalog.ts can ever reach the preview, whatever the response contains.
import type { Preferences } from "../preferences/schema";
import { CATALOG, configurationActions, type Dimension, isItemId, type ItemId } from "../recommender/catalog";
import { type ProfileAnswers, type ResearchAnswers, sanitizeAnswers, sanitizeResearch } from "../recommender/profile";
import type { Configuration, EvidenceLevel, FeedbackOutcome, SignalId, SignalSource, Warning } from "../recommender/types";
import type { Mode } from "../types";

const BASE = "/api/personalisation";

export interface ConsentState {
  personalisation: boolean;
  collaborative: boolean;
  research: boolean;
}

export interface ServerStatus {
  /** False when the server says the database is unavailable, or it can't be reached. */
  available: boolean;
  consent: ConsentState;
  profile: { answers: ProfileAnswers; answered: number } | null;
  research: ResearchAnswers | null;
  model: { version: string; trainedOn: string } | null;
}

export const OFFLINE: ServerStatus = {
  available: false,
  consent: { personalisation: false, collaborative: false, research: false },
  profile: null,
  research: null,
  model: null,
};

export interface Suggestion {
  id: string;
  modelVersion: string;
  trainedOn: "synthetic" | "synthetic+real";
  configuration: Configuration;
  alternatives: Configuration[];
  explanation: { summary: string; reasons: string[] };
  warnings: Warning[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const strList = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, 500)) : []);
const EVIDENCE: readonly EvidenceLevel[] = ["strong", "moderate", "limited", "insufficient"];
const WARNING_CODES: readonly Warning["code"][] = ["synthetic_only", "few_answers", "limited_evidence", "low_confidence", "fatigue", "model_unavailable"];

async function call(path: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const send = (method: "PUT" | "POST" | "DELETE", path: string, body?: unknown) =>
  call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export function parseStatus(v: unknown): ServerStatus {
  if (!isObj(v) || !isObj(v.consent)) return OFFLINE;
  const c = v.consent;
  const on = (x: unknown) => x === "granted" || x === true;
  const consent = { personalisation: on(c.personalisation), collaborative: on(c.collaborative), research: on(c.research) };
  const profile = isObj(v.profile) ? (() => {
    const answers = sanitizeAnswers(v.profile.answers);
    return { answers, answered: Object.keys(answers).length };
  })() : null;
  return {
    available: v.available !== false,
    consent,
    profile,
    research: isObj(v.research) ? sanitizeResearch(v.research) : null,
    model: isObj(v.model) && typeof v.model.version === "string" ? { version: str(v.model.version, 100), trainedOn: str(v.model.trainedOn, 40) } : null,
  };
}

/** Rebuilds a configuration from item ids. Unknown items, or an empty list, make it invalid (null). */
function parseConfiguration(v: unknown): Configuration | null {
  if (!isObj(v) || !Array.isArray(v.items) || v.items.length === 0 || !v.items.every(isItemId)) return null;
  const items = [...new Set(v.items as ItemId[])];
  const { actions, mode } = configurationActions(items);
  const confidence = typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 1 ? v.confidence : 0;
  return {
    items,
    actions,
    ...(mode ? { mode } : {}),
    title: str(v.title, 200) || items.map((id) => CATALOG[id].title).join(", "),
    offer: str(v.offer, 400),
    confidence,
    evidence: EVIDENCE.includes(v.evidence as EvidenceLevel) ? (v.evidence as EvidenceLevel) : "insufficient",
  };
}

export function parseSuggestion(v: unknown): Suggestion | null {
  if (!isObj(v) || typeof v.id !== "string" || v.id.length > 100) return null;
  const configuration = parseConfiguration(v.configuration);
  if (!configuration) return null;
  const explanation = isObj(v.explanation) ? { summary: str(v.explanation.summary), reasons: strList(v.explanation.reasons, 8) } : { summary: "", reasons: [] };
  const warnings = Array.isArray(v.warnings)
    ? v.warnings.filter((w): w is Warning => isObj(w) && WARNING_CODES.includes(w.code as Warning["code"]) && typeof w.text === "string").slice(0, 6)
    : [];
  return {
    id: v.id,
    modelVersion: str(v.modelVersion, 100),
    trainedOn: v.trainedOn === "synthetic+real" ? "synthetic+real" : "synthetic",
    configuration,
    alternatives: (Array.isArray(v.alternatives) ? v.alternatives : []).map(parseConfiguration).filter((c): c is Configuration => c !== null).slice(0, 2),
    explanation,
    warnings,
  };
}

export const getStatus = async () => {
  const v = await call("");
  return v === null ? OFFLINE : parseStatus(v);
};

/** Returns the new status, or null if the change didn't go through. */
export const putConsent = async (change: Partial<ConsentState>) => {
  const v = await send("PUT", "/consent", change);
  return v === null ? null : parseStatus(v);
};

export const putProfile = async (answers: ProfileAnswers) => (await send("PUT", "/profile", { answers: sanitizeAnswers(answers) })) !== null;

export const putResearch = async (research: ResearchAnswers) => (await send("PUT", "/research", sanitizeResearch(research))) !== null;

export const postSignals = async (signals: { id: SignalId; source: SignalSource }[]) =>
  signals.length === 0 ? true : (await send("POST", "/signals", { signals: signals.slice(0, 20) })) !== null;

export async function postRecommendation(body: { preferences: Preferences; view: Mode; explicit: Dimension[] }): Promise<Suggestion | null> {
  const v = await send("POST", "/recommendations", body);
  return isObj(v) ? parseSuggestion(v.recommendation) : null;
}

export const postFeedback = async (id: string, body: { outcome: FeedbackOutcome; items?: ItemId[]; via?: "card" | "undo" | "settings" | "reset" }) =>
  (await send("POST", `/recommendations/${encodeURIComponent(id)}/feedback`, body)) !== null;

export const postRating = async (id: string, satisfaction: -1 | 0 | 1) =>
  (await send("POST", `/recommendations/${encodeURIComponent(id)}/rating`, { satisfaction })) !== null;

export const getExport = () => call("/export");

export const deleteEverything = async () => (await send("DELETE", "")) !== null;
