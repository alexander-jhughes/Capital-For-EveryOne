// Keyword intent matching. Runs before any model call, so the common questions need no network and no key.
import type { Intent } from "../types";

/** Asks for a judgement the facts can't give. Goes to "I can't tell", never to a nearby intent. */
const ADVICE_REQUEST = /\b(should i|shall i|ought i|do you recommend|recommend|advice|advise|is it worth|worth it|good idea|best way)\b/;

/** A spending question about one shop, category or year: the facts only hold whole-month totals. */
const NARROW_SPEND =
  /\b(?:at|on|from|for)\s+(?!this\b|last\b|the\b|my\b|me\b|total\b|november\b|october\b)[a-z0-9]|\b(?:19|20)\d{2}\b/;

// First match wins, so the specific intents sit above the general spending ones.
const RULES: Array<[Intent, RegExp]> = [
  ["spend_pause", /\b(spend pause|pause|budget|quiet hours)\b/],
  ["duplicates", /\b(twice|double|doubled|duplicates?|charged two|paid two|two charges|same charge)\b/],
  ["price_changes", /\b(subscriptions?|gone up|went up|price|prices|price rise|more expensive)\b/],
  ["minimum_payment", /\b(minimum|least i can pay)\b/],
  ["days_until_due", /\b(bill|due|deadline|statement)\b|when (do|must|should) i pay/],
  ["top_items", /\b(biggest|largest|top|most expensive)\b/],
  ["spend_last_month", /\b(last month|previous month|october)\b/],
  ["spend_this_month", /\b(spend|spent|spending|this month|so far)\b/],
];

const isSpendIntent = (intent: Intent) => intent === "spend_this_month" || intent === "spend_last_month";

/** The intent a question plainly asks for, or null when it needs the model (or can't be answered). */
export function matchIntent(question: string): Intent | null {
  const q = question.toLowerCase().replace(/[’']/g, "'");
  if (ADVICE_REQUEST.test(q)) return null;
  const rule = RULES.find(([, pattern]) => pattern.test(q));
  if (!rule) return null;
  return isSpendIntent(rule[0]) && NARROW_SPEND.test(q) ? null : rule[0];
}
