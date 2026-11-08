import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reveal, REVEAL_GAP_MS } from "./reveal";

// A minimal document: just the attributes reveal() sets on <html>. No view transitions, so updates apply directly.
beforeEach(() => {
  const attrs = new Map<string, string>();
  const documentElement = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k), getAttribute: (k: string) => attrs.get(k) ?? null, hasAttribute: (k: string) => attrs.has(k) };
  vi.stubGlobal("document", { documentElement });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reveal: one change at a time", () => {
  it("shows 1, then 1+2, then 1+2+3, a beat apart, then stops marking the page", () => {
    vi.useFakeTimers();
    const shown: number[] = [];
    reveal(3, (n) => shown.push(n), { reduced: false });
    vi.advanceTimersByTime(0);
    expect(shown).toEqual([1]);
    expect(document.documentElement.getAttribute("data-revealing")).toBe("true");
    vi.advanceTimersByTime(REVEAL_GAP_MS);
    expect(shown).toEqual([1, 2]);
    vi.advanceTimersByTime(REVEAL_GAP_MS);
    expect(shown).toEqual([1, 2, 3]);
    expect(document.documentElement.hasAttribute("data-revealing")).toBe(false);
  });

  it("with reduced motion, shows everything at once", () => {
    const shown: number[] = [];
    reveal(4, (n) => shown.push(n), { reduced: true });
    expect(shown).toEqual([4]);
  });

  it("can be stopped part way (the caller then keeps the full set itself)", () => {
    vi.useFakeTimers();
    const shown: number[] = [];
    const stop = reveal(3, (n) => shown.push(n), { reduced: false });
    vi.advanceTimersByTime(0);
    stop();
    vi.advanceTimersByTime(REVEAL_GAP_MS * 5);
    expect(shown).toEqual([1]);
    expect(document.documentElement.hasAttribute("data-revealing")).toBe(false);
  });
});
