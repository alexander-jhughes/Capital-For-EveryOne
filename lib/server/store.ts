// Where a visitor's session lives. The cookie store needs no database and works on serverless hosts: the signed session
// travels with every request. A Redis or KV store would keep only an id in the cookie and look the session up; it
// implements the same two methods, so the handlers and /api/ask never change.
import { sessionSecret } from "./secret";
import { MAX_AGE_SECONDS, MAX_COOKIE_BYTES, decodeSession, encodeSession, isEmpty, type Session } from "./session";

export const SESSION_COOKIE = "cfe-session";

export interface SessionStore {
  /** The visitor's session, or null when the request carries none this server can trust. */
  load(request: Request): Promise<Session | null>;
  /** Keeps the session and returns the headers the response must carry (such as Set-Cookie). Throws StoreError when it can't. */
  save(session: Session, request: Request): Promise<Record<string, string>>;
}

/** A problem the person can do something about, so the route returns it as a friendly 400. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** The named cookie's raw value from a Cookie header, or undefined. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const isSecure = (request: Request) => request.url.startsWith("https:") || request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";

/** HttpOnly so scripts can't read it, SameSite=Lax so another site can't send it, Secure wherever the app is served over HTTPS. */
export function cookieHeader(name: string, value: string, request: Request, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isSecure(request) ? "; Secure" : ""}`;
}

export interface CookieStoreOptions {
  /** Overrides SESSION_SECRET, for tests. */
  secret?: Buffer;
  now?: () => number;
}

export function createCookieStore({ secret, now = Date.now }: CookieStoreOptions = {}): SessionStore {
  const key = () => secret ?? sessionSecret();
  return {
    async load(request) {
      // Checked even with no cookie, so a server that can't keep changes says so on the first read, not the first change.
      const signingKey = key();
      const raw = readCookie(request, SESSION_COOKIE);
      return raw === undefined ? null : decodeSession(raw, signingKey, now());
    },
    async save(session, request) {
      // An empty session needs no cookie, so a visitor who undoes everything is back to a clean start.
      if (isEmpty(session)) return { "Set-Cookie": cookieHeader(SESSION_COOKIE, "", request, 0) };
      const value = encodeSession(session, key(), now());
      if (value.length > MAX_COOKIE_BYTES) throw new StoreError("There isn't room to keep that change. Undo a payment or remove a goal to make room.");
      return { "Set-Cookie": cookieHeader(SESSION_COOKIE, value, request, MAX_AGE_SECONDS) };
    },
  };
}

/** Sessions in memory behind an id cookie: the shape a database-backed store takes. For tests and local experiments only. */
export function createMemoryStore(ids: () => string = () => Math.random().toString(36).slice(2)): SessionStore & { sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();
  return {
    sessions,
    async load(request) {
      const id = readCookie(request, SESSION_COOKIE);
      return (id && sessions.get(id)) || null;
    },
    async save(session, request) {
      const id = readCookie(request, SESSION_COOKIE) ?? ids();
      sessions.set(id, session);
      return { "Set-Cookie": cookieHeader(SESSION_COOKIE, id, request, MAX_AGE_SECONDS) };
    },
  };
}

/** The store the app runs on. */
export const sessionStore: SessionStore = createCookieStore();
