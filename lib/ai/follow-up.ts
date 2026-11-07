// "What about Argos?" or "And last month?" only make sense after another question. This rewrites them into the
// full question they stand for, using the question asked just before, so the usual rules and facts answer them.
// Nothing here is trusted: the rewritten question goes through the same interpreter and validator as any other.
import { CATEGORY_WORDS, type KnownNames } from "./intent";

const simplify = (text: string) => text.toLowerCase().replace(/[’']/g, "");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "what about X", "how about X", "and X", "and for X", "for X": the elliptical shapes, with X the new subject. */
const ELLIPSIS = /^(?:(?:and )?(?:what|how) about|and(?: for| at| on| in)?|for|at|on)\s+(.{1,40}?)\s*[?.!]*$/;
const PERIODS = /\b(?:this month|last month|previous month|so far|(?:in )?october|(?:in )?november)\b/i;
const PERIOD_ONLY = /^(?:this month|last month|the previous month|previous month|so far|(?:in )?october|(?:in )?november)$/;
const shopPattern = (name: string) => new RegExp(`\\b${escapeRegExp(name).replace(/'/g, "['’]?").replace(/s$/i, "")}(?:['’]?s)?\\b`, "i");

function withPeriod(previous: string, period: string): string {
  const base = previous.trim().replace(/[?.!]+$/, "");
  return PERIODS.test(base) ? `${base.replace(PERIODS, period)}?` : `${base} ${period}?`;
}

/** The full question an elliptical follow-up stands for, or the question unchanged when it isn't one. */
export function resolveFollowUp(question: string, previous: string | undefined, names: KnownNames): string {
  if (!previous) return question;
  const subject = simplify(question).trim().match(ELLIPSIS)?.[1]?.replace(/^(?:the|my)\s+/, "");
  if (!subject) return question;

  if (PERIOD_ONLY.test(subject)) return withPeriod(previous, subject.replace(/^the /, ""));

  const shop = names.merchants.find((m) => shopPattern(m).test(subject) && simplify(m).replace(/s$/, "").length >= subject.replace(/s$/, "").length - 2);
  const category = Object.keys(CATEGORY_WORDS).find((c) => names.categories.includes(c) && CATEGORY_WORDS[c].test(subject));
  const period = previous.match(PERIODS)?.[0];
  const tail = period ? ` ${period}` : "";

  if (shop) {
    const old = names.merchants.find((m) => shopPattern(m).test(previous));
    if (old) return previous.replace(shopPattern(old), shop);
    return `What did I spend at ${shop}${tail}?`;
  }
  if (category) {
    const old = Object.keys(CATEGORY_WORDS).find((c) => CATEGORY_WORDS[c].test(simplify(previous)));
    if (old) {
      const word = simplify(previous).match(CATEGORY_WORDS[old])![0];
      return previous.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "i"), category.toLowerCase());
    }
    return `How much did I spend on ${category.toLowerCase()}${tail}?`;
  }
  return question;
}
