// Agent 1: works out what a question is asking. Rules go first, so most questions need no model call.
// Gemini only picks a label from a fixed list here. It never writes text the user sees.
import { monthOverMonth } from "../finance";
import type { Confidence, AskIntent } from "./experience";
import type { FactContext } from "./facts";
import { billQuestion, matchIntent, merchantPeriod, merchantSubject, namedShops, transactionRef, UNSUPPORTED, type AnswerIntent } from "./intent";
import type { AskModel } from "./model";

export interface Entities {
  merchant?: string;
  /** Exactly as asked, such as "£38.62". Only ever used to read the question, never as a fact. */
  amount?: string;
  dateRange?: string;
  transactionRef?: string;
}

export type Interpretation =
  | { kind: "answer"; intent: AskIntent; factIntent: AnswerIntent; entities: Entities; confidence: Confidence }
  /** The facts can't answer it. */
  | { kind: "unsupported"; entities: Entities; confidence: Confidence }
  /** It could mean several things, so ask rather than guess. */
  | { kind: "clarify"; message: string; entities: Entities };

const VAGUE_WORDS = new Set(
  `a about again am and any anything are be been can check correct could did do does explain for going how i is it just me more much my of ok okay one
  please really right so tell that the them there these they this those was what whats when where which who why will with would you`.split(/\s+/),
);

export const CLARIFY_GENERAL = "I'm not sure what you mean. Would you like to know about your balance, your spending, a particular shop, or a payment?";
const clarifyShops = (shops: string[]) => `Which shop do you mean: ${shops.join(" or ")}?`;

/** True when nothing in the question says what it's about, like "How much is it?" */
function isVague(question: string): boolean {
  const words = question.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9£.]+/g) ?? [];
  return words.every((word) => VAGUE_WORDS.has(word.replace(/\.$/, "")));
}

/** Merges Stage 2's detailed intents into the six the UI knows about. */
export function askIntentFor(intent: AnswerIntent, question: string): AskIntent {
  switch (intent) {
    case "spend_this_month":
    case "spend_last_month":
    case "top_items":
      return "spending_insights";
    case "merchant_transactions":
      return /\b(show|list|when|transactions?|did i buy|bought)\b/i.test(question) ? "transaction_investigation" : "spending_insights";
    case "price_changes":
    case "subscription_list":
      return "subscription_query";
    case "duplicates":
    case "merchant_refunds":
    case "transaction_lookup":
      return "transaction_investigation";
    case "minimum_payment":
      return "payment_planning";
    case "days_until_due": {
      const kind = billQuestion(question);
      return kind === "due" || kind === "pay" ? "payment_planning" : "statement_balance";
    }
    case "spend_pause":
      return "general";
  }
}

/** The month an answer covers, from the finance layer's own date ranges. */
export function periodLabelFor(intent: AnswerIntent, question: string, ctx: FactContext): string | undefined {
  const { thisMonth, lastMonth } = monthOverMonth(ctx.txns, ctx.today);
  const month = (from: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${from}T12:00:00Z`));
  if (intent === "spend_this_month" || intent === "top_items") return month(thisMonth.from);
  if (intent === "spend_last_month") return month(lastMonth.from);
  if (intent !== "merchant_transactions") return undefined;
  const period = merchantPeriod(question);
  return period === "this_month" ? month(thisMonth.from) : period === "last_month" ? month(lastMonth.from) : undefined;
}

function extractEntities(question: string, merchants: string[]): Entities {
  const merchant = merchantSubject(question, merchants);
  const amount = question.match(/£\s?\d[\d,]*(?:\.\d{1,2})?/)?.[0];
  const dateRange = question.match(/\b(?:this month|last month|last week|this week|yesterday|today|january|february|march|april|june|july|august|september|october|november|december)\b/i)?.[0];
  const reference = transactionRef(question);
  return { ...(merchant ? { merchant } : {}), ...(amount ? { amount } : {}), ...(dateRange ? { dateRange: dateRange.toLowerCase() } : {}), ...(reference ? { transactionRef: reference } : {}) };
}

/** One question to one interpretation. At most one model call, and only when the rules can't tell. */
export async function interpretQuestion(
  question: string,
  names: { merchants: string[]; categories: string[] },
  model: AskModel | null,
  timeoutMs: number,
  onError: (error: unknown) => void,
): Promise<Interpretation> {
  const entities = extractEntities(question, names.merchants);
  if (isVague(question)) return { kind: "clarify", message: CLARIFY_GENERAL, entities };

  const match = matchIntent(question, names);
  const shops = namedShops(question, names.merchants);
  const compares = match !== "duplicates" && match !== "price_changes";
  if (shops.length > 1 && compares) return { kind: "clarify", message: clarifyShops(shops), entities };

  if (match === UNSUPPORTED) return { kind: "unsupported", entities, confidence: "high" };
  if (match) return { kind: "answer", intent: askIntentFor(match, question), factIntent: match, entities, confidence: "high" };
  if (!model) return { kind: "unsupported", entities, confidence: "low" };

  try {
    const result = await model.classify(question, timeoutMs);
    if (!result) return { kind: "unsupported", entities, confidence: "low" };
    if (result.confidence === "low") return { kind: "clarify", message: CLARIFY_GENERAL, entities };
    if (result.intent === null) return { kind: "unsupported", entities, confidence: result.confidence };
    return { kind: "answer", intent: askIntentFor(result.intent, question), factIntent: result.intent, entities, confidence: result.confidence };
  } catch (error) {
    onError(error);
    return { kind: "unsupported", entities, confidence: "low" };
  }
}
