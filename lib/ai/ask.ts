// The assistant flow: question -> intent -> facts -> phrasing -> guard. Facts and evidence never come from the model.
import type { AskResponse } from "../types";
import { cachedAnswer } from "./cache";
import { answerFacts, type AnswerFactSet } from "./answer-facts";
import { seedContext, type FactContext } from "./facts";
import { CANT_TELL, checkAnswer, isCantTell } from "./guard";
import { billQuestion, matchIntent, merchantSubject, namedMerchants, UNSUPPORTED, type AnswerIntent } from "./intent";
import { describeError, type AskModel } from "./model";
import { allowModelCall, clientKey } from "./rate-limit";
import { templateAnswer } from "./templates";

export const MAX_QUESTION_LENGTH = 300;
const MAX_BODY_BYTES = 4096;
const TIMEOUT_MS = 4000;
/** Below this a model call can't finish, so go straight to the fallback. */
const MIN_CALL_MS = 250;
const DEFAULT_QUESTION = "What did I spend this month?";

const MESSAGES = {
  empty: "Please type a question first.",
  tooLong: `Please keep your question to ${MAX_QUESTION_LENGTH} characters or fewer.`,
  unreadable: "Sorry, I couldn't read that. Please try asking again.",
  failed: "Sorry, something went wrong. Please try again.",
};

interface AskOptions {
  model: AskModel | null;
  ctx?: FactContext;
  timeoutMs?: number;
}

const log = (step: string, error: unknown) => console.warn(`[ask] ${step}: ${describeError(error)}`);

const unanswered = (): AskResponse => ({ answer: CANT_TELL, evidenceIds: [], source: "template" });

const fromTemplate = (facts: AnswerFactSet, question: string): AskResponse => ({
  answer: templateAnswer(facts, question),
  evidenceIds: facts.evidenceIds,
  source: "template",
});

/** The fixed wording for a demo question, unless the facts no longer support it. */
function fromCache(question: string, facts: AnswerFactSet): AskResponse | null {
  const cached = cachedAnswer(question);
  if (cached?.intent !== facts.intent || !checkAnswer(cached.answer, facts, question).ok) return null;
  return { answer: cached.answer, evidenceIds: facts.evidenceIds, source: "cache" };
}

/** Answers one question. Never throws for a model problem; the worst case is a template sentence. */
export async function answerQuestion(question: string | undefined, options: AskOptions): Promise<AskResponse> {
  const { model, ctx = seedContext(), timeoutMs = TIMEOUT_MS } = options;
  const asked = question ?? DEFAULT_QUESTION;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  const names = {
    merchants: [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))],
    categories: [...new Set(ctx.txns.map((t) => t.category))],
  };
  const match = matchIntent(asked, names);
  if (match === UNSUPPORTED) return unanswered();

  let intent: AnswerIntent | null = match;
  if (!intent && model) {
    try {
      intent = await model.classify(asked, remaining());
    } catch (error) {
      log("classify failed", error);
    }
  }
  if (!intent) return unanswered();

  const facts = answerFacts(intent, ctx, asked, merchantSubject(asked, names.merchants));
  // "Was Lidl charged twice?" must not be answered with the Tesco finding.
  const named = namedMerchants(asked, names.merchants);
  const factsText = facts.facts.map((f) => f.value).join(" ");
  const aboutOneShop = intent === "merchant_transactions" || intent === "merchant_refunds";
  if (!aboutOneShop && named.length > 0 && !named.some((merchant) => factsText.includes(merchant))) return unanswered();

  // Demo questions skip the model on purpose, so the live demo says the same thing every time.
  const cached = fromCache(asked, facts);
  if (cached) return cached;
  // "How much do I owe?" is the easiest answer to get dangerously wrong, so its wording is never left to the model.
  const owed = intent === "days_until_due" && billQuestion(asked) === "owed";
  if (owed || !model || remaining() < MIN_CALL_MS) return fromTemplate(facts, asked);

  let reply: string | null;
  try {
    reply = await model.phrase(asked, facts, remaining());
  } catch (error) {
    log("phrasing failed", error);
    return fromTemplate(facts, asked);
  }

  if (reply === null) return fromTemplate(facts, asked);
  const verdict = checkAnswer(reply, facts, asked);
  if (!verdict.ok) {
    console.warn(`[ask] reply rejected: ${verdict.reason}`);
    return fromTemplate(facts, asked);
  }
  // A reply that says the facts don't cover it has no evidence to show.
  if (isCantTell(reply)) return { answer: CANT_TELL, evidenceIds: [], source: "model" };
  return { answer: reply.trim(), evidenceIds: facts.evidenceIds, source: "model" };
}

/** The body as text, or null if it's too big. Stops reading at the limit, whatever the headers claim. */
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const decoder = new TextDecoder();
  const reader = request.body.getReader();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

type ParsedQuestion = { question: string | undefined } | { error: string };

/** A missing question means the default summary. An empty one is a mistake to tell the person about. */
function parseQuestion(body: string): ParsedQuestion {
  if (body.trim() === "") return { question: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: MESSAGES.unreadable };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: MESSAGES.unreadable };

  const { question } = parsed as { question?: unknown };
  if (question === undefined || question === null) return { question: undefined };
  if (typeof question !== "string") return { error: MESSAGES.unreadable };

  const trimmed = question.trim();
  if (trimmed === "") return { error: MESSAGES.empty };
  if (trimmed.length > MAX_QUESTION_LENGTH) return { error: MESSAGES.tooLong };
  return { question: trimmed };
}

/** The POST /api/ask handler, apart from choosing the model. Every failure is a friendly JSON message. */
export async function handleAsk(request: Request, createModel: () => AskModel | null): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const body = await readBody(request);
    if (body === null) return Response.json({ error: MESSAGES.tooLong }, { status: 400, headers });
    const parsed = parseQuestion(body);
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400, headers });
    // Over the limit still gets an answer. It just doesn't spend a Gemini call.
    const model = allowModelCall(clientKey(request)) ? createModel() : null;
    const answer = await answerQuestion(parsed.question, { model });
    return Response.json(answer, { headers });
  } catch (error) {
    log("request failed", error);
    return Response.json({ error: MESSAGES.failed }, { status: 500, headers });
  }
}
