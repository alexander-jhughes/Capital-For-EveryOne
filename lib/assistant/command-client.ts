// Browser side of POST /api/dial. Asks Gemini to read a request the on-device rules couldn't, and returns only steps
// that pass the same validateStep() as everything else Dial runs. Never throws; null means "no usable answer".
import type { TextSize } from "../preferences/schema";
import { validateStep } from "../dial/registry";
import type { DialStep } from "../dial/types";

export interface CommandScreen {
  route: string | null;
  mode: "simple" | "complex";
  textSize: TextSize;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");

/** Per tab, in memory only: the same words on the same screen are answered once. Failures are never kept. */
const recent = new Map<string, DialStep[]>();
const inFlight = new Map<string, Promise<DialStep[] | null | "busy">>();
const MAX_KEPT = 30;

export const clearCommandCache = () => {
  recent.clear();
  inFlight.clear();
};

export async function askGeminiForSteps(
  text: string,
  screen: CommandScreen,
  { fetchImpl = fetch, timeoutMs = 6000, signal }: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DialStep[] | null | "busy"> {
  const key = `${norm(text)}|${screen.route}|${screen.mode}|${screen.textSize}`;
  const hit = recent.get(key);
  if (hit) return hit;
  const running = inFlight.get(key);
  if (running) return running;

  const run = (async (): Promise<DialStep[] | null | "busy"> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCancel = () => controller.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener("abort", onCancel, { once: true });
    try {
      const res = await fetchImpl("/api/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim().slice(0, 300), screen }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body: unknown = await res.json().catch(() => null);
      const raw = (body as { steps?: unknown } | null)?.steps;
      const source = (body as { source?: unknown } | null)?.source;
      if ((body as { busy?: unknown } | null)?.busy === true) return "busy";
      if (!Array.isArray(raw) || source !== "model") return null;
      const steps = raw.slice(0, 3).map(validateStep).filter((s): s is DialStep => s !== null);
      if (steps.length > 0) {
        recent.set(key, steps);
        while (recent.size > MAX_KEPT) recent.delete(recent.keys().next().value as string);
      }
      return steps;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
    }
  })();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
