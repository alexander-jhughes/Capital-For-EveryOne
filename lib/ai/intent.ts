// Keyword intent matching. Runs before any model call, so the common questions need no network and no key.
import type { Intent } from "../types";

const simplify = (text: string) => text.toLowerCase().replace(/[’']/g, "");

/** The facts can't answer this. It gets "I can't tell" directly and never reaches the model. */
export const UNSUPPORTED = "unsupported";
/** Stage 2's intents plus two about one shop. Kept here so the shared Intent type doesn't change. */
export type AnswerIntent = Intent | "merchant_transactions" | "merchant_refunds" | "subscription_list" | "transaction_lookup" | "category_spending" | "payment_history" | "account_overview";

/** "Tell me about my account", "give me a summary", "how am I doing": the whole account in two sentences. */
const OVERVIEW =
  /\b(tell me about my (accounts?|card|credit card|finances|money)|(give me |an? |my )?(account |card )?(summary|overview|rundown)( of my (accounts?|card|finances|money))?|summari[sz]e my (accounts?|card|finances|money)|how am i doing|how (is|are|s) my (accounts?|card|finances|money)( doing| looking)?|what(s| is) (going on|happening) with my (accounts?|card|money|finances)|status of my (accounts?|card)|account status|where do i stand|my finances)\b/;
export type IntentMatch = AnswerIntent | typeof UNSUPPORTED | null;
export type MerchantPeriod = "all" | "this_month" | "last_month";

/** Words in the data that make a question narrower than the whole-month facts. */
export interface KnownNames {
  merchants: string[];
  categories: string[];
  /** Transaction IDs in the account, so that "T100" on its own isn't taken for one. */
  ids?: string[];
}

/** Asks for a judgement the facts can't give. Must not land on a nearby intent. */
const OUT_OF_SCOPE =
  /\b(should i|shall i|ought i|do you recommend|recommend|advice|advise|is it worth|worth it|good idea|best way|can i afford|can i spend|balance transfer|available|cancell?ed|cancel)\b/;

/** A spending question about one shop, category or period: the facts only hold whole-month totals. */
const NARROW_PHRASE = /\b(?:at|on|in|from|for)\s+(?!this\b|last\b|the\b|my\b|me\b|total\b|november\b|october\b)[a-z0-9]/;
/** "my grocery spend" or "food spending": a word that narrows what spending means. */
const NARROW_SPEND_NOUN =
  /\b(?!(?:my|i|ive|did|the|total|monthly|this|to|of|you|we|and|much|have|what|do|can|will|overall|card|month|in|on|at|for|so|far|how|ever|usually|been|am|was|whats|whole)\b)[a-z]+ (?:spend|spending)\b(?! pause)/;
/** Which shop or purchase was smallest or largest: the facts rank purchases, not shops or anything from the bottom. */
const UNRANKED = /\bleast\b(?! (?:i|you) (?:can|must|have to|need to|should))|\b(?:spend|spent|shop|shopped)\b.*\bmost\b|\bmost\b.*\b(?:shop|store|merchant)\b|\b(?:smallest|cheapest|lowest)\b/;
const OTHER_PERIOD =
  /\b(?:19|20)\d{2}\b|\b(?:january|february|march|april|june|july|august|september|december|in may|monday|tuesday|wednesday|thursday|friday|saturday|sunday|past|since|days?|weeks?|weekend|years?|yesterday|today|average)\b/;
const SPEND_WORD = /\b(?:spend|spent|spending|cost|costs)\b(?! pause)/;

// First match wins, so the specific intents sit above the general spending ones.
/** "at Uber": a shop the data doesn't know, so a category answer would be about the wrong thing. */
const NARROW_PHRASE_AT = /\b(?:at|from)\s+(?!this\b|last\b|the\b|my\b|november\b|october\b)[a-z0-9]/;
const COMPARES_MONTHS = /\b(compare[ds]?|comparison|versus|vs|more than|less than|than last month)\b/;

const RULES: Array<[Intent, RegExp]> = [
  ["spend_pause", /\b(spend pause|pause|budget|quiet hours)\b/],
  ["duplicates", /\b(twice|double|doubled|duplicates?|charged two|paid two|two charges|same charge)\b/],
  ["price_changes", /\b(subscriptions?|go up|gone up|went up|price|prices|price rise|more expensive)\b/],
  ["minimum_payment", /\b(minimum|least)\b/],
  ["spend_this_month", COMPARES_MONTHS],
  ["days_until_due", /\b(bill|due|deadline|statement|owe|owed|owing|balance)\b|\bwhen\b.*\bpay\b|\b(need|have) to pay\b/],
  ["spend_last_month", /\bcategor(?:y|ies)\b.*\b(last month|previous month|october)\b/],
  ["spend_this_month", /\bcategor(?:y|ies)\b/],
  ["top_items", /\b(biggest|largest|top|most expensive)\b/],
  ["spend_last_month", /\b(last month|previous month|october)\b/],
  ["spend_this_month", /\b(spend|spent|spending|this month|so far)\b/],
];

/** Which money a bill question means. These are different amounts, so the answer has to say the right one. */
export type BillQuestion = "current" | "owed" | "pay" | "bill" | "balance" | "last_payment" | "due";

export function billQuestion(question: string): BillQuestion {
  const q = simplify(question);
  if (/\b(current|total|whole|full) balance\b|\bbalance (right )?now\b/.test(q)) return "current";
  if (/\b(owe|owed|owing)\b/.test(q)) return "owed";
  if (/\blast (?:pay|paid|payment)\b|\bpaid last\b/.test(q)) return "last_payment";
  if (/\bhow much\b.*\bpay\b|\bwhat\b.*\b(?:need|have) to pay\b/.test(q)) return "pay";
  if (/\bstatement\b|\bhow much\b.*\bbill\b/.test(q)) return "bill";
  return /\bbalance\b/.test(q) ? "balance" : "due";
}

/** What a Spend Pause question wants: how it works, or how it's set up now. */
export function pauseQuestion(question: string): "explain" | "status" {
  const q = simplify(question);
  return /\bwhat (?:happens|would happen|does (?:it|spend pause) do|is spend pause)\b|\bhow (?:does|do|would) (?:it|spend pause|this) work|\bexplain\b|\baffect\w* my (?:balance|account|card)|\b(?:will|does|would|can) (?:it|spend pause) (?:block|stop|change|affect|cancel)|\bwhat (?:can|can't) (?:it|spend pause)\b|\b(?:if|when) i (?:activate|turn on|switch on|enable)/.test(q) ? "explain" : "status";
}

/** What a spending question wants from the month's facts. */
export function spendQuestion(question: string): "category" | "compare" | "total" {
  const q = simplify(question);
  if (/\bcategor(?:y|ies)\b/.test(q)) return "category";
  return COMPARES_MONTHS.test(q) ? "compare" : "total";
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
/** "my Currys refund" or "did Currys refund me": a refund from a shop that isn't in the transactions. */
const NAMED_REFUNDS = [
  /\b(?:my|the|a|any|an)\s+([a-z0-9]+)\s+refund\b/,
  /\brefunds?\s+(?:from|for|by)\s+([a-z0-9]+)/,
  /\brefunded\s+by\s+([a-z0-9]+)/,
  /\bmoney back\s+(?:from|for)\s+([a-z0-9]+)/,
  /\b(?:did|has|have|will|would|can)\s+([a-z0-9]+)\s+refund/,
];
const NOT_A_SHOP = new Set(["the", "a", "an", "any", "my", "me", "i", "you", "they", "we", "it", "this", "that", "last", "latest", "recent", "pending", "next", "other"]);
/** How a question names a shop it was charged by. Lidl isn't in the data, so nothing else would notice it. */
const NAMED_CHARGES = [
  /\b(?:by|from|at|with)\s+([a-z][\w'-]*)/i,
  /\b(?:did|was|has|have|were|is)\s+([a-z][\w'-]*)\s+(?:charged?|billed?|took|take|taken|gone|go|went|up)\b/i,
  /\bpa(?:y|id)\s+([a-z][\w'-]*)\s+(?:twice|double)\b/i,
];
const NOT_A_NAME = new Set([...NOT_A_SHOP, "mistake", "accident", "all", "anything", "anyone", "something", "them", "us", "being", "been", "subscription", "subscriptions", "any", "twice", "price", "prices", "netflix's"]);

/** The known shops a question names, leaving out any that are really another business. */
const shopsIn = (q: string, merchants: string[]) =>
  merchants.filter((name) => mentions(q, [name]) && !nameRegExp(name, OTHER_BUSINESS).test(q));

/** True for what the facts can't answer, even with one shop named: advice, ranking shops, other periods, comparing. */
export function cannotAnswer(question: string): boolean {
  const q = simplify(question);
  return OUT_OF_SCOPE.test(q) || UNRANKED.test(q) || OTHER_PERIOD.test(q) || COMPARES_MONTHS.test(q) || /\b(compare|better|cheaper)\b/.test(q);
}

/** Spending categories in the data, and everyday words for them. Matching a word here is how a category is named. */
export const CATEGORY_WORDS: Record<string, RegExp> = {
  Groceries: /\b(groceries|grocery|food shop(?:ping)?|supermarkets?)\b/,
  "Eating out": /\b(eating out|restaurants?|takeaways?|dining|meals? out|cafes?)\b/,
  Transport: /\b(transport|commut\w*|trains?|tube|bus(?:es)?|taxis?)\b/,
  Travel: /\b(travel|holidays?|trips?|flights?)\b/,
  Shopping: /(?<!food )\b(shopping|clothes)\b(?! list)/,
  Subscriptions: /\b(subscriptions?)\b/,
};
const CATEGORY_QUESTION = /\bcategor(?:y|ies)\b/;
const SPENDING_ASK = /\b(spend|spent|spending|cost|costs|how much|total)\b(?! pause)/;

export type CategoryRank = "biggest" | "smallest" | "named" | "all";

/** The categories a question names, from the ones in the data. */
export function namedCategories(question: string, categories: string[]): string[] {
  const q = simplify(question);
  return categories.filter((c) => CATEGORY_WORDS[c]?.test(q) || new RegExp(`\\b${escapeRegExp(c.toLowerCase())}\\b`).test(q));
}

/** Which category answer a question wants. */
export function categoryRank(question: string, categories: string[]): CategoryRank {
  const q = simplify(question);
  if (/\b(smallest|least|lowest|fewest)\b/.test(q)) return "smallest";
  if (/\b(biggest|largest|most|top|highest|main)\b/.test(q)) return "biggest";
  return namedCategories(question, categories).length > 0 ? "named" : "all";
}

/** True when a question is about spending per category, as opposed to one shop or the whole month. */
function isCategoryQuestion(q: string, categories: string[]): boolean {
  if (CATEGORY_QUESTION.test(q)) return true;
  const named = categories.filter((c) => CATEGORY_WORDS[c]?.test(q));
  // "subscriptions" on its own is about the list or price changes, which have their own facts.
  return named.length > 0 && SPENDING_ASK.test(q) && !(named.length === 1 && named[0] === "Subscriptions" && !/\b(spend|spent|spending|how much|total)\b/.test(q));
}

const PAYMENT_HISTORY =
  /\b(payment history|payments? (?:i(?:ve| have)|have i|did i) (?:made|make)|(?:my|past|previous|recent) payments|have i (?:made|paid) (?:a |any )?payments?|did (?:my|the) payment (?:go through|arrive|clear|work)|(?:is|was|has) (?:my|the|that) payment (?:been |gone |come )?(?:through|recorded|received|made|arrived|cleared|pending|processed|taken|showing|in)\b|how much did i (?:just |last )?pay\b|did i (?:just )?(?:make|pay) (?:a|my|the) (?:card )?payment|have i paid (?:my|the) bill|is (?:my|the) bill paid|bill (?:been )?paid)\b/;

/** The one shop a question is about, or undefined if it names none or several. */
export function merchantSubject(question: string, merchants: string[]): string | undefined {
  const shops = shopsIn(simplify(question), merchants);
  return shops.length === 1 ? shops[0] : undefined;
}

/** Every known shop a question names, leaving out other businesses that share a name. */
export const namedShops = (question: string, merchants: string[]) => shopsIn(simplify(question), merchants);

/** A transaction reference in a question, such as "t051". */
export const transactionRefs = (question: string) => [...question.matchAll(/\bt\d{3}\b/gi)].map((m) => m[0].toLowerCase());
/** Says it's a reference, so a code that isn't one of ours can be answered as "not found". */
const REFERENCE_WORD = /\b(transaction|reference|ref)\b/;

const SUBSCRIPTION_CHANGE = /\b(go up|gone up|went up|increas\w*|price|prices|rise|rises|more expensive|cheaper|changed?|cost|costs|spend|spent|twice|double)\b/;
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
  if (known.length > 0) return known;
  const unknown = NAMED_CHARGES.map((pattern) => question.match(pattern)?.[1]).find((name) => name && !NOT_A_NAME.has(name.toLowerCase()));
  return unknown ? [unknown] : [];
}

/**
 * The intent a question plainly asks for, UNSUPPORTED when the facts can't answer it, or null when the model has to
 * classify it. A narrow question must stay UNSUPPORTED: classifying "How much did I spend at Tesco?" as general
 * spending would answer it with the whole month's total.
 */
export function matchIntent(question: string, names: KnownNames = { merchants: [], categories: [] }): IntentMatch {
  const q = simplify(question);
  if (OUT_OF_SCOPE.test(q)) return UNSUPPORTED;
  if (PAYMENT_HISTORY.test(q)) return "payment_history";
  if (OVERVIEW.test(q) && !SPEND_WORD.test(q)) return "account_overview";
  if (isCategoryQuestion(q, names.categories) && shopsIn(q, names.merchants).length === 0) {
    const otherPeriod = OTHER_PERIOD.test(q) && !/\b(this month|last month|november|october)\b/.test(q);
    return otherPeriod || NARROW_PHRASE_AT.test(q) ? UNSUPPORTED : "category_spending";
  }
  if (UNRANKED.test(q)) return UNSUPPORTED;
  const references = transactionRefs(question);
  if (references.length > 1) return UNSUPPORTED;
  if (references.length === 1 && ((names.ids ?? []).includes(references[0]) || REFERENCE_WORD.test(q))) return "transaction_lookup";
  if (/\bsubscriptions?\b/.test(q) && OTHER_PERIOD.test(q)) return UNSUPPORTED;
  if (SUBSCRIPTION_LIST.test(q) && !SUBSCRIPTION_CHANGE.test(q)) return "subscription_list";

  const shops = shopsIn(q, names.merchants);
  const anotherBusiness = names.merchants.some((name) => nameRegExp(name, OTHER_BUSINESS).test(q));
  if (anotherBusiness && shops.length === 0) return UNSUPPORTED;

  if (REFUND_WORDS.test(q)) {
    const shop = NAMED_REFUNDS.map((pattern) => q.match(pattern)?.[1]).find((name) => name && !NOT_A_SHOP.has(name));
    const unknownShop = shop !== undefined && shops.length === 0;
    return shops.length > 1 || unknownShop || OTHER_PERIOD.test(q) ? UNSUPPORTED : "merchant_refunds";
  }

  const intent = RULES.find(([, pattern]) => pattern.test(q))?.[0] ?? null;
  if (shops.length === 1 && (intent === null || intent === "spend_this_month" || intent === "spend_last_month")) {
    return OTHER_PERIOD.test(q) ? UNSUPPORTED : "merchant_transactions";
  }

  const aboutSpending = intent === null || SPENDING_INTENTS.has(intent) || SPEND_WORD.test(q);
  const narrow = NARROW_PHRASE.test(q) || NARROW_SPEND_NOUN.test(q) || OTHER_PERIOD.test(q) || mentions(q, [...names.merchants, ...names.categories]);
  if (aboutSpending && narrow) return UNSUPPORTED;
  if (intent && !MERCHANT_INTENTS.has(intent) && mentions(q, names.merchants)) return UNSUPPORTED;
  return intent;
}
