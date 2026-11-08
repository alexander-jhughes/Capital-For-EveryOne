// The person's saved profile: their consent, the needs they told us about, their own choice of type, and usage counts.
// Kept on the server side of the trust boundary: a signed, HttpOnly cookie (separate from the account session, so the
// account cookie's size budget and wire format are untouched). Like the session store, a database store would keep
// only an id in the cookie and implement the same three methods.
//
// Rules (FCA FG21/1 and the Money Advice Trust's TEXAS approach: explain, get explicit consent, record only what helps):
// - Nothing is kept until the person turns tailoring on. Turning it off deletes everything.
// - Health needs are kept only with a second, explicit consent. Withdrawing it deletes them.
// - The profile only changes how things are shown and worded. It never reaches payments, balances, Spend Pause or
//   any decision about credit. Dial still checks every figure against the account.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MODE_KEY } from "../demo-config";
import { isNeedId, isPersonType, isSensitive, NEED_IDS, PERSON_TYPES, type NeedId, type PersonType } from "../profile/catalog";
import { emptyUsage, USAGE_CAP, USAGE_KINDS, type ProfileInputs, type Usage, type UsageKind } from "../profile/features";
import { inferProfile, type ProfileResult } from "../profile/infer";
import { profileModel } from "../profile/model";
import type { ProfileModel } from "../profile/train";
import { deriveAccount } from "../state/derive-account";
import { settingsOf } from "./account";
import { sessionSecret, SessionSecretError } from "./secret";
import { MAX_AGE_SECONDS, type Session } from "./session";
import { cookieHeader, readCookie, sessionStore, type SessionStore } from "./store";

export const PROFILE_COOKIE = "cfe-profile";

export interface ProfileRecord {
  consent: boolean;
  /** The extra, explicit consent for health needs (special category data). */
  sensitiveConsent: boolean;
  needs: NeedId[];
  /** The type the person picked themselves. Always wins over the model. */
  chosen: PersonType | null;
  usage: Usage;
}

export const emptyProfile = (): ProfileRecord => ({ consent: false, sensitiveConsent: false, needs: [], chosen: null, usage: emptyUsage() });

// ---- Wire format, version 1 ----

interface Wire {
  v: 1;
  t: number;
  h?: 1;
  /** Need indexes into NEEDS. */
  n?: number[];
  k?: number;
  u?: number[];
}

export function profileToWire(p: ProfileRecord, issuedAt: number): Wire {
  return {
    v: 1,
    t: issuedAt,
    ...(p.sensitiveConsent ? { h: 1 as const } : {}),
    ...(p.needs.length ? { n: p.needs.map((id) => NEED_IDS.indexOf(id)) } : {}),
    ...(p.chosen ? { k: PERSON_TYPES.indexOf(p.chosen) } : {}),
    ...(USAGE_KINDS.some((k) => p.usage[k] > 0) ? { u: USAGE_KINDS.map((k) => p.usage[k]) } : {}),
  };
}

const isIndex = (v: unknown, length: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < length;

/** A record from its wire form, or null if any part breaks the rules (including a health need without its consent). */
export function profileFromWire(w: unknown, now: number): ProfileRecord | null {
  if (typeof w !== "object" || w === null || Array.isArray(w)) return null;
  const o = w as Record<string, unknown>;
  if (o.v !== 1 || !Number.isInteger(o.t) || (o.t as number) > now + 300 || now - (o.t as number) > MAX_AGE_SECONDS) return null;
  const n = o.n ?? [];
  if (!Array.isArray(n) || !n.every((i) => isIndex(i, NEED_IDS.length)) || new Set(n).size !== n.length) return null;
  if (o.k !== undefined && !isIndex(o.k, PERSON_TYPES.length)) return null;
  if (o.h !== undefined && o.h !== 1) return null;
  const u = o.u ?? USAGE_KINDS.map(() => 0);
  if (!Array.isArray(u) || u.length !== USAGE_KINDS.length || !u.every((c) => Number.isInteger(c) && c >= 0 && c <= USAGE_CAP)) return null;
  const needs = (n as number[]).map((i) => NEED_IDS[i]);
  const sensitiveConsent = o.h === 1;
  if (!sensitiveConsent && needs.some(isSensitive)) return null;
  return {
    consent: true,
    sensitiveConsent,
    needs,
    chosen: o.k === undefined ? null : PERSON_TYPES[o.k as number],
    usage: Object.fromEntries(USAGE_KINDS.map((k, i) => [k, u[i]])) as Usage,
  };
}

// ---- Signing. A domain prefix keeps a profile signature from ever validating as a session one, and the reverse. ----

const sign = (payload: string, secret: Buffer) => createHmac("sha256", secret).update(`profile|${payload}`).digest().toString("base64url");

export function encodeProfile(p: ProfileRecord, secret: Buffer, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify(profileToWire(p, Math.floor(now / 1000))), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeProfile(value: string | undefined, secret: Buffer, now = Date.now()): ProfileRecord | null {
  if (!value || value.length > 2048) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secret), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return profileFromWire(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), Math.floor(now / 1000));
  } catch {
    return null;
  }
}

export interface ProfileStore {
  load(request: Request): Promise<ProfileRecord | null>;
  /** A record without consent is deleted, never stored. */
  save(record: ProfileRecord, request: Request): Promise<Record<string, string>>;
}

export function createProfileCookieStore({ secret, now = Date.now }: { secret?: Buffer; now?: () => number } = {}): ProfileStore {
  const key = () => secret ?? sessionSecret();
  return {
    async load(request) {
      const signingKey = key();
      return decodeProfile(readCookie(request, PROFILE_COOKIE), signingKey, now());
    },
    async save(record, request) {
      if (!record.consent) return { "Set-Cookie": cookieHeader(PROFILE_COOKIE, "", request, 0) };
      return { "Set-Cookie": cookieHeader(PROFILE_COOKIE, encodeProfile(record, key(), now()), request, MAX_AGE_SECONDS) };
    },
  };
}

/** Profiles in memory behind a random id cookie: the shape a database store takes. Tests only. Ids must be unguessable. */
export function createProfileMemoryStore(ids: () => string = randomUUID): ProfileStore & { records: Map<string, ProfileRecord> } {
  const records = new Map<string, ProfileRecord>();
  return {
    records,
    async load(request) {
      const id = readCookie(request, PROFILE_COOKIE);
      return (id && records.get(id)) || null;
    },
    async save(record, request) {
      const id = readCookie(request, PROFILE_COOKIE) ?? ids();
      if (!record.consent) {
        records.delete(id);
        return { "Set-Cookie": cookieHeader(PROFILE_COOKIE, "", request, 0) };
      }
      records.set(id, record);
      return { "Set-Cookie": cookieHeader(PROFILE_COOKIE, id, request, MAX_AGE_SECONDS) };
    },
  };
}

export const profileStore: ProfileStore = createProfileCookieStore();

// ---- From saved data to the model's inputs ----

/** The model's inputs, from the server's own copy of the account. Nothing the browser says about money is used. */
export function profileInputs(record: ProfileRecord, session: Session | null, simpleView: boolean): ProfileInputs {
  const { account } = deriveAccount(session?.purchases ?? [], session?.payments ?? []);
  return {
    utilisation: account.creditLimit > 0 ? account.currentBalance / account.creditLimit : null,
    payments: (session?.payments ?? []).map((p) => ({ kind: p.kind })),
    goalKinds: (session?.goals ?? []).map((g) => g.spec.kind),
    spendPauseOn: session ? settingsOf(session).enabled : false,
    simpleView,
    needs: record.needs,
    usage: record.usage,
  };
}

export interface ProfileContext {
  record: ProfileRecord;
  result: ProfileResult | null;
}

/**
 * The person's profile and what it means, or null when there is none to use (no consent, unsigned, no model).
 * Never throws: Dial must keep answering whatever happens to the profile.
 */
export async function profileContext(
  request: Request,
  { profiles = profileStore, sessions = sessionStore, model = profileModel() }: { profiles?: ProfileStore; sessions?: SessionStore; model?: ProfileModel | null } = {},
): Promise<ProfileContext | null> {
  try {
    const record = await profiles.load(request);
    if (!record?.consent) return null;
    const session = await sessions.load(request).catch(() => null);
    const simple = readCookie(request, MODE_KEY) === "simple";
    return { record, result: model ? inferProfile(model, profileInputs(record, session, simple), record.chosen) : null };
  } catch (error) {
    if (!(error instanceof SessionSecretError)) console.warn("[profile] couldn't read the profile");
    return null;
  }
}

// ---- Validating what the browser asks for ----

export const PROFILE_MESSAGES = {
  unreadable: "Sorry, I couldn't read that. Please try again.",
  sensitive: "To keep anything about your health, please tick the extra consent first. Nothing has been saved.",
  noConsent: "Please turn on tailoring first. Nothing has been saved.",
};

export type ProfileChange = { ok: true; record: ProfileRecord } | { ok: false; message: string };

const ALLOWED_KEYS = new Set(["consent", "sensitiveConsent", "needs", "chosen"]);

/** Applies a PUT body. Unknown keys, unknown needs and health needs without consent are refused whole. */
export function applyProfileChange(current: ProfileRecord, body: unknown): ProfileChange {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: PROFILE_MESSAGES.unreadable };
  const o = body as Record<string, unknown>;
  if (Object.keys(o).some((k) => !ALLOWED_KEYS.has(k))) return { ok: false, message: PROFILE_MESSAGES.unreadable };
  if (o.consent !== undefined && typeof o.consent !== "boolean") return { ok: false, message: PROFILE_MESSAGES.unreadable };
  if (o.sensitiveConsent !== undefined && typeof o.sensitiveConsent !== "boolean") return { ok: false, message: PROFILE_MESSAGES.unreadable };
  if (o.needs !== undefined && (!Array.isArray(o.needs) || o.needs.length > NEED_IDS.length || !o.needs.every(isNeedId))) return { ok: false, message: PROFILE_MESSAGES.unreadable };
  if (o.chosen !== undefined && o.chosen !== null && !isPersonType(o.chosen)) return { ok: false, message: PROFILE_MESSAGES.unreadable };

  // Turning tailoring off is a full delete.
  if (o.consent === false) return { ok: true, record: emptyProfile() };
  if (!current.consent && o.consent !== true) return { ok: false, message: PROFILE_MESSAGES.noConsent };

  const sensitiveConsent = (o.sensitiveConsent as boolean | undefined) ?? current.sensitiveConsent;
  const asked = o.needs === undefined ? current.needs : [...new Set(o.needs as NeedId[])];
  if (!sensitiveConsent && o.needs !== undefined && asked.some(isSensitive)) return { ok: false, message: PROFILE_MESSAGES.sensitive };
  // Withdrawing the extra consent deletes the health needs it covered.
  const needs = sensitiveConsent ? asked : asked.filter((id) => !isSensitive(id));
  const chosen = o.chosen === undefined ? current.chosen : (o.chosen as PersonType | null);
  return { ok: true, record: { consent: true, sensitiveConsent, needs: NEED_IDS.filter((id) => needs.includes(id)), chosen, usage: current.usage } };
}

/** One more use of a part of the app, capped. Only counted with consent. */
export function countUsage(record: ProfileRecord, kind: unknown): ProfileRecord | null {
  if (!record.consent || !USAGE_KINDS.includes(kind as UsageKind)) return null;
  const k = kind as UsageKind;
  return { ...record, usage: { ...record.usage, [k]: Math.min(USAGE_CAP, record.usage[k] + 1) } };
}
