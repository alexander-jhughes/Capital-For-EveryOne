// The only file that talks to Groq (https://console.groq.com). Server-side only: the key never reaches the browser.
// Groq's API is OpenAI-compatible, so this is a plain fetch call with no SDK: one attempt per model, our own timeout,
// JSON mode, and an error type that carries only the HTTP status (never the response body or the key).

export const GROQ_BASE = "https://api.groq.com/openai/v1";

/** An HTTP error from Groq. Only the status is kept, so nothing from the request or reply can reach a log. */
export class GroqApiError extends Error {
  constructor(readonly status: number) {
    super(`Groq API status ${status}`);
    this.name = "GroqApiError";
  }
}

export interface GroqConfig {
  apiKey: string;
  /** Only for tests against a local fake. Groq itself is always https. */
  baseUrl: string;
}

/** The key and endpoint from the environment, or null with no key. */
export function groqConfig(env: Record<string, string | undefined> = process.env): GroqConfig | null {
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseUrl: (env.GROQ_BASE_URL?.trim() || GROQ_BASE).replace(/\/$/, "") };
}

export interface JsonRequest {
  model: string;
  system: string;
  user: string;
  /** Described to the model in the system prompt. Every reply is still validated by the caller. */
  schema: object;
  maxTokens: number;
  signal: AbortSignal;
}

/** Reasoning models spend output tokens thinking; these tasks don't need it. */
const reasoningOptions = (model: string) => (model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : model.startsWith("qwen/") ? { reasoning_effort: "none" } : {});

/**
 * One chat completion in JSON mode. Resolves the parsed object, or null when the reply is not a complete, well-formed
 * JSON object (cut off, filtered, empty or not JSON). Throws GroqApiError on an HTTP error, and lets timeouts and
 * network errors through for the caller to describe.
 */
export async function groqJson(config: GroqConfig, req: JsonRequest): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: [
        { role: "system", content: `${req.system}\n\nReply with only a JSON object that matches this JSON Schema:\n${JSON.stringify(req.schema)}` },
        { role: "user", content: req.user },
      ],
      temperature: 0,
      max_completion_tokens: req.maxTokens,
      response_format: { type: "json_object" },
      ...reasoningOptions(req.model),
    }),
    signal: req.signal,
  });
  if (!response.ok) {
    // Drain the body so the connection is freed, but never keep or log it.
    await response.text().catch(() => "");
    throw new GroqApiError(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const choice = (body as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] })?.choices?.[0];
  // A cut-off or filtered reply is not an answer, whatever text came with it.
  if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(choice.message.content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short reason safe to log. Never the error itself, which could carry request details. */
export function describeError(error: unknown): string {
  if (error instanceof GroqApiError) return `API status ${error.status}`;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  if (error instanceof TypeError) return "connection failed";
  return "unexpected failure";
}
