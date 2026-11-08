import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_SECRET_LENGTH, resetSecretWarning, sessionSecret, SessionSecretError } from "./secret";

const LONG = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretWarning();
});

describe("the signing key", () => {
  it("is SESSION_SECRET when it is long enough", () => {
    expect(sessionSecret({ SESSION_SECRET: LONG, NODE_ENV: "production" }).toString()).toBe(LONG);
    expect(LONG.length).toBe(MIN_SECRET_LENGTH);
  });

  it("refuses to run production on a missing or short key", () => {
    expect(() => sessionSecret({ NODE_ENV: "production" })).toThrow(SessionSecretError);
    expect(() => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow(SessionSecretError);
    expect(() => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: " ".repeat(40) })).toThrow(SessionSecretError);
  });

  it("derives a stable development key and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = sessionSecret({ NODE_ENV: "development" });
    const b = sessionSecret({ NODE_ENV: "development" });
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.toString()).not.toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("SESSION_SECRET");
  });

  it("a short SESSION_SECRET in development still changes the derived key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sessionSecret({ NODE_ENV: "development", SESSION_SECRET: "abc" }).equals(sessionSecret({ NODE_ENV: "development" }))).toBe(false);
  });

  it("stays quiet under the test runner", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sessionSecret({ NODE_ENV: "test" });
    sessionSecret({ NODE_ENV: "development", VITEST: "true" });
    expect(warn).not.toHaveBeenCalled();
  });
});
