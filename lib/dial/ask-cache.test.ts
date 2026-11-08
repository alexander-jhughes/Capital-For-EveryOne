import { describe, expect, it, vi } from "vitest";
import type { AskOutcome } from "../assistant/client";
import { askKey, createAskCache } from "./ask-cache";

const answer = (text: string): AskOutcome => ({
  kind: "answer",
  response: { answer: text, evidenceIds: [], source: "model" },
  experience: { template: "general", intent: null },
  followUps: [],
});

describe("ask cache", () => {
  it("normalises case, spacing and end punctuation, but not the state or previous question", () => {
    const base = { question: "What did I spend?", state: "{}" };
    expect(askKey(base)).toBe(askKey({ question: "  what did I   spend ", state: "{}" }));
    expect(askKey(base)).not.toBe(askKey({ ...base, state: '{"purchases":[1]}' }));
    expect(askKey(base)).not.toBe(askKey({ ...base, previousQuestion: "groceries" }));
    expect(askKey(base)).not.toBe(askKey({ ...base, style: "brief" }));
  });

  it("joins a request already in flight instead of sending a second", async () => {
    const cache = createAskCache();
    let resolve!: (o: AskOutcome) => void;
    const fetcher = vi.fn(() => new Promise<AskOutcome>((r) => (resolve = r)));
    const a = cache.run("k", fetcher);
    const b = cache.run("k", fetcher);
    resolve(answer("x"));
    expect(await a).toEqual(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.stats).toEqual({ network: 1, reused: 0, joined: 1 });
  });

  it("reuses a recent answer, then expires it", async () => {
    let t = 0;
    const cache = createAskCache({ ttlMs: 1000, now: () => t });
    const fetcher = vi.fn(async () => answer("x"));
    await cache.run("k", fetcher);
    t = 999;
    await cache.run("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    t = 1000;
    await cache.run("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never keeps failures, cancellations or rejected questions", async () => {
    const cache = createAskCache();
    for (const outcome of [{ kind: "unavailable" }, { kind: "cancelled" }, { kind: "invalid", message: "no" }] as AskOutcome[]) {
      const fetcher = vi.fn(async () => outcome);
      await cache.run("k", fetcher);
      await cache.run("k", fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    expect(cache.size).toBe(0);
  });

  it("keeps at most `max` answers, dropping the oldest", async () => {
    const cache = createAskCache({ max: 2 });
    for (const k of ["a", "b", "c"]) await cache.run(k, async () => answer(k));
    expect(cache.size).toBe(2);
    const fetcher = vi.fn(async () => answer("a"));
    await cache.run("a", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
