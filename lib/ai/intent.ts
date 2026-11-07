// Keyword intent matching. Runs before any model call, so the common questions need no network and no key.
import type { Intent } from "../types";

/** The facts can't answer this. It gets "I can't tell" directly and never reaches the model. */
export const UNSUPPORTED = "unsupported";
export type IntentMatch = Intent | typeof UNSUPPORTED | null;

/** Words in the data that make a question narrower than the whole-month facts. */
export interface KnownNames {
  merchants: string[];
  categories: string[];
}

/** Asks for a judgement the facts can't give. Must not land on a nearby intent. */
const OUT_OF_SCOPE =
  /\b(should i|shall i|ought i|do you recommend|recommend|advice|advise|is it worth|worth it|good idea|best way|can i afford|can i spend|balance transfer|current balance|available|bill paid|paid (?:my|the) bill)\b/;

/** A spending question about one shop, category or period: the facts only hold whole-month totals. */
const NARROW_PHRASE = /\b(?:at|on|from|for)\s+(?!this\b|last\b|the\b|my\b|me\b|total\b|november\b|october\b)[a-z0-9]/;
const OTHER_PERIOD =
  /\b(?:19|20)\d{2}\b|\b(?:january|february|march|april|june|july|august|september|december|in may|monday|tuesday|wednesday|thursday|friday|saturday|sunday|past|since|days?|weeks?|weekend|years?|yesterday|today|average)\b/;
const SPEND_WORD = /\b(?:spend|spent|spending|cost|costs)\b(?! pause)/;

// First match wins, so the specific intents sit above the general spending ones.
const RULES: Array<[Intent, RegExp]> = [
  ["spend_pause", /\b(spend pause|pause|budget|quiet hours)\b/],
  ["duplicates", /\b(twice|double|doubled|duplicates?|charged two|paid two|two charges|same charge)\b/],
  ["price_changes", /\b(subscriptions?|go up|gone up|went up|price|prices|price rise|more expensive)\b/],
  ["minimum_payment", /\b(minimum|least)\b/],
  ["days_until_due", /\b(bill|due|deadline|statement|owe|owed|owing|balance)\b|\bwhen\b.*\bpay\b|\b(need|have) to pay\b/],
  ["top_items", /\b(biggest|largest|top|most expensive)\b/],
  ["spend_last_month", /\b(last month|previous month|october)\b/],
  ["spend_this_month", /\b(spend|spent|spending|this month|so far)\b/],
];

const SPENDING_INTENTS = new Set<Intent>(["spend_this_month", "spend_last_month", "top_items"]);
/** These facts are about particular shops, so naming one is fine. */
const MERCHANT_INTENTS = new Set<Intent>(["duplicates", "price_changes"]);

const simplify = (text: string) => text.toLowerCase().replace(/[’']/g, "");
const escapeRegExp = (text: string) => text.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
const mentions = (question: string, names: string[]) =>
  names.some((name) => new RegExp(`\\b${escapeRegExp(simplify(name))}\\b`).test(question));

/**
 * The shops a question names, including one that isn't in the transactions ("charged twice by Lidl").
 * An answer about a different shop would not answer it.
 */
export function namedMerchants(question: string, merchants: string[]): string[] {
  const known = merchants.filter((merchant) => mentions(simplify(question), [merchant]));
  const unknown = question.match(/\b(?:by|from|at|with)\s+([A-Z][\w'-]*)/)?.[1];
  return unknown ? [...known, unknown] : known;
}

/**
 * The intent a question plainly asks for, UNSUPPORTED when the facts can't answer it, or null when the model has to
 * classify it. A narrow question must stay UNSUPPORTED: classifying "How much did I spend at Tesco?" as general
 * spending would answer it with the whole month's total.
 */
export function matchIntent(question: string, names: KnownNames = { merchants: [], categories: [] }): IntentMatch {
  const q = simplify(question);
  if (OUT_OF_SCOPE.test(q)) return UNSUPPORTED;

  const intent = RULES.find(([, pattern]) => pattern.test(q))?.[0] ?? null;
  const aboutSpending = intent === null || SPENDING_INTENTS.has(intent) || SPEND_WORD.test(q);
  const narrow = NARROW_PHRASE.test(q) || OTHER_PERIOD.test(q) || mentions(q, [...names.merchants, ...names.categories]);
  if (aboutSpending && narrow) return UNSUPPORTED;
  if (intent && !MERCHANT_INTENTS.has(intent) && mentions(q, names.merchants)) return UNSUPPORTED;
  return intent;
}
