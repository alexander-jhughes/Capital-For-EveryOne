// A light limit on Gemini calls per visitor, in memory. It protects the quota during a demo, and counts each server
// instance separately, so it is not a security control. Going over it never blocks an answer: see handleAsk.

const WINDOW_MS = 60_000;
const MAX_CALLS = 20;
const MAX_TRACKED = 1000;

const calls = new Map<string, number[]>();

/** The caller's address, or one shared bucket if there isn't one. */
export const clientKey = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";

/** True if this visitor may use the model now, and counts it. */
export function allowModelCall(key: string, now = Date.now()): boolean {
  const recent = (calls.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_CALLS) {
    calls.set(key, recent);
    return false;
  }
  if (!calls.has(key) && calls.size >= MAX_TRACKED) calls.clear();
  calls.set(key, [...recent, now]);
  return true;
}

/** For tests. */
export const resetRateLimit = () => calls.clear();
