// In-memory sliding-window rate limits: per subject once there is a session, per address before.
// Each server process counts on its own, so this limits abuse of one instance; it is not a distributed quota.

export interface RateLimit {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  /** Counts a hit. Returns 0 if allowed, else the seconds to wait. */
  hit(key: string, now: number): number;
  reset(): void;
}

const MAX_TRACKED = 10_000;

export function createRateLimiter(limit: RateLimit): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, now) {
      const recent = (hits.get(key) ?? []).filter((at) => now - at < limit.windowMs);
      if (recent.length >= limit.max) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((recent[0] + limit.windowMs - now) / 1000));
      }
      if (!hits.has(key) && hits.size >= MAX_TRACKED) {
        // Drop windows that have expired; if every one is live, start again rather than grow without bound.
        for (const [k, times] of hits) if (times.every((at) => now - at >= limit.windowMs)) hits.delete(k);
        if (hits.size >= MAX_TRACKED) hits.clear();
      }
      recent.push(now);
      hits.set(key, recent);
      return 0;
    },
    reset: () => hits.clear(),
  };
}

/** The caller's address (first X-Forwarded-For hop), or one shared bucket when there isn't one. */
export const clientAddress = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip")?.trim() || "local";
