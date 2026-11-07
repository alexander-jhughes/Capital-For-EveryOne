// Browser side of the assistant. Talks to POST /api/ask (Stage 3) using the agreed AskResponse contract,
// and falls back to the deterministic facts layer when the backend can't answer. Never writes answers itself.
import { buildFacts, type FactContext } from "../ai/facts";
import type { AskResponse, Intent } from "../types";
import { parseExperience, type Experience } from "./experience";
import type { DialStyle } from "../preferences/schema";
import type { ClientStateBody } from "./live-state";

/** The demo questions from docs/BRIEF.md. The intent is only used for the offline fallback. */
export const SUGGESTED_QUESTIONS: { question: string; intent: Intent }[] = [
  { question: "Did I pay Tesco twice this month?", intent: "duplicates" },
  { question: "What did I spend this month?", intent: "spend_this_month" },
  { question: "Has any subscription gone up?", intent: "price_changes" },
  { question: "When is my bill due?", intent: "days_until_due" },
];

export type AskOutcome =
  /** The backend answered. `resolvedQuestion` is what the backend understood (send it back as previousQuestion). */
  | { kind: "answer"; response: AskResponse; experience: Experience; resolvedQuestion?: string; followUps: string[] }
  /** The caller cancelled the request (a newer question replaced it). Show nothing for it. */
  | { kind: "cancelled" }
  /** The backend rejected the question (HTTP 400); `message` is its friendly text. */
  | { kind: "invalid"; message: string }
  /** No usable answer: network error, timeout, HTTP 5xx/404, or a malformed body. */
  | { kind: "unavailable" };

const SOURCES: AskResponse["source"][] = ["model", "template", "cache"];

/** Accepts only a body that matches AskResponse exactly; anything else counts as unavailable. */
export function parseAskResponse(body: unknown): AskResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const { answer, evidenceIds, source } = body as Record<string, unknown>;
  if (typeof answer !== "string" || answer.trim() === "") return null;
  if (!Array.isArray(evidenceIds) || !evidenceIds.every((id) => typeof id === "string")) return null;
  if (!SOURCES.includes(source as AskResponse["source"])) return null;
  return { answer: answer.trim(), evidenceIds, source: source as AskResponse["source"] };
}

export async function askDial(
  question: string | undefined,
  {
    fetchImpl = fetch,
    timeoutMs = 8000,
    state,
    previousQuestion,
    style,
    signal,
  }: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    state?: ClientStateBody;
    previousQuestion?: string;
    /** The person's answer style from their own display settings (dialStyle). Nothing learned or inferred. */
    style?: DialStyle;
    /** Abort to cancel an obsolete request, e.g. when the person asks something new or interrupts. */
    signal?: AbortSignal;
  } = {},
): Promise<AskOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCancel = () => controller.abort();
  if (signal?.aborted) return { kind: "cancelled" };
  signal?.addEventListener("abort", onCancel, { once: true });
  try {
    const res = await fetchImpl("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // previousQuestion lets the backend resolve follow-ups ("and last month?"). Only the person's own last question, max 300 chars.
      body: JSON.stringify({
        ...(question === undefined ? {} : { question }),
        ...(state ? { state } : {}),
        ...(previousQuestion?.trim() ? { previousQuestion: previousQuestion.trim().slice(0, 300) } : {}),
        ...(style && STYLES.includes(style) ? { style } : {}),
      }),
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 400) {
      const message = (body as { error?: unknown } | null)?.error;
      return { kind: "invalid", message: typeof message === "string" ? message : "Please try asking that another way." };
    }
    if (!res.ok) return { kind: "unavailable" };
    const response = parseAskResponse(body);
    // `experience` is optional and validated separately: a bad one never costs the answer itself.
    const experience = parseExperience((body as { experience?: unknown } | null)?.experience);
    if (!response) return { kind: "unavailable" };
    const extra = body as { resolvedQuestion?: unknown; followUps?: unknown };
    return { kind: "answer", response, experience, resolvedQuestion: parseResolvedQuestion(extra.resolvedQuestion), followUps: parseFollowUps(extra.followUps) };
  } catch {
    return signal?.aborted ? { kind: "cancelled" } : { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
  }
}

const STYLES: DialStyle[] = ["standard", "brief", "stepByStep"];
/** Plain text only: no markup, no control characters. */
const PLAIN = /^[^<>{}\u0000-\u001f]+$/;

/** The question the backend actually answered, or undefined. Optional field: a bad value never costs the answer. */
export function parseResolvedQuestion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const q = raw.trim();
  return q.length > 0 && q.length <= 300 && PLAIN.test(q) ? q : undefined;
}

/** Up to 3 suggested next questions, each plain text up to 120 characters, without duplicates. */
export function parseFollowUps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const q = item.trim();
    if (!q || q.length > 120 || !PLAIN.test(q) || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length === 3) break;
  }
  return out;
}

/** What the facts layer says for a known intent, used when the backend is unavailable. Up to two facts. */
export function offlineFacts(intent: Intent, ctx: FactContext) {
  const set = buildFacts(intent, ctx);
  return { facts: set.facts.slice(0, 2), evidenceIds: set.evidenceIds };
}

/** Evidence IDs that exist in the account, in the order given. Unknown IDs are dropped, never shown. */
export const knownEvidence = (ids: string[], transactionIds: Set<string>) => ids.filter((id) => transactionIds.has(id));

export const evidenceHref = (ids: string[]) => `/account/spending?highlight=${ids.join(",")}`;

export const intentForQuestion = (question: string) =>
  SUGGESTED_QUESTIONS.find((q) => q.question.toLowerCase() === question.trim().toLowerCase())?.intent ?? null;
