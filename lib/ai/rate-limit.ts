// A light limit on Groq calls per visitor, in memory. It protects the quota during a demo, and counts each server
// instance separately, so it is not a security control. Going over it never blocks an answer: see handleAsk.

const WINDOW_MS = 60_000;
const DEFAULT_MAX_CALLS = 60;
const MAX_TRACKED = 1000;

const calls = new Map<string, number[]>();
const warned = new Map<string, number>();

/** Calls allowed per visitor per minute. ASK_MODEL_CALLS_PER_MINUTE overrides it, for long test runs. */
const maxCalls = () => {
  const set = Number(process.env.ASK_MODEL_CALLS_PER_MINUTE);
  return Number.isInteger(set) && set > 0 ? set : DEFAULT_MAX_CALLS;
};

/** The caller's address, or one shared bucket if there isn't one, as on a local dev server. */
export const clientKey = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";

/** True if this visitor may use the model now, and counts it. */
export function allowModelCall(key: string, now = Date.now()): boolean {
  const recent = (calls.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= maxCalls()) {
    calls.set(key, recent);
    // Say so once a minute, so a run of template answers is never a mystery.
    if (now - (warned.get(key) ?? 0) >= WINDOW_MS) {
      warned.set(key, now);
      console.warn(`[ask] Groq call limit reached (${maxCalls()} a minute), so answers are coming from templates for now`);
    }
    return false;
  }
  if (!calls.has(key) && calls.size >= MAX_TRACKED) calls.clear();
  calls.set(key, [...recent, now]);
  return true;
}

/** For tests. */
export const resetRateLimit = () => {
  calls.clear();
  warned.clear();
};
