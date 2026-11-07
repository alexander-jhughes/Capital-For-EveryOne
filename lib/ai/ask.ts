// The assistant flow: question -> intent -> facts -> phrasing -> guard. Facts and evidence never come from the model.
import type { AskResponse, FactSet, Intent } from "../types";
import { cachedAnswer } from "./cache";
import { buildFacts, seedContext, type FactContext } from "./facts";
import { CANT_TELL, checkAnswer, isCantTell } from "./guard";
import { matchIntent } from "./intent";
import { describeError, type AskModel } from "./model";
import { templateAnswer } from "./templates";

export const MAX_QUESTION_LENGTH = 300;
const MAX_BODY_LENGTH = 4096;
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

/** Cached wording when this is a demo question and it still matches the facts, otherwise the template. */
function fallback(question: string, facts: FactSet): AskResponse {
  const cached = cachedAnswer(question);
  if (cached?.intent === facts.intent && checkAnswer(cached.answer, facts).ok) {
    return { answer: cached.answer, evidenceIds: facts.evidenceIds, source: "cache" };
  }
  return { answer: templateAnswer(facts), evidenceIds: facts.evidenceIds, source: "template" };
}

/** Answers one question. Never throws for a model problem; the worst case is a template sentence. */
export async function answerQuestion(question: string | undefined, options: AskOptions): Promise<AskResponse> {
  const { model, ctx = seedContext(), timeoutMs = TIMEOUT_MS } = options;
  const asked = question ?? DEFAULT_QUESTION;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  let intent: Intent | null = matchIntent(asked);
  if (!intent && model) {
    try {
      intent = await model.classify(asked, remaining());
    } catch (error) {
      log("classify failed", error);
    }
  }
  if (!intent) return unanswered();

  const facts = buildFacts(intent, ctx);
  if (!model || remaining() < MIN_CALL_MS) return fallback(asked, facts);

  let reply: string | null;
  try {
    reply = await model.phrase(asked, facts, remaining());
  } catch (error) {
    log("phrasing failed", error);
    return fallback(asked, facts);
  }

  if (reply === null) return { answer: templateAnswer(facts), evidenceIds: facts.evidenceIds, source: "template" };
  const verdict = checkAnswer(reply, facts);
  if (!verdict.ok) {
    console.warn(`[ask] reply rejected: ${verdict.reason}`);
    return { answer: templateAnswer(facts), evidenceIds: facts.evidenceIds, source: "template" };
  }
  // A reply that says the facts don't cover it has no evidence to show.
  if (isCantTell(reply)) return { answer: CANT_TELL, evidenceIds: [], source: "model" };
  return { answer: reply.trim(), evidenceIds: facts.evidenceIds, source: "model" };
}

type ParsedQuestion = { question: string | undefined } | { error: string };

/** A missing question means the default summary. An empty one is a mistake to tell the person about. */
function parseQuestion(body: string): ParsedQuestion {
  if (body.length > MAX_BODY_LENGTH) return { error: MESSAGES.tooLong };
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
    const parsed = parseQuestion(await request.text());
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400, headers });
    const answer = await answerQuestion(parsed.question, { model: createModel() });
    return Response.json(answer, { headers });
  } catch (error) {
    log("request failed", error);
    return Response.json({ error: MESSAGES.failed }, { status: 500, headers });
  }
}
