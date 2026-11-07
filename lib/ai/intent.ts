// Keyword intent matching. Runs before any model call, so the common questions need no network and no key.
import type { Intent } from "../types";

const simplify = (text: string) => text.toLowerCase().replace(/[’']/g, "");

/** The facts can't answer this. It gets "I can't tell" directly and never reaches the model. */
export const UNSUPPORTED = "unsupported";
/** Stage 2's intents plus two about one shop. Kept here so the shared Intent type doesn't change. */
export type AnswerIntent = Intent | "merchant_transactions" | "merchant_refunds" | "subscription_list" | "transaction_lookup";
export type IntentMatch = AnswerIntent | typeof UNSUPPORTED | null;
export type MerchantPeriod = "all" | "this_month" | "last_month";

/** Words in the data that make a question narrower than the whole-month facts. */
export interface KnownNames {
  merchants: string[];
  categories: string[];
}

/** Asks for a judgement the facts can't give. Must not land on a nearby intent. */
const OUT_OF_SCOPE =
  /\b(should i|shall i|ought i|do you recommend|recommend|advice|advise|is it worth|worth it|good idea|best way|can i afford|can i spend|balance transfer|available|bill paid|paid (?:my|the) bill)\b/;

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

/** Which money a bill question means. These are different amounts, so the answer has to say the right one. */
export type BillQuestion = "current" | "owed" | "pay" | "bill" | "balance" | "due";

export function billQuestion(question: string): BillQuestion {
  const q = simplify(question);
  if (/\b(current|total|whole|full) balance\b|\bbalance (right )?now\b/.test(q)) return "current";
  if (/\b(owe|owed|owing)\b/.test(q)) return "owed";
  if (/\bhow much\b.*\bpay\b/.test(q)) return "pay";
  if (/\bstatement\b|\bhow much\b.*\bbill\b/.test(q)) return "bill";
  return /\bbalance\b/.test(q) ? "balance" : "due";
}

const SPENDING_INTENTS = new Set<Intent>(["spend_this_month", "spend_last_month", "top_items"]);
/** These facts are about particular shops, so naming one is fine. */
const MERCHANT_INTENTS = new Set<Intent>(["duplicates", "price_changes"]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
/** Matches "Sainsburys" and "Sainsbury's" for Sainsbury's, and "Tesco's" for Tesco, but never "Argosy" for Argos. */
const nameRegExp = (name: string, after = "") => new RegExp(`\\b${escapeRegExp(simplify(name).replace(/s$/, ""))}s?\\b${after}`);
const mentions = (question: string, names: string[]) => names.some((name) => nameRegExp(name).test(question));

/** Words that turn a shop's name into a different business, so "Tesco Mobile" is never read as Tesco. */
const OTHER_BUSINESS = " (?:mobile|bank|insurance|prime|music|express|extra|business|photo|money|card)\\b";
const REFUND_WORDS = /\b(refunds?|refunded|money back|reimbursed)\b/;
/** "my Currys refund": a refund from a shop that isn't in the transactions. */
const NAMED_REFUND = /\b(?:my|the)\s+([a-z0-9]+)\s+refund\b|\brefunds?\s+(?:from|for)\s+([a-z0-9]+)/;
const NOT_A_SHOP = new Set(["the", "a", "an", "any", "my", "this", "that", "last", "latest", "recent", "pending", "next"]);

/** The known shops a question names, leaving out any that are really another business. */
const shopsIn = (q: string, merchants: string[]) =>
  merchants.filter((name) => mentions(q, [name]) && !nameRegExp(name, OTHER_BUSINESS).test(q));

/** The one shop a question is about, or undefined if it names none or several. */
export function merchantSubject(question: string, merchants: string[]): string | undefined {
  const shops = shopsIn(simplify(question), merchants);
  return shops.length === 1 ? shops[0] : undefined;
}

/** Every known shop a question names, leaving out other businesses that share a name. */
export const namedShops = (question: string, merchants: string[]) => shopsIn(simplify(question), merchants);

/** A transaction reference in a question, such as "t051". */
export const transactionRef = (question: string) => question.match(/\bt\d{3}\b/i)?.[0].toLowerCase();

const SUBSCRIPTION_CHANGE = /\b(go up|gone up|went up|increas\w*|price|prices|rise|rises|more expensive|cost|costs)\b/;
const SUBSCRIPTION_LIST = /\bsubscriptions?\b.*\b(paying|pay for|have|got)\b|\b(paying|have|got|list|show)\b.*\bsubscriptions?\b|^(?:what are )?my subscriptions\b/;

/** Which month a shop question means. Other periods never reach this: matchIntent sends them to UNSUPPORTED. */
export function merchantPeriod(question: string): MerchantPeriod {
  const q = simplify(question);
  if (/\b(this month|november|so far)\b/.test(q)) return "this_month";
  return /\b(last month|previous month|october)\b/.test(q) ? "last_month" : "all";
}

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
  if (transactionRef(question)) return "transaction_lookup";
  if (SUBSCRIPTION_LIST.test(q) && !SUBSCRIPTION_CHANGE.test(q)) return "subscription_list";

  const shops = shopsIn(q, names.merchants);
  const anotherBusiness = names.merchants.some((name) => nameRegExp(name, OTHER_BUSINESS).test(q));
  if (anotherBusiness && shops.length === 0) return UNSUPPORTED;

  if (REFUND_WORDS.test(q)) {
    const named = q.match(NAMED_REFUND);
    const shop = named?.[1] ?? named?.[2];
    const unknownShop = shop !== undefined && !NOT_A_SHOP.has(shop) && shops.length === 0;
    return shops.length > 1 || unknownShop || OTHER_PERIOD.test(q) ? UNSUPPORTED : "merchant_refunds";
  }

  const intent = RULES.find(([, pattern]) => pattern.test(q))?.[0] ?? null;
  if (shops.length === 1 && (intent === null || intent === "spend_this_month" || intent === "spend_last_month")) {
    return OTHER_PERIOD.test(q) ? UNSUPPORTED : "merchant_transactions";
  }

  const aboutSpending = intent === null || SPENDING_INTENTS.has(intent) || SPEND_WORD.test(q);
  const narrow = NARROW_PHRASE.test(q) || OTHER_PERIOD.test(q) || mentions(q, [...names.merchants, ...names.categories]);
  if (aboutSpending && narrow) return UNSUPPORTED;
  if (intent && !MERCHANT_INTENTS.has(intent) && mentions(q, names.merchants)) return UNSUPPORTED;
  return intent;
}
