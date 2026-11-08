// One visitor's session: the events since the seed (approved purchases and payments), their Spend Pause choices and
// their goals. Never a balance: every figure is worked out again from the seed and these events (lib/server/account.ts).
// The wire form is compact JSON signed with HMAC-SHA256, so a browser can present only what this server signed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { DEMO_TODAY } from "../demo-clock";
import type { Goal, GoalSpec } from "../dial/types";
import { sanitizeGoals } from "../goals/store";
import { parseClientState } from "../ai/live-state";
import type { SpendPauseActivity } from "../spend-pause/state";
import type { Payment, Pence, SpendPauseSettings, Transaction } from "../types";

export interface Session {
  /** null until the person has saved a choice: the app then uses its default (Spend Pause off). */
  settings: SpendPauseSettings | null;
  activity: SpendPauseActivity;
  /** Approved purchases, oldest first, as transactions. Seed transactions are never stored. */
  purchases: Transaction[];
  /** Payments made, oldest first. */
  payments: Payment[];
  goals: Goal[];
}

/** The same ceiling as the live state /api/ask accepts, so Dial can always answer from a session. */
export const MAX_EVENTS = 50;
/** How long a signed session stays valid. The cookie expires at the same time. */
export const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Browsers drop cookies near 4 KB, so the whole value (payload and signature) must stay under this. */
export const MAX_COOKIE_BYTES = 3584;

export const emptySession = (): Session => ({ settings: null, activity: { activatedAt: null, deactivatedAt: null }, purchases: [], payments: [], goals: [] });

export const isEmpty = (s: Session) => s.settings === null && s.purchases.length === 0 && s.payments.length === 0 && s.goals.length === 0;

// ---- Wire format, version 1. Short keys and tuples keep 50 events inside one cookie. ----

type WirePurchase = [id: string, date: string, merchant: string, amount: Pence];
type WirePayment = [id: string, date: string, amount: Pence, kind: "m" | "s" | "c"];
type WireSpec = ["c", string, Pence] | ["r", Pence, string, string] | ["b"];
type WireGoal = [id: string, createdOn: string, spec: WireSpec];
type WireSettings = [enabled: 0 | 1, threshold: Pence | null, budget: Pence | null, quietStart: string | null, quietEnd: string | null];

interface Wire {
  v: 1;
  /** Issued at, in seconds. */
  t: number;
  s?: WireSettings;
  a?: [string | null, string | null];
  p?: WirePurchase[];
  y?: WirePayment[];
  g?: WireGoal[];
}

const KIND_TO_WIRE = { minimum: "m", statement: "s", custom: "c" } as const;
const WIRE_TO_KIND = { m: "minimum", s: "statement", c: "custom" } as const;

const specToWire = (spec: GoalSpec): WireSpec => {
  switch (spec.kind) {
    case "category_cap":
      return ["c", spec.category, spec.monthlyLimit];
    case "spend_reduction":
      return ["r", spec.target, spec.by, spec.baselineMonth];
    case "stay_in_budget":
      return ["b"];
  }
};

/** Back to the shape sanitizeSpec checks. Anything odd becomes a shape it will refuse. */
const specFromWire = (w: unknown): unknown => {
  if (!Array.isArray(w)) return null;
  switch (w[0]) {
    case "c":
      return { kind: "category_cap", category: w[1], monthlyLimit: w[2] };
    case "r":
      return { kind: "spend_reduction", target: w[1], by: w[2], baselineMonth: w[3] };
    case "b":
      return { kind: "stay_in_budget" };
    default:
      return null;
  }
};

export function toWire(session: Session, issuedAt: number): Wire {
  const { settings: s, activity: a } = session;
  return {
    v: 1,
    t: issuedAt,
    ...(s ? { s: [s.enabled ? 1 : 0, s.singlePurchaseThreshold, s.monthlyBudget, s.quietHours?.start ?? null, s.quietHours?.end ?? null] as WireSettings } : {}),
    ...(a.activatedAt || a.deactivatedAt ? { a: [a.activatedAt, a.deactivatedAt] as [string | null, string | null] } : {}),
    ...(session.purchases.length ? { p: session.purchases.map((p): WirePurchase => [p.id, p.date, p.merchant, p.amount]) } : {}),
    ...(session.payments.length ? { y: session.payments.map((p): WirePayment => [p.id, p.date, p.amount, KIND_TO_WIRE[p.kind]]) } : {}),
    ...(session.goals.length ? { g: session.goals.map((g): WireGoal => [g.id, g.createdOn, specToWire(g.spec)]) } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStamp = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)));
const isKind = (v: unknown): v is keyof typeof WIRE_TO_KIND => v === "m" || v === "s" || v === "c";
const tuple = (v: unknown, length: number): v is unknown[] => Array.isArray(v) && v.length === length;

/**
 * A session from its wire form, or null if any part of it breaks the rules. The signature already proves this server
 * wrote it; the checks here are the same ones /api/ask applies to a client state, so both paths trust exactly the same facts.
 */
export function fromWire(value: unknown, now: number, today = DEMO_TODAY): Session | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!Number.isInteger(value.t) || (value.t as number) > now + 300 || now - (value.t as number) > MAX_AGE_SECONDS) return null;
  const { s, a, p = [], y = [], g = [] } = value;
  if (!Array.isArray(p) || !Array.isArray(y) || !Array.isArray(g)) return null;
  if (!p.every((row) => tuple(row, 4)) || !y.every((row) => tuple(row, 4) && isKind(row[3]))) return null;

  const spendPause = s === undefined ? undefined : settingsFromWire(s);
  if (spendPause === null) return null;
  const parsed = parseClientState(
    {
      ...(spendPause ? { spendPause } : {}),
      purchases: p.map((row) => ({ id: row[0], date: row[1], merchant: row[2], amount: row[3] })),
      payments: y.map((row) => ({ id: row[0], date: row[1], amount: row[2] })),
    },
    today,
  );
  if (!parsed) return null;

  const activity: SpendPauseActivity = { activatedAt: null, deactivatedAt: null };
  if (a !== undefined) {
    if (!tuple(a, 2) || !isStamp(a[0]) || !isStamp(a[1])) return null;
    activity.activatedAt = a[0];
    activity.deactivatedAt = a[1];
  }

  const goals = sanitizeGoals(g.map((row) => (tuple(row, 3) ? { id: row[0], createdOn: row[1], spec: specFromWire(row[2]) } : null)));
  if (goals.length !== g.length) return null;

  return {
    settings: spendPause ?? null,
    activity,
    purchases: (parsed.purchases ?? []).map((row) => ({ id: row.id, date: row.date, merchant: row.merchant, amount: row.amount, category: "Shopping", status: "pending" })),
    payments: (parsed.payments ?? []).map((row, i) => ({ id: row.id, amount: row.amount, date: row.date, kind: WIRE_TO_KIND[(y[i] as WirePayment)[3]] })),
    goals,
  };
}

function settingsFromWire(s: unknown): SpendPauseSettings | null {
  if (!tuple(s, 5) || (s[0] !== 0 && s[0] !== 1)) return null;
  const [, threshold, budget, start, end] = s;
  if ((start === null) !== (end === null)) return null;
  // Shaped for isSpendPauseSettings, which parseClientState applies.
  return { enabled: s[0] === 1, singlePurchaseThreshold: threshold as Pence | null, monthlyBudget: budget as Pence | null, quietHours: start === null ? null : { start: start as string, end: end as string } };
}

// ---- Signing ----

const b64 = (bytes: Buffer) => bytes.toString("base64url");
const sign = (payload: string, secret: Buffer) => b64(createHmac("sha256", secret).update(payload).digest());

/** The signed cookie value: base64url(JSON).base64url(HMAC-SHA256). */
export function encodeSession(session: Session, secret: Buffer, now = Date.now()): string {
  const payload = b64(Buffer.from(JSON.stringify(toWire(session, Math.floor(now / 1000))), "utf8"));
  return `${payload}.${sign(payload, secret)}`;
}

/** The session a cookie value carries, or null when it was not signed by this server, has expired, or isn't readable. */
export function decodeSession(value: string | undefined, secret: Buffer, now = Date.now(), today = DEMO_TODAY): Session | null {
  if (!value || value.length > 4096) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secret), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return fromWire(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), Math.floor(now / 1000), today);
  } catch {
    return null;
  }
}
