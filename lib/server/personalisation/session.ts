// The pseudonymous session: cookie `cfe-pid` = `v1.<subject id>.<base64url HMAC-SHA256>`.
//
// Created only when the person turns personalisation on. HttpOnly (no script can read it), SameSite=Lax, scoped to
// /api/personalisation, Secure on https. Signed so a client can't pick someone else's id; a valid signature for a
// subject that no longer exists (deleted, or purged after 400 days) counts as no session and the cookie is cleared.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDatabasePath, isMemoryPath, type Database } from "../db/sqlite";
import { forSubject, isSubjectIdShape } from "./repository";

export const SESSION_COOKIE = "cfe-pid";
export const SESSION_COOKIE_PATH = "/api/personalisation";
/** 400 days: the most browsers allow, and the same as the inactive-subject retention. */
export const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;
const VERSION = "v1";

export interface SessionCodec {
  /** The cookie value for a subject id. */
  sign(subjectId: string): string;
  /** The subject id if the value is well formed and correctly signed, else null. */
  verify(value: string | null | undefined): string | null;
}

export function createSessionCodec(secret: string): SessionCodec {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`The session secret must be at least ${MIN_SECRET_LENGTH} characters`);
  const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  return {
    sign: (subjectId) => `${VERSION}.${subjectId}.${mac(`${VERSION}.${subjectId}`).toString("base64url")}`,
    verify(value) {
      if (!value || value.length > 200) return null;
      const parts = value.split(".");
      if (parts.length !== 3 || parts[0] !== VERSION || !isSubjectIdShape(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
      const given = Buffer.from(parts[2], "base64url");
      const expected = mac(`${VERSION}.${parts[1]}`);
      return given.length === expected.length && timingSafeEqual(given, expected) ? parts[1] : null;
    },
  };
}

/** One cookie's value from the request, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** https directly, or behind a proxy that says so. */
export const isSecureRequest = (request: Request) =>
  new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";

const attributes = (secure: boolean) => `Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

export const sessionCookie = (codec: SessionCodec, subjectId: string, secure: boolean) =>
  `${SESSION_COOKIE}=${codec.sign(subjectId)}; Max-Age=${SESSION_MAX_AGE_S}; ${attributes(secure)}`;

export const clearedSessionCookie = (secure: boolean) => `${SESSION_COOKIE}=; Max-Age=0; ${attributes(secure)}`;

export interface Session {
  /** The verified subject, or null. */
  subjectId: string | null;
  /** True when the request carried a cookie that no longer names anyone: the response should clear it. */
  stale: boolean;
}

/** Reads and verifies the session. Never creates one. */
export function readSession(request: Request, db: Database, codec: SessionCodec): Session {
  const raw = readCookie(request, SESSION_COOKIE);
  if (raw === null || raw === "") return { subjectId: null, stale: false };
  const id = codec.verify(raw);
  if (!id || !forSubject(db, id).exists()) return { subjectId: null, stale: true };
  return { subjectId: id, stale: false };
}

// ------------------------------------------------------------------------------------------------------------------
// The secret
// ------------------------------------------------------------------------------------------------------------------

export const SECRET_FILE_NAME = "personalisation-secret";

let warnedShort = false;

/**
 * `PERSONALISATION_SECRET` if it is long enough. Otherwise a random secret generated once and kept in
 * `<dataDirectory>/personalisation-secret` (mode 0600), so sessions survive a restart. With no data directory
 * (an in-memory database) the secret lives for this process only.
 */
export function resolveSecret(options: { env?: string | undefined; dataDirectory: string | null }): string {
  const fromEnv = options.env?.trim();
  if (fromEnv && fromEnv.length >= MIN_SECRET_LENGTH) return fromEnv;
  if (fromEnv && !warnedShort) {
    warnedShort = true;
    console.warn(`[personalisation] PERSONALISATION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters, so it is ignored`);
  }
  if (options.dataDirectory === null) return randomBytes(32).toString("base64url");
  const file = join(options.dataDirectory, SECRET_FILE_NAME);
  const read = () => {
    const value = readFileSync(file, "utf8").trim();
    if (value.length < MIN_SECRET_LENGTH) throw new Error(`${SECRET_FILE_NAME} is too short`);
    return value;
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(options.dataDirectory, { recursive: true });
  try {
    // "wx": fail if another process created it meanwhile, then read theirs.
    writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return read();
}

const holder = globalThis as typeof globalThis & { __cfePersonalisationCodec?: SessionCodec };

/** The app's codec: env secret, else the generated file next to the database. Throws if neither works. */
export function getAppSessionCodec(): SessionCodec {
  if (holder.__cfePersonalisationCodec) return holder.__cfePersonalisationCodec;
  const dbPath = defaultDatabasePath();
  const codec = createSessionCodec(resolveSecret({ env: process.env.PERSONALISATION_SECRET, dataDirectory: isMemoryPath(dbPath) ? null : dirname(dbPath) }));
  holder.__cfePersonalisationCodec = codec;
  return codec;
}
