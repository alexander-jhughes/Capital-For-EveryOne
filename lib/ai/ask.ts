// The assistant flow: question -> intent -> facts -> phrasing -> guard. Facts and evidence never come from the model.
import { DEMO_TODAY } from "../demo-clock";
import type { AskResponse } from "../types";
import { cachedAnswer } from "./cache";
import { answerFacts, type AnswerFactSet } from "./answer-facts";
import { seedContext, type FactContext } from "./facts";
import { CANT_TELL, checkAnswer, isCantTell } from "./guard";
import { selectExperience, type OrchestratedResponse } from "./experience";
import { resolveFollowUp } from "./follow-up";
import { billQuestion, namedMerchants } from "./intent";
import { interpretQuestion, periodLabelFor } from "./interpreter";
import { contextFromState, parseClientState, type ClientState } from "./live-state";
import { describeError, type AskModel } from "./model";
import { isRateLimit } from "./model-chain";
import { allowModelCall, clientKey } from "./rate-limit";
import { contextFromSession } from "../server/account";
import { SessionSecretError } from "../server/secret";
import { sessionStore, type SessionStore } from "../server/store";
import { templateAnswer } from "./templates";
import { foundNothing, validateResponse } from "./validator";

export const MAX_QUESTION_LENGTH = 300;
/** Room for a question and the most events the live state allows. */
const MAX_BODY_BYTES = 16_384;
const TIMEOUT_MS = 4000;
/** Below this a model call can't finish, so go straight to the fallback. */
const MIN_CALL_MS = 250;
const DEFAULT_QUESTION = "What did I spend this month?";
/** An open question like "how am I doing?" isn't a lookup, so the model is told to summarise instead of giving up. */
const OVERVIEW_TASK =
  "Summarise this card account in two short sentences using only the facts: the bill and when it is due, the minimum payment, the total owed, and what has been spent so far this month.";

const MESSAGES = {
  empty: "Please type a question first.",
  tooLong: `Please keep your question to ${MAX_QUESTION_LENGTH} characters or fewer.`,
  unreadable: "Sorry, I couldn't read that. Please try asking again.",
  badState: "Sorry, I couldn't check your latest account details. Please try again.",
  failed: "Sorry, something went wrong. Please try again.",
};

interface AskOptions {
  model: AskModel | null;
  ctx?: FactContext;
  timeoutMs?: number;
  /** The question asked just before, so "What about Argos?" can be read as a follow-up. */
  previousQuestion?: string;
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
  const { model, ctx = seedContext(), timeoutMs = TIMEOUT_MS, previousQuestion } = options;
  let busy = false;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  const names = {
    merchants: [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.merchant))],
    categories: [...new Set(ctx.txns.map((t) => t.category))],
    ids: ctx.txns.map((t) => t.id),
  };
  const asked = resolveFollowUp(question ?? DEFAULT_QUESTION, previousQuestion, names);

  const reading = await interpretQuestion(asked, names, model, timeoutMs, (error) => {
    log("classify failed", error);
    busy ||= isRateLimit(error);
  });
  if (reading.kind === "clarify") return { answer: reading.message, evidenceIds: [], source: "template", experience: selectExperience("general", "low") };
  if (reading.kind === "unsupported") return { ...unanswered(), experience: selectExperience("general", reading.confidence) };

  const { intent, factIntent, confidence, entities } = reading;
  const facts = answerFacts(factIntent, ctx, asked, entities.merchant, entities.transactionRef);
  // A transaction screen with nothing to show would only say it has nothing to show.
  const hollow = intent === "transaction_investigation" && facts.evidenceIds.length === 0;
  const experience = hollow ? selectExperience("general", confidence) : selectExperience(intent, confidence, periodLabelFor(factIntent, entities.period, ctx));

  /** Agent 3 sees everything here, so no path to the user skips it. */
  const finish = (response: AskResponse): OrchestratedResponse => {
    const verdict = validateResponse(response.answer, response.evidenceIds, facts, ctx, asked);
    // "I can't tell" never opens a specialist screen, whichever path it came from.
    if (verdict.ok) return { ...response, ...(busy ? { modelBusy: true } : {}), experience: isCantTell(response.answer) ? selectExperience("general", confidence) : experience };
    console.warn(`[ask] response rejected: ${verdict.reason}`);
    return { ...unanswered(), experience: selectExperience("general", "low") };
  };

  // "Was Lidl charged twice?" must not be answered with the Tesco finding.
  const named = namedMerchants(asked, names.merchants);
  const factsText = facts.facts.map((f) => f.value).join(" ");
  const aboutOneShop = factIntent === "merchant_transactions" || factIntent === "merchant_refunds";
  if (!aboutOneShop && named.length > 0 && !named.some((merchant) => factsText.includes(merchant))) {
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
    reply = await model.phrase(factIntent === "account_overview" ? OVERVIEW_TASK : asked, facts, remaining());
  } catch (error) {
    log("phrasing failed", error);
    busy ||= isRateLimit(error);
    return finish(fromTemplate(facts, asked));
  }

  if (reply === null) return finish(fromTemplate(facts, asked));
  // A reply that says the facts don't cover it has no evidence to show, and no specialist screen to open.
  if (isCantTell(reply)) {
    // The rules matched this question and the facts answer it, so a model that gives up shouldn't win.
    if (confidence === "high" && !foundNothing(facts)) return finish(fromTemplate(facts, asked));
    return { answer: CANT_TELL, evidenceIds: [], source: "model", experience: selectExperience("general", confidence) };
  }
  const verdict = validateResponse(reply, facts.evidenceIds, facts, ctx, asked);
  if (!verdict.ok) {
    console.warn(`[ask] reply rejected: ${verdict.reason}`);
    return finish(fromTemplate(facts, asked));
  }
  return finish({ answer: reply.trim(), evidenceIds: facts.evidenceIds, source: "model" });
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

type ParsedQuestion = { question: string | undefined; state?: ClientState; previousQuestion?: string } | { error: string };

/**
 * A missing question means the default summary. An empty one is a mistake to tell the person about.
 * With `ignoreState`, the body's `state` isn't even read: the session already says what happened.
 */
function parseQuestion(body: string, ignoreState = false): ParsedQuestion {
  if (body.trim() === "") return { question: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: MESSAGES.unreadable };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: MESSAGES.unreadable };

  const { question, state: rawState, previousQuestion: rawPrevious } = parsed as { question?: unknown; state?: unknown; previousQuestion?: unknown };
  if (rawPrevious !== undefined && rawPrevious !== null && (typeof rawPrevious !== "string" || rawPrevious.length > MAX_QUESTION_LENGTH)) return { error: MESSAGES.unreadable };
  const previousQuestion = typeof rawPrevious === "string" && rawPrevious.trim() !== "" ? rawPrevious.trim() : undefined;
  const state = rawState === undefined || ignoreState ? undefined : parseClientState(rawState, DEMO_TODAY);
  if (state === null) return { error: MESSAGES.badState };
  const withState = { ...(state ? { state } : {}), ...(previousQuestion ? { previousQuestion } : {}) };
  if (question === undefined || question === null) return { question: undefined, ...withState };
  if (typeof question !== "string") return { error: MESSAGES.unreadable };

  const trimmed = question.trim();
  if (trimmed === "") return { error: MESSAGES.empty };
  if (trimmed.length > MAX_QUESTION_LENGTH) return { error: MESSAGES.tooLong };
  return { question: trimmed, ...withState };
}

/** The visitor's session, or null when the request carries none we can trust. A server with no signing key answers from the body, as before. */
async function sessionFor(request: Request, store: SessionStore) {
  try {
    return await store.load(request);
  } catch (error) {
    if (!(error instanceof SessionSecretError)) throw error;
    log("session unavailable", error);
    return null;
  }
}

/**
 * The POST /api/ask handler, apart from choosing the model. Every failure is a friendly JSON message.
 * The facts come from the session cookie when there is one this server signed, and only then from the body's `state`.
 */
export async function handleAsk(request: Request, createModel: () => AskModel | null, store: SessionStore = sessionStore): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const body = await readBody(request);
    if (body === null) return Response.json({ error: MESSAGES.tooLong }, { status: 400, headers });
    const session = await sessionFor(request, store);
    const parsed = parseQuestion(body, session !== null);
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400, headers });
    // Over the limit still gets an answer. It just doesn't spend a Groq call.
    const model = allowModelCall(clientKey(request)) ? createModel() : null;
    const ctx = session ? contextFromSession(session) : contextFromState(parsed.state);
    const answer = await answerQuestion(parsed.question, { model, ctx, previousQuestion: parsed.previousQuestion });
    return Response.json(answer, { headers });
  } catch (error) {
    log("request failed", error);
    return Response.json({ error: MESSAGES.failed }, { status: 500, headers });
  }
}
