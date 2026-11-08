// Avoids duplicate /api/ask calls from the browser. Two things:
// 1. In flight: the same request asked twice while the first is still running shares the first's promise.
// 2. Recent: a repeat of a request answered in the last few minutes reuses that answer.
//
// Privacy: this lives in one tab's memory only (never storage, never the server), so it can never serve one
// person's answer to another. The key includes the account's live state, so any purchase, payment or Spend Pause
// change makes every older entry unreachable: an answer is never reused after the figures behind it changed.
import type { AskOutcome } from "../assistant/client";

export interface AskKeyParts {
  question: string;
  previousQuestion?: string;
  style?: string;
  /** JSON of the live state sent with the question. */
  state: string;
}

const norm = (s = "") => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");

export const askKey = (p: AskKeyParts) => JSON.stringify([norm(p.question), norm(p.previousQuestion), p.style ?? "standard", p.state]);

export interface AskCacheOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

export interface AskCacheStats {
  /** Requests that reached the network. */
  network: number;
  /** Repeats answered from memory. */
  reused: number;
  /** Repeats that joined a request already in flight. */
  joined: number;
}

export function createAskCache({ ttlMs = 5 * 60_000, max = 30, now = Date.now }: AskCacheOptions = {}) {
  const recent = new Map<string, { at: number; outcome: AskOutcome }>();
  const inFlight = new Map<string, Promise<AskOutcome>>();
  const stats: AskCacheStats = { network: 0, reused: 0, joined: 0 };

  /**
   * Runs `fetcher` unless the same key is in flight or recently answered. Only full answers are kept: a failure,
   * a cancellation or a rejected question is always retried next time.
   */
  async function run(key: string, fetcher: () => Promise<AskOutcome>): Promise<AskOutcome> {
    const hit = recent.get(key);
    if (hit && now() - hit.at < ttlMs) {
      stats.reused++;
      return hit.outcome;
    }
    if (hit) recent.delete(key);
    const running = inFlight.get(key);
    if (running) {
      stats.joined++;
      return running;
    }
    stats.network++;
    const p = fetcher().then((outcome) => {
      if (outcome.kind === "answer") {
        recent.set(key, { at: now(), outcome });
        while (recent.size > max) recent.delete(recent.keys().next().value as string);
      }
      return outcome;
    });
    inFlight.set(key, p);
    try {
      return await p;
    } finally {
      inFlight.delete(key);
    }
  }

  return { run, stats, clear: () => recent.clear(), get size() { return recent.size; } };
}

export type AskCache = ReturnType<typeof createAskCache>;
