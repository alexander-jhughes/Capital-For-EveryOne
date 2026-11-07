// Output guard. Any reply that fails here is thrown away and the template sentence is used instead.
import type { AnswerFactSet } from "./answer-facts";
import { billQuestion } from "./intent";

export const MAX_SENTENCES = 2;
export const CANT_TELL = "I can't tell that from your transactions.";

export type GuardResult = { ok: true } | { ok: false; reason: string };

const pass: GuardResult = { ok: true };
const fail = (reason: string): GuardResult => ({ ok: false, reason });

const MONTHS = "january|february|march|april|june|july|august|september|october|november|december";
const SHORT_MONTHS: Record<string, string> = {
  jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july",
  aug: "august", sep: "september", sept: "september", oct: "october", nov: "november", dec: "december",
};
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const SHORT_WEEKDAYS: Record<string, string> = {
  Mon: "monday", Tue: "tuesday", Tues: "tuesday", Wed: "wednesday", Thu: "thursday", Thur: "thursday",
  Thurs: "thursday", Fri: "friday", Sat: "saturday", Sun: "sunday",
};

const ADVICE =
  /\b(should|shouldn't|ought|recommend\w*|suggest\w*|advis\w*|advice|consider\w*|you (could|might|may) want|try to|make sure|i'd|i would|better to|best to|need to|have to|must|invest\w*|consolidat\w*|pay off|paying off|contact|dispute|save money|cut back|cut down|reduce|worth)\b/i;
const OTHER_MONEY = /[%$€¥]|\b(pounds?|quid|pence|p|gbp|percent|per cent|euros?|dollars?)\b/i;
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
  that that's the there these they this those today two you you're you've your yes`.split(/\s+/),
);

const clean = (text: string) => text.replace(/[’‘]/g, "'");

/** Rewrites short month and day names, and "5th of" forms, so one date only has one spelling. */
function normaliseDates(text: string): string {
  return text
    .replace(/\b(Mon|Tues?|Wed|Thu|Thurs?|Fri|Sat|Sun)\b\.?/g, (m) => SHORT_WEEKDAYS[m.replace(".", "")] ?? m)
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b\.?/g, (m) => SHORT_MONTHS[m.replace(".", "")] ?? m)
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(new RegExp(`\\b(\\d{1,2}) of (${MONTHS}|may)\\b`, "g"), "$1 $2")
    .replace(new RegExp(`\\b(${MONTHS}|may) (\\d{1,2})\\b`, "g"), "$2 $1");
}

const amounts = (text: string) => (text.match(/£\s?\d[\d,]*(?:\.\d+)?/g) ?? []).map((a) => a.replace(/[\s,]/g, ""));
const numbers = (text: string) => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
const months = (text: string) => text.match(new RegExp(`\\b(${MONTHS})\\b`, "g")) ?? [];
const weekdays = (text: string) => text.match(new RegExp(`\\b(${WEEKDAYS})\\b`, "g")) ?? [];
const dayMonths = (text: string) => text.match(new RegExp(`\\b\\d{1,2} (${MONTHS}|may)\\b`, "g")) ?? [];
const fullDates = (text: string) => text.match(new RegExp(`\\b(${WEEKDAYS})(?: the)? \\d{1,2} (${MONTHS}|may)\\b`, "g")) ?? [];

/** "1 to 8 November" states both dates, but only spells the month once. */
const expandRanges = (text: string) =>
  text.replace(new RegExp(`\\b(\\d{1,2}) to (\\d{1,2}) (${MONTHS})\\b`, "g"), "$1 $3 to $2 $3");

const factText = (facts: AnswerFactSet) => facts.facts.map((f) => `${f.label}: ${f.value}`).join("\n");

/** Lowers every month and day name so the name check skips them. */
const normaliseProperDates = (text: string) =>
  text.replace(new RegExp(`\\b(${MONTHS}|${WEEKDAYS}|may|${Object.keys(SHORT_MONTHS).join("|")}|${Object.keys(SHORT_WEEKDAYS).join("|")})\\b`, "gi"), (m) => m.toLowerCase());

const capitalised = (text: string) => text.match(/\b[A-Z][A-Za-z'-]*/g) ?? [];

const sentenceCount = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "").length;

const AMOUNT = "£\\d[\\d,]*(?:\\.\\d+)?";
const BILL_TERMS = "current balance|statement balance|bill|minimum payment|minimum|owe|owing";

/** Which fact each way of naming a bill amount refers to. */
function factForTerm(term: string): string {
  const t = term.toLowerCase();
  if (t.startsWith("minimum")) return "minimum_payment";
  return t === "bill" || t === "statement balance" ? "statement_balance" : "current_balance";
}

const NOT_ARRIVED = /\b(pending|not (?:yet )?(?:arrived|been|reached|come|completed)|has(?:n't| not) (?:yet )?(?:arrived|come|reached|completed)|yet to|on its way|still processing|processing|waiting)\b/i;
const ARRIVED = /\b(arrived|received|got|completed|came through|gone through|paid back|back in your account|in your account)\b/i;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/);

/** Checks each refund is stated with its true status. A pending refund must never be said to have arrived. */
function refundProblem(reply: string, facts: AnswerFactSet): string | null {
  const amountOf = (value: string) => value.match(/^£[\d,.]*\d/)?.[0].replace(/,/g, "") ?? "";
  const refunds = facts.facts.filter((f) => f.key.startsWith("refund_"));
  const stated = amounts(reply);
  if (refunds.some((f) => !stated.includes(amountOf(f.value)))) return "no supporting fact";

  const pending = refunds.filter((f) => f.key.startsWith("refund_pending_")).map((f) => amountOf(f.value));
  const completed = refunds.filter((f) => f.key.startsWith("refund_completed_")).map((f) => amountOf(f.value));
  for (const sentence of sentences(reply)) {
    const here = amounts(sentence);
    const mentionsPending = here.some((a) => pending.includes(a) && !completed.includes(a));
    const mentionsCompleted = here.some((a) => completed.includes(a) && !pending.includes(a));
    if (mentionsPending && !NOT_ARRIVED.test(sentence)) return "contradicts facts";
    if (mentionsPending && ARRIVED.test(sentence.replace(/\b(?:has|have)?(?:n't| not)\s+(?:yet\s+)?\w+/gi, ""))) return "contradicts facts";
    if (mentionsCompleted && !mentionsPending && NOT_ARRIVED.test(sentence)) return "contradicts facts";
    if (mentionsPending && mentionsCompleted) return "contradicts facts";
  }
  return null;
}

/** True when a reply says the whole current balance has to be paid now. */
function saysCurrentBalanceIsDue(reply: string, current: string | undefined): boolean {
  if (!current) return false;
  return new RegExp(`${escapeRegExp(current)}[^,.;]{0,25}\\b(?:is due|due now|must be paid|to pay now|now due)\\b`, "i").test(reply);
}

/** True when a reply puts one balance's name on another's amount, as in "Your current balance is £486.20". */
function mixesBalances(reply: string, value: (key: string) => string | undefined): boolean {
  const named = [
    ...[...reply.matchAll(new RegExp(`\\b(${BILL_TERMS})\\b[^£.!?]{0,30}(${AMOUNT})`, "gi"))].map((m) => [m[1], m[2]]),
    ...[...reply.matchAll(new RegExp(`(${AMOUNT})\\s+(?:is\\s+|as\\s+)?(?:your\\s+|the\\s+)?(${BILL_TERMS})\\b`, "gi"))].map((m) => [m[2], m[1]]),
  ];
  return named.some(([term, amount]) => {
    const expected = value(factForTerm(term));
    return expected !== undefined && expected.replace(/,/g, "") !== amount.replace(/[.,]$/, "").replace(/,/g, "");
  });
}

/** Only the bare sentence counts, so "Yes, but I can't tell that..." can't slip past the grounding check. */
export const isCantTell = (text: string) => /^i can't tell that from your transactions\.?$/i.test(clean(text).trim());

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the amount is pinned to the wrong month, as in "You spent £402.35 last month". */
function inWrongPeriod(reply: string, amount: string, period: string): boolean {
  const figure = escapeRegExp(amount);
  return new RegExp(`${figure}(?:\\s+\\w+){0,2}\\s+(?:in\\s+)?(?:${period})|(?:${period})[^.]{0,30}${figure}`, "i").test(reply);
}

/**
 * Passing the amount and date checks only proves a reply invented nothing, and a reply with no figures passes those
 * by default. This proves it actually states the answer: it has to carry the fact that settles the question, and
 * must not deny or reverse it.
 */
function groundingProblem(reply: string, facts: AnswerFactSet, question: string): string | null {
  const value = (key: string) => facts.facts.find((f) => f.key === key)?.value;
  const values = (prefix: string) => facts.facts.filter((f) => f.key.startsWith(prefix)).map((f) => f.value);
  const stated = amounts(reply);
  const has = (amount: string | undefined) => amount !== undefined && stated.includes(amount.replace(/,/g, ""));
  const named = (name: string) => reply.toLowerCase().includes(name.toLowerCase());
  const replyDates = normaliseDates(reply);
  const contradicted = "contradicts facts";
  const unsupported = "no supporting fact";

  const valuesText = facts.facts.map((f) => f.value).join(" ");
  if (HIGHER.test(valuesText) && !LOWER.test(valuesText) && LOWER.test(reply)) return contradicted;
  if (LOWER.test(valuesText) && !HIGHER.test(valuesText) && HIGHER.test(reply)) return contradicted;

  if (mixesBalances(reply, value) || saysCurrentBalanceIsDue(reply, value("current_balance"))) return contradicted;

  switch (facts.intent) {
    case "subscription_list": {
      if (value("no_subscriptions")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
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
      return refundProblem(reply, facts);
    case "merchant_transactions": {
      if (value("no_transactions")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
      if (!facts.merchant || !named(facts.merchant)) return unsupported;
      const rows = facts.facts.filter((f) => f.key.startsWith("transaction_"));
      const refundAmounts = rows.filter((f) => f.value.includes("refund)")).map((f) => f.value.match(/^£[\d,.]*\d/)?.[0]);
      if (!/\brefund/i.test(reply) && refundAmounts.some(has)) return contradicted;
      // A date answers "when". Anything else needs the total, or a partial list could pass for the whole picture.
      const dates = rows.map((f) => f.value.match(/\d{1,2} [A-Z][a-z]+/)?.[0].toLowerCase());
      const datesAnswer = /\bwhen\b/i.test(question) && dates.some((d) => d && replyDates.includes(d));
      return has(value("merchant_total")) || datesAnswer ? null : unsupported;
    }
    case "duplicates": {
      if (value("no_duplicates")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
      const found = values("duplicate_").map((v) => v.match(/^(.+?), (£[\d,.]+), on /));
      return found.some((m) => m && named(m[1]) && has(m[2])) ? null : unsupported;
    }
    case "price_changes": {
      if (value("no_price_changes")) return DENIAL.test(reply) ? null : contradicted;
      if (DENIAL.test(reply)) return contradicted;
      const found = values("price_change_").flatMap((v) => v.match(/^(.+?) went (?:up|down) from (£[\d,.]+) to (£[\d,.]+)/) ?? []);
      for (let i = 0; i < found.length; i += 4) {
        const [, merchant, before, after] = found.slice(i, i + 4);
        if (!named(merchant) || !has(after)) continue;
        const swapped = has(before) && stated.indexOf(before.replace(/,/g, "")) > stated.indexOf(after.replace(/,/g, ""));
        return swapped ? contradicted : null;
      }
      return unsupported;
    }
    case "spend_this_month": {
      if (DENIAL.test(reply)) return contradicted;
      const total = value("month_to_date_total");
      if (!has(total)) return unsupported;
      return total && inWrongPeriod(reply, total, "last month|october") ? contradicted : null;
    }
    case "spend_last_month": {
      if (DENIAL.test(reply)) return contradicted;
      const total = value("last_month_total");
      if (!has(total)) return unsupported;
      return total && inWrongPeriod(reply, total, "this month|november") ? contradicted : null;
    }
    case "top_items": {
      if (DENIAL.test(reply)) return contradicted;
      const biggest = value("top_item_1")?.match(/£[\d,.]+?(?=,)/)?.[0];
      return has(biggest) ? null : unsupported;
    }
    case "days_until_due": {
      // "Not all of it is due yet" is the safeguard on the current balance, not a denial.
      if (DENIAL.test(reply.replace(/\bnot all\b/gi, ""))) return contradicted;
      const asked = billQuestion(question);
      if (asked === "owed") return [value("current_balance"), value("statement_balance"), value("minimum_payment")].every(has) ? null : unsupported;
      if (asked === "pay") return has(value("statement_balance")) && has(value("minimum_payment")) ? null : unsupported;
      if (asked === "current" || asked === "balance") return has(value("current_balance")) ? null : unsupported;
      if (asked === "bill") return has(value("statement_balance")) ? null : unsupported;
      const due = value("due_date")?.toLowerCase() ?? "";
      const left = value("days_until_due")?.toLowerCase().replace("overdue by ", "") ?? "";
      const dueDay = due.replace(/^\w+ /, "");
      const stands = [due.split(" ")[0], dueDay, left].some((text) => text !== "" && replyDates.includes(text));
      return stands || has(value("statement_balance")) ? null : unsupported;
    }
    case "minimum_payment":
      if (DENIAL.test(reply)) return contradicted;
      return has(value("minimum_payment")) ? null : unsupported;
    case "spend_pause": {
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
  if (ADVICE.test(reply)) return fail("advice wording");

  const source = factText(facts);
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
  const problem = groundingProblem(reply, facts, question);
  return problem ? fail(problem) : pass;
}
