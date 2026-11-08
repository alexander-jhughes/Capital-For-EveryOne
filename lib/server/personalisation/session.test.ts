import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSubject, forSubject } from "./repository";
import { clearedSessionCookie, createSessionCodec, readCookie, readSession, resolveSecret, SECRET_FILE_NAME, sessionCookie, SESSION_COOKIE } from "./session";
import { T0, testDb } from "./test-helpers";

const SECRET = "s".repeat(32);
const ID = "0123456789abcdef0123456789abcdef";

const withCookie = (value: string) => new Request("http://localhost/api/personalisation", { headers: { cookie: `other=1; ${SESSION_COOKIE}=${value}; x=y` } });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("session codec", () => {
  const codec = createSessionCodec(SECRET);

  it("signs and verifies a subject id", () => {
    const value = codec.sign(ID);
    expect(value).toMatch(/^v1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(codec.verify(value)).toBe(ID);
  });

  it("rejects tampering: another id, another signature, another secret, other versions and junk", () => {
    const value = codec.sign(ID);
    const [, , sig] = value.split(".");
    const otherId = "f".repeat(32);
    expect(codec.verify(`v1.${otherId}.${sig}`)).toBeNull();
    expect(codec.verify(`v1.${ID}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(createSessionCodec("t".repeat(32)).verify(value)).toBeNull();
    expect(codec.verify(value.replace(/^v1/, "v2"))).toBeNull();
    expect(codec.verify(`v1.${ID}`)).toBeNull();
    expect(codec.verify(`v1.${ID.toUpperCase()}.${sig}`)).toBeNull();
    expect(codec.verify("")).toBeNull();
    expect(codec.verify(null)).toBeNull();
    expect(codec.verify(`${value}.extra`)).toBeNull();
    expect(codec.verify("x".repeat(500))).toBeNull();
  });

  it("refuses a short secret", () => {
    expect(() => createSessionCodec("short")).toThrow(/at least 32/);
  });
});

describe("cookies", () => {
  it("reads one cookie among several", () => {
    expect(readCookie(withCookie("abc"), SESSION_COOKIE)).toBe("abc");
    expect(readCookie(new Request("http://x/"), SESSION_COOKIE)).toBeNull();
  });

  it("sets HttpOnly, SameSite=Lax, the API path, 400 days, and Secure only on https", () => {
    const codec = createSessionCodec(SECRET);
    const plain = sessionCookie(codec, ID, false);
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).toContain("Path=/api/personalisation");
    expect(plain).toContain(`Max-Age=${400 * 24 * 3600}`);
    expect(plain).not.toContain("Secure");
    expect(sessionCookie(codec, ID, true)).toContain("; Secure");
    expect(clearedSessionCookie(false)).toMatch(/^cfe-pid=; Max-Age=0; Path=\/api\/personalisation/);
  });
});

describe("readSession", () => {
  const codec = createSessionCodec(SECRET);

  it("finds the subject from a valid cookie", () => {
    const db = testDb();
    const id = createSubject(db, T0);
    expect(readSession(withCookie(codec.sign(id)), db, codec)).toEqual({ subjectId: id, stale: false });
  });

  it("treats no cookie as no session, without marking anything stale", () => {
    expect(readSession(new Request("http://x/"), testDb(), codec)).toEqual({ subjectId: null, stale: false });
  });

  it("treats a forged cookie as no session and asks for it to be cleared", () => {
    const db = testDb();
    const id = createSubject(db, T0);
    const forged = createSessionCodec("f".repeat(32)).sign(id);
    expect(readSession(withCookie(forged), db, codec)).toEqual({ subjectId: null, stale: true });
  });

  it("treats a valid signature for a deleted subject as no session", () => {
    const db = testDb();
    const id = createSubject(db, T0);
    forSubject(db, id).deleteAll();
    expect(readSession(withCookie(codec.sign(id)), db, codec)).toEqual({ subjectId: null, stale: true });
  });
});

describe("resolveSecret", () => {
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "cfe-secret-"));
    dirs.push(d);
    return d;
  };

  it("uses PERSONALISATION_SECRET when it is long enough", () => {
    expect(resolveSecret({ env: "e".repeat(40), dataDirectory: null })).toBe("e".repeat(40));
  });

  it("generates a secret once into the data directory and re-uses it", () => {
    const dir = tmp();
    const first = resolveSecret({ env: undefined, dataDirectory: join(dir, "data") });
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(join(dir, "data", SECRET_FILE_NAME), "utf8").trim()).toBe(first);
    expect(resolveSecret({ env: undefined, dataDirectory: join(dir, "data") })).toBe(first);
    if (process.platform !== "win32") expect(statSync(join(dir, "data", SECRET_FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it("ignores a short PERSONALISATION_SECRET and falls back to the file", () => {
    const dir = tmp();
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(resolveSecret({ env: "short", dataDirectory: dir })).not.toBe("short");
    } finally {
      console.warn = warn;
    }
  });

  it("refuses a secret file that is too short", () => {
    const dir = tmp();
    writeFileSync(join(dir, SECRET_FILE_NAME), "tiny");
    expect(() => resolveSecret({ env: undefined, dataDirectory: dir })).toThrow(/too short/);
  });

  it("makes a process-only secret for an in-memory database", () => {
    const a = resolveSecret({ env: undefined, dataDirectory: null });
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(resolveSecret({ env: undefined, dataDirectory: null })).not.toBe(a);
  });
});
