// The assistant flow: question -> intent -> facts -> phrasing -> guard. Facts and evidence never come from the model.
import type { AskResponse } from "../types";
import { cachedAnswer } from "./cache";
import { answerFacts, type AnswerFactSet } from "./answer-facts";
import { seedContext, type FactContext } from "./facts";
import { CANT_TELL, checkAnswer, isCantTell } from "./guard";
import { selectExperience, type OrchestratedResponse } from "./experience";
import { billQuestion, merchantSubject, namedMerchants } from "./intent";
import { interpretQuestion, periodLabelFor } from "./interpreter";
import { describeError, type AskModel } from "./model";
import { templateAnswer } from "./templates";
import { validateResponse } from "./validator";

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

/**
 * Answers one question through the three agents: interpret it, choose its template, then validate the result.
 * Never throws for a model problem; the worst case is a safe sentence.
 */
export async function answerQuestion(question: string | undefined, options: AskOptions): Promise<OrchestratedResponse> {
  const { model, ctx = seedContext(), timeoutMs = TIMEOUT_MS } = options;
  const asked = question ?? DEFAULT_QUESTION;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  const names = {
    merchants: [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))],
    categories: [...new Set(ctx.txns.map((t) => t.category))],
  };

  const reading = await interpretQuestion(asked, names, model, timeoutMs, (error) => log("classify failed", error));
  if (reading.kind === "clarify") return { answer: reading.message, evidenceIds: [], source: "template", experience: selectExperience("general", "low") };
  if (reading.kind === "unsupported") return { ...unanswered(), experience: selectExperience("general", reading.confidence) };

  const { intent, factIntent, confidence } = reading;
  const facts = answerFacts(factIntent, ctx, asked, merchantSubject(asked, names.merchants));
  const experience = selectExperience(intent, confidence, periodLabelFor(factIntent, asked, ctx));

  /** Agent 3 sees everything here, so no path to the user skips it. */
  const finish = (response: AskResponse): OrchestratedResponse => {
    const verdict = validateResponse(response.answer, response.evidenceIds, facts, ctx, asked);
    if (verdict.ok) return { ...response, experience };
    console.warn(`[ask] response rejected: ${verdict.reason}`);
    return { ...unanswered(), experience: selectExperience("general", "low") };
  };

  // "Was Lidl charged twice?" must not be answered with the Tesco finding.
  const named = namedMerchants(asked, names.merchants);
  const factsText = facts.facts.map((f) => f.value).join(" ");
  const aboutOneShop = factIntent === "merchant_transactions" || factIntent === "merchant_refunds";
  if (!aboutOneShop && factIntent !== "transaction_lookup" && named.length > 0 && !named.some((merchant) => factsText.includes(merchant))) {
    return { ...unanswered(), experience: selectExperience("general", "high") };
  }

  // Demo questions skip the model on purpose, so the live demo says the same thing every time.
  const cached = fromCache(asked, facts);
  if (cached) return finish(cached);
  // "How much do I owe?" is the easiest answer to get dangerously wrong, so its wording is never left to the model.
  // A reference lookup is one exact record, so there's nothing for a model to add.
  const owed = factIntent === "days_until_due" && billQuestion(asked) === "owed";
  const fixedWording = owed || factIntent === "transaction_lookup";
  if (fixedWording || !model || remaining() < MIN_CALL_MS) return finish(fromTemplate(facts, asked));

  let reply: string | null;
  try {
    reply = await model.phrase(asked, facts, remaining());
  } catch (error) {
    log("phrasing failed", error);
    return finish(fromTemplate(facts, asked));
  }

  if (reply === null) return finish(fromTemplate(facts, asked));
  // A reply that says the facts don't cover it has no evidence to show, and no specialist screen to open.
  if (isCantTell(reply)) return { answer: CANT_TELL, evidenceIds: [], source: "model", experience: selectExperience("general", confidence) };
  const verdict = validateResponse(reply, facts.evidenceIds, facts, ctx, asked);
  if (!verdict.ok) {
    console.warn(`[ask] reply rejected: ${verdict.reason}`);
    return finish(fromTemplate(facts, asked));
  }
  return finish({ answer: reply.trim(), evidenceIds: facts.evidenceIds, source: "model" });
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
