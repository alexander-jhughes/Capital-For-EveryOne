// Output guard. Any reply that fails here is thrown away and the template sentence is used instead.
import type { AnswerFactSet } from "./answer-facts";
import { claimProblem, NOT_ARRIVED } from "./claims";
import { billQuestion, pauseQuestion, spendQuestion } from "./intent";
import { amounts, dateWords, dayMonths, normaliseDates, plainAmount } from "./reply-text";

export const MAX_SENTENCES = 2;
export const CANT_TELL = "I can't tell that from your transactions.";

export type GuardResult = { ok: true } | { ok: false; reason: string };

const pass: GuardResult = { ok: true };
const fail = (reason: string): GuardResult => ({ ok: false, reason });

const { MONTHS, WEEKDAYS, SHORT_MONTHS, SHORT_WEEKDAYS } = dateWords;

const ADVICE =
  /\b(should|shouldn't|ought|recommend\w*|suggest\w*|advis\w*|advice|consider\w*|you (?:can|could|may|might) (?!have\b|be\b|see\b|been\b)\w+|avoid\w*|try to|make sure|i'd|i would|better to|best to|need to|have to|must|invest\w*|consolidat\w*|pay off|paying off|contact|dispute|save money|cut back|cut down|reduce|worth)\b/i;
const OTHER_MONEY = /[%$€¥#]|(?<![£\d.,])\b\d+\.\d{2}\b|\b(pounds?|quid|pence|p|gbp|percent|per cent|euros?|dollars?)\b/i;
/** Topics the facts never cover, so a reply can't bring them in. */
const OUTSIDE_TOPICS = /\b(interest|fees?|penalt\w*|charges? you more|credit score|overdraft|debt)\b/i;
const MARKUP = /[<>{}`|]|\]\(|\*\*|__|^#|\bhttps?:|\bwww\.|\bjavascript:/im;
const NUMBER_WORDS =
  /\b(three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|quarter)\b/i;
const RELATIVE_DATES = /\b(tomorrow|yesterday|tonight|next week|last week|next month|this week|weekend|fortnight)\b/i;

const DENIAL =
  /\b(no|not|never|none|nothing|without|didn't|doesn't|don't|wasn't|weren't|isn't|aren't|haven't|hasn't|can't|cannot|couldn't|unable)\b/i;
const HIGHER = /\b(up|more|higher|increas\w*|rose|risen|extra)\b/i;
const LOWER = /\b(down|less|lower|fewer|cheaper|decreas\w*|dropped|drop|fell|fallen)\b/i;

/** Capitalised words that are not names. Any other capitalised word must be in the facts, so a shop can't be invented. */
const ORDINARY_WORDS = new Set(
  `a across after an and at both but by dial each earlier for from here i i'm in it it's latest looks most no none not nothing on one over pause right since so spend
  that that's the there these they this those today two you you're you've your yes when if once while until before as`.split(/\s+/),
);

const clean = (text: string) => text.replace(/[’‘]/g, "'");

const numbers = (text: string) => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
const months = (text: string) => text.match(new RegExp(`\\b(${MONTHS})\\b`, "g")) ?? [];
const weekdays = (text: string) => text.match(new RegExp(`\\b(${WEEKDAYS})\\b`, "g")) ?? [];
const fullDates = (text: string) => text.match(new RegExp(`\\b(${WEEKDAYS})(?: the)? \\d{1,2} (${MONTHS}|may)\\b`, "g")) ?? [];

/** "1 to 8 November" states both dates, but only spells the month once. */
const expandRanges = (text: string) =>
  text.replace(new RegExp(`\\b(\\d{1,2}) to (\\d{1,2}) (${MONTHS})\\b`, "g"), "$1 $3 to $2 $3");

const factText = (facts: AnswerFactSet) => facts.facts.map((f) => `${f.label}: ${f.value}`).join("\n");

/** Lowers every month and day name so the name check skips them. */
const normaliseProperDates = (text: string) =>
  text.replace(new RegExp(`\\b(${MONTHS}|${WEEKDAYS}|may|${Object.keys(SHORT_MONTHS).join("|")}|${Object.keys(SHORT_WEEKDAYS).join("|")})\\b`, "gi"), (m) => m.toLowerCase());

const capitalised = (text: string) => text.match(/\b[A-Z][A-Za-z'-]*/g) ?? [];

/** "Due" anywhere except in "nothing is due" or "no payment due": what a paid-off bill must never say. */
const saysSomethingIsDue = (reply: string) =>
  /\bdue\b/i.test(reply.replace(/\b(?:nothing|no payment|no amount|none of it)\s+(?:is |will be |at all is )?(?:due|owed)\b|\bnot due\b|\bnothing (?:is )?due\b|\bnot all(?: of it)?(?: is)? due(?: yet)?\b|\bisn't all due(?: yet)?\b/gi, ""));

const sentenceCount = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "").length;

/** Only the bare sentence counts, so "Yes, but I can't tell that..." can't slip past the grounding check. */
export const isCantTell = (text: string) => /^i can't tell that from your transactions\.?$/i.test(clean(text).trim());

/**
 * Passing the amount and date checks only proves a reply invented nothing, and a reply with no figures passes those
 * by default. This proves it actually states the answer: it has to carry the fact that settles the question, and
 * must not deny or reverse it.
 */
function anchorProblem(reply: string, facts: AnswerFactSet, question: string): string | null {
  const value = (key: string) => facts.facts.find((f) => f.key === key)?.value;
  const values = (prefix: string) => facts.facts.filter((f) => f.key.startsWith(prefix)).map((f) => f.value);
  const stated = amounts(reply);
  const has = (amount: string | undefined) => amount !== undefined && stated.includes(plainAmount(amount));
  const named = (name: string) => reply.toLowerCase().includes(name.toLowerCase());
  const replyDates = normaliseDates(reply);
  const amountIn = (text: string | undefined) => text?.match(/£[\d,.]*\d/)?.[0];
  const contradicted = "contradicts facts";
  const unsupported = "no supporting fact";

  const valuesText = facts.facts.map((f) => f.value).join(" ");
  if (HIGHER.test(valuesText) && !LOWER.test(valuesText) && LOWER.test(reply)) return contradicted;
  if (LOWER.test(valuesText) && !HIGHER.test(valuesText) && HIGHER.test(reply)) return contradicted;

  switch (facts.intent) {
    case "account_overview": {
      // Each amount is described by the words just before it (back to the previous amount) and just after it.
      const current = value("current_balance");
      const statement = value("statement_balance");
      const minimum = value("minimum_payment");
      for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
        const found = [...sentence.matchAll(/£\s?[\d,]+(?:\.\d{2})?/g)];
        for (let k = 0; k < found.length; k++) {
          const amount = plainAmount(found[k][0]);
          const start = found[k].index ?? 0;
          const before = sentence.slice(k === 0 ? 0 : (found[k - 1].index ?? 0) + found[k - 1][0].length, start);
          const after = sentence.slice(start + found[k][0].length, k + 1 < found.length ? found[k + 1].index : undefined);
          if (current && statement !== current && amount === plainAmount(current) && /\b(bill|statement|minimum|due)\b/i.test(before)) return contradicted;
          if (statement && statement !== current && amount === plainAmount(statement) && /\b(in total|altogether|current|everything)\b/i.test(before)) return contradicted;
          if (minimum && amount === plainAmount(minimum) && !/\b(minimum|least|smallest)\b/i.test(before + after)) return contradicted;
        }
      }
      return null;
    }
    case "category_spending": {
      if (value("no_categories")) return DENIAL.test(reply) ? null : contradicted;
      const rows = facts.facts.filter((f) => /^category_(biggest|smallest|\d+)$/.test(f.key));
      return rows.every((f) => has(amountIn(f.value)) && named(f.value.split(",")[0])) ? null : unsupported;
    }
    case "payment_history": {
      const latest = amountIn(value("payment_1"));
      if (!latest) return DENIAL.test(reply) || has(value("statement_remaining")) ? null : unsupported;
      return has(latest) ? null : unsupported;
    }
    case "subscription_list": {
      if (value("no_subscriptions")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply) && values("lapsed_subscription_").length === 0) return contradicted;
      const items = values("subscription_").map((v) => v.match(/^(.+?), (£[\d,.]*\d), /));
      return items.every((m) => m && named(m[1]) && has(m[2])) ? null : unsupported;
    }
    case "transaction_lookup": {
      if (value("no_transaction")) return DENIAL.test(reply) ? null : contradicted;
      const row = value("transaction")?.match(/^(£[\d,.]*\d) at (.+?) on /);
      if (!row || !has(row[1]) || !named(row[2])) return unsupported;
      const pending = value("transaction")?.includes("(pending");
      return pending ? (NOT_ARRIVED.test(reply) ? null : contradicted) : /\bpending\b/i.test(reply) ? contradicted : null;
    }
    case "merchant_refunds":
      if (value("no_refunds")) return DENIAL.test(reply) ? null : contradicted;
      return facts.facts.every((f) => has(amountIn(f.value))) ? null : unsupported;
    case "merchant_transactions": {
      if (value("no_transactions")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
      if (!facts.merchant || !named(facts.merchant)) return unsupported;
      const rows = facts.facts.filter((f) => f.key.startsWith("transaction_"));
      // A date answers "when". Anything else needs the total, or a partial list could pass for the whole picture.
      const dates = rows.map((f) => f.value.match(/\d{1,2} [A-Z][a-z]+/)?.[0].toLowerCase());
      const datesAnswer = /\bwhen\b/i.test(question) && dates.some((d) => d && replyDates.includes(d));
      return has(value("merchant_total")) || datesAnswer ? null : unsupported;
    }
    case "duplicates": {
      if (value("no_duplicates")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
      const found = values("duplicate_").map((v) => v.match(/^(.+?), (£[\d,.]*\d), on /));
      return found.some((m) => m && named(m[1]) && has(m[2])) ? null : unsupported;
    }
    case "price_changes": {
      if (value("no_price_changes")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
      const found = values("price_change_").map((v) => v.match(/^(.+?) went (?:up|down) from £[\d,.]*\d to (£[\d,.]*\d)/));
      return found.some((m) => m && named(m[1]) && has(m[2])) ? null : unsupported;
    }
    case "spend_this_month": {
      if (DENIAL.test(reply)) return contradicted;
      const kind = spendQuestion(question);
      if (kind === "category") return has(amountIn(value("month_top_category"))) ? null : unsupported;
      if (kind === "compare") return has(amountIn(value("change_vs_same_days_last_month"))) ? null : unsupported;
      return has(value("month_to_date_total")) ? null : unsupported;
    }
    case "spend_last_month": {
      if (DENIAL.test(reply)) return contradicted;
      if (spendQuestion(question) === "category") return has(amountIn(value("last_month_top_category"))) ? null : unsupported;
      return has(value("last_month_total")) ? null : unsupported;
    }
    case "top_items": {
      if (DENIAL.test(reply)) return contradicted;
      return has(amountIn(value("top_item_1"))) ? null : unsupported;
    }
    case "days_until_due": {
      // "Not all of it is due yet" is the safeguard on the current balance, not a denial.
      // "Nothing is due" is only true once the statement is paid off.
      const settled = value("statement_balance") === "£0.00" ? /\bnothing (?:is |will be )?(?:due|to pay|owed)\b/gi : /$^/;
      if (DENIAL.test(reply.replace(/\bnot all\b/gi, "").replace(settled, ""))) return contradicted;
      const asked = billQuestion(question);
      // With the statement paid off, "your payment is due on Friday" is misleading: nothing is due on it.
      const paidOff = value("statement_balance") === "£0.00" && asked !== "current" && asked !== "last_payment";
      if (paidOff && (!/£0\.00|\bnothing\b/i.test(reply) || saysSomethingIsDue(reply))) return contradicted;
      if (asked === "owed") return [value("current_balance"), value("statement_balance"), value("minimum_payment")].every(has) ? null : unsupported;
      if (asked === "pay") return has(value("statement_balance")) && has(value("minimum_payment")) ? null : unsupported;
      if (asked === "current" || asked === "balance") return has(value("current_balance")) ? null : unsupported;
      if (asked === "bill") return has(value("statement_balance")) ? null : unsupported;
      if (asked === "last_payment") return has(amountIn(value("last_payment"))) ? null : unsupported;
      const due = value("due_date")?.toLowerCase() ?? "";
      const left = value("days_until_due")?.toLowerCase().replace("overdue by ", "") ?? "";
      const dueDay = due.replace(/^\w+ /, "");
      const stands = [due.split(" ")[0], dueDay, left].some((text) => text !== "" && replyDates.includes(text));
      return stands || has(value("statement_balance")) ? null : unsupported;
    }
    case "minimum_payment":
      if (value("minimum_payment") === "£0.00" && (!/£0\.00|\bnothing\b/i.test(reply) || saysSomethingIsDue(reply))) return contradicted;
      if (DENIAL.test(value("minimum_payment") === "£0.00" ? reply.replace(/\bnothing (?:is |will be )?(?:due|to pay|owed)\b/gi, "") : reply)) return contradicted;
      return has(value("minimum_payment")) ? null : unsupported;
    case "spend_pause": {
      if (pauseQuestion(question) === "explain") {
        // It must say what really happens, and never claim power it doesn't have.
        const overclaims = /\b(block\w*|declin\w*|freez\w*|lock\w*|everywhere|all (?:your )?purchases|real card|bank)\b/i.test(reply) && !/\b(not|doesn't|does not|isn't|is not|can't|cannot|won't|never)\b/i.test(reply);
        if (overclaims) return contradicted;
        if (/\b(reduc\w*|lower\w*|chang\w*|affect\w*) your balance\b/i.test(reply) && !/\b(not|doesn't|does not|never|won't)\b/i.test(reply)) return contradicted;
        return /\b(check\w*|ask\w*|go ahead|cancel)\b/i.test(reply) ? null : unsupported;
      }
      const status = value("spend_pause_status")?.toLowerCase();
      const said = reply.match(/\bpause (?:is )?(?:currently |now |turned |switched )*(on|off)\b/i)?.[1]?.toLowerCase();
      if (said && said !== status) return contradicted;
      if (DENIAL.test(reply)) return contradicted;
      return said || stated.some((a) => amounts(valuesText).includes(a)) ? null : unsupported;
    }
  }
}

/** Checks one reply against one fact set. Every amount and date must appear in the facts, exactly. */
export function checkAnswer(answer: string, facts: AnswerFactSet, question = ""): GuardResult {
  const reply = clean(answer).trim();
  if (reply === "") return fail("empty");
  if (/[\r\n]/.test(reply)) return fail("more than one line");
  if (/[<>{}`]|\]\(|\bhttps?:|\bjavascript:/i.test(reply)) return fail("markup or code");
  if (sentenceCount(reply) > MAX_SENTENCES) return fail("too many sentences");
  if (MARKUP.test(reply)) return fail("markup or code");
  if (ADVICE.test(reply)) return fail("advice wording");

  const source = factText(facts);
  if (OUTSIDE_TOPICS.test(reply) && !OUTSIDE_TOPICS.test(source)) return fail("outside the facts");
  const sourceDates = expandRanges(normaliseDates(source));
  const replyDates = normaliseDates(reply);

  const allowedAmounts = new Set(amounts(source));
  if (amounts(reply).some((a) => !allowedAmounts.has(a))) return fail("amount not in facts");

  const allowedNumbers = new Set(numbers(sourceDates));
  if (numbers(replyDates).some((n) => !allowedNumbers.has(n))) return fail("number not in facts");

  if (OTHER_MONEY.test(reply) && !OTHER_MONEY.test(source)) return fail("amount not in facts");
  if (NUMBER_WORDS.test(reply)) return fail("spelled-out number");
  if (RELATIVE_DATES.test(reply) && !RELATIVE_DATES.test(source)) return fail("relative date");
  if (/\bMay\b/.test(reply) && !/\bMay\b/.test(source)) return fail("date not in facts");

  const within = (found: string[], allowed: string[]) => found.every((d) => allowed.includes(d));
  if (!within(months(replyDates), months(sourceDates))) return fail("date not in facts");
  if (!within(weekdays(replyDates), weekdays(sourceDates))) return fail("date not in facts");
  if (!within(dayMonths(replyDates), dayMonths(sourceDates))) return fail("date not in facts");
  if (!within(fullDates(replyDates), fullDates(sourceDates))) return fail("date not in facts");

  // Dates are settled above, so their names don't count as unknown words here.
  const known = new Set(source.toLowerCase().match(/[a-z][a-z'-]*/g));
  const isName = (word: string) => !known.has(word.toLowerCase()) && !ORDINARY_WORDS.has(word.toLowerCase());
  if (capitalised(normaliseProperDates(reply)).some(isName)) return fail("name not in facts");

  if (isCantTell(reply)) return pass;
  const problem = anchorProblem(reply, facts, question) ?? claimProblem(reply, facts);
  return problem ? fail(problem) : pass;
}
