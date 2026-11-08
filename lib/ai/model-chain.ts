// Which Gemini models to try, in order. Each model has its own quota, so when one is rate limited (HTTP 429) or briefly
// unavailable, the next one is tried instead of falling back to a fixed sentence. Server-side only.
import { ApiError } from "@google/genai";

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
/** Used after the main model, unless GEMINI_FALLBACK_MODELS says otherwise (comma separated, empty to turn off). */
const DEFAULT_BACKUPS = ["gemini-3.1-flash-lite", "gemini-3-flash-preview"];

/** The main model first, then the backups, without repeats. */
export function modelChain(env: Record<string, string | undefined> = process.env): string[] {
  const main = env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const raw = env.GEMINI_FALLBACK_MODELS;
  const backups = raw === undefined ? DEFAULT_BACKUPS : raw.split(",").map((m) => m.trim()).filter(Boolean);
  return [...new Set([main, ...backups])];
}

/** Errors that another model might not have: out of quota, overloaded, or a model this key can't use. */
export const isRetryableOnAnotherModel = (error: unknown) => error instanceof ApiError && [404, 429, 500, 503].includes(error.status);

/** Whether an error means "Gemini is busy or out of quota", for telling the person honestly. */
export const isRateLimit = (error: unknown) => error instanceof ApiError && error.status === 429;

/** Runs `call` with each model in turn until one works. Only quota, overload and missing-model errors move on. */
export async function withModelFallback<T>(models: string[], call: (model: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const model of models) {
    try {
      return await call(model);
    } catch (error) {
      last = error;
      if (!isRetryableOnAnotherModel(error)) throw error;
    }
  }
  throw last;
}
