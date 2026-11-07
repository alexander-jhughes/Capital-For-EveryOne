// Ties each amount in a reply to the fact it belongs to. A figure being somewhere in the facts proves nothing: it has
// to be attached to the right shop, date, meaning and status. Each fact becomes a claim, and every amount in a reply
// must satisfy a claim for that amount, judged only on the words around it.
import type { AnswerFactSet } from "./answer-facts";
import { AMOUNT_PATTERN, dayMonths, escapeRegExp, normaliseDates, plainAmount } from "./reply-text";

export interface Claim {
  amount: string;
  /** The words around the amount must match this. */
  must?: RegExp;
  /** The words around the amount must not match this. */
  mustNot?: RegExp;
  /** The word right after the amount can't be this, as in "£500.00 left". */
  notFollowedBy?: RegExp;
  /** The nearest shop named must be this one. */
  merchant?: string;
  /** The nearest date given must be one of these, as "13 november". */
  dates?: string[];
}

export interface ClaimSet {
  claims: Claim[];
  /** Phrases that reverse the facts, wherever they appear. */
  forbidden?: RegExp;
  /** Counts in the facts, such as "7 transactions". Any other count is wrong. */
  counts?: { noun: string; value: number }[];
  /** How many days a due date is away, if the facts say. */
  days?: number;
  merchants: string[];
}

/** Where one amount's words end and the next one's begin. */
const BOUNDARY = /[.!?]\s|;\s*|,?\s+(?:and|but|while|whereas|plus)\s+|,\s+(?=(?:your|you|the)\b)|,?\s+(?=(?:compared|versus|than)\b)/i;

/** "Not all of it is due yet" is the safeguard on the current balance. It never means an amount is due. */
const withoutSafeguards = (text: string) => text.replace(/\bnot all(?: of it)?(?: is)? due(?: yet)?\b/gi, "").replace(/\bisn't all due(?: yet)?\b/gi, "");

interface Span {
  amount: string;
  /** The amount's position in the reply. */
  start: number;
  end: number;
  /** The stretch of the reply that describes it, amount included. */
  from: number;
  to: number;
}

/** Splits a reply so each amount only keeps the words that describe it. */
export function amountSpans(reply: string): Span[] {
  const found = [...reply.matchAll(AMOUNT_PATTERN)].map((m) => ({ amount: plainAmount(m[0]), start: m.index, end: m.index + m[0].length }));
  return found.map((item, i) => {
    const previous = found[i - 1];
    const next = found[i + 1];
    let from = previous ? previous.end : 0;
    if (previous) {
      // Starts after the last boundary. The earlier amount stops at the first, so nothing between them is shared wrongly.
      const cuts = [...reply.slice(previous.end, item.start).matchAll(new RegExp(BOUNDARY.source, "gi"))].at(-1);
      if (cuts) from = previous.end + cuts.index + cuts[0].length;
    } else {
      const sentenceStart = reply.slice(0, item.start).search(/[^.!?;]*$/);
      from = Math.max(sentenceStart, 0);
    }
    const tail = reply.slice(item.end, next ? next.start : undefined);
    const cut = tail.match(next ? BOUNDARY : new RegExp(BOUNDARY.source + "|[.!?]$", "i"));
    const to = cut?.index !== undefined ? item.end + cut.index : next ? next.start : reply.length;
    return { ...item, from, to };
  });
}

/** The name in the span closest to the amount. Lists are read as "Netflix £12.99, Spotify £11.99", not one blob. */
function nearest(reply: string, span: Span, names: string[]): string | undefined {
  const text = reply.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const lower = name.toLowerCase();
    for (let at = text.indexOf(lower, span.from); at !== -1 && at < span.to; at = text.indexOf(lower, at + 1)) {
      const distance = at + lower.length <= span.start ? span.start - (at + lower.length) : at - span.end;
      if (distance >= 0 && (!best || distance < best.distance)) best = { name, distance };
    }
  }
  return best?.name;
}

function nearestDate(reply: string, span: Span): string | undefined {
  const before = dayMonths(normaliseDates(reply.slice(span.from, span.start))).at(-1);
  const after = dayMonths(normaliseDates(reply.slice(span.end, span.to)))[0];
  if (!before || !after) return before ?? after;
  const beforeGap = span.start - span.from - normaliseDates(reply.slice(span.from, span.start)).lastIndexOf(before);
  const afterGap = normaliseDates(reply.slice(span.end, span.to)).indexOf(after);
  return afterGap <= beforeGap ? after : before;
}

function meets(claim: Claim, reply: string, span: Span, merchants: string[]): boolean {
  const words = withoutSafeguards(`${reply.slice(span.from, span.start)} ${reply.slice(span.end, span.to)}`);
  if (claim.must && !claim.must.test(words)) return false;
  if (claim.mustNot?.test(words)) return false;
  if (claim.notFollowedBy?.test(reply.slice(span.end, span.to))) return false;
  if (claim.merchant) {
    const shop = nearest(reply, span, merchants);
    if (shop && shop !== claim.merchant) return false;
  }
  if (claim.dates) {
    const date = nearestDate(reply, span);
    if (date && !claim.dates.includes(date)) return false;
  }
  return true;
}

const AMOUNT_IN_VALUE = /£[\d,.]*\d/g;
const moneyIn = (value: string | undefined) => (value?.match(AMOUNT_IN_VALUE) ?? []).map(plainAmount);
const datesIn = (value: string) => [...new Set(dayMonths(normaliseDates(value)))];

const NOT_ARRIVED = /\b(pending|not (?:yet )?(?:arrived|been|reached|come|completed)|(?:has|have)(?:n't| not) (?:yet )?(?:arrived|come|reached|completed)|yet to|on its way|still processing|processing|waiting)\b/i;
const ARRIVED = /\b(arrived|received|got|completed?|came through|gone through|paid back|back in your account|in your account|landed|cleared|finished|no longer pending|not pending|isn't pending)\b/i;
const NEGATED = /\b(?:has|have)?(?:n't| not)\s+(?:yet\s+)?\w+/gi;
const NOT_YET = new RegExp(NOT_ARRIVED.source, "i");

/** The claims behind one fact set: what each figure means, in words a reply could use. */
function claimsFor(set: AnswerFactSet): ClaimSet {
  const fact = (key: string) => set.facts.find((f) => f.key === key);
  const value = (key: string) => fact(key)?.value;
  const money = (key: string) => moneyIn(value(key))[0];
  const withPrefix = (prefix: string) => set.facts.filter((f) => f.key.startsWith(prefix));
  const claims: Claim[] = [];
  const add = (amount: string | undefined, rule: Omit<Claim, "amount">) => {
    if (amount) claims.push({ amount, ...rule });
  };
  const shopFrom = (text: string, pattern: RegExp) => text.match(pattern)?.[1];
  const merchants: string[] = [];
  const noteShop = (name: string | undefined) => {
    if (name && !merchants.includes(name)) merchants.push(name);
    return name;
  };

  switch (set.intent) {
    case "spend_this_month": {
      const category = value("month_top_category")?.split(",")[0];
      const categoryWords = category ? `|${escapeRegExp(category)}` : "";
      add(money("month_to_date_total"), {
        must: /\b(spent|spend|spending|total|so far|this month|november)\b/i,
        mustNot: new RegExp(`\\b(last month|october|same days|previous|biggest|categor\\w*${categoryWords}|refund\\w*)\\b`, "i"),
      });
      if (category) add(money("month_top_category"), { must: new RegExp(`\\b(${escapeRegExp(category)})\\b`, "i"), mustNot: /\b(total|same days|last month)\b/i });
      add(money("month_refunds"), { must: /\brefund/i, mustNot: /\b(arrived|received|in your account)\b/i });
      add(money("same_days_last_month_total"), { must: /\b(same days|last month|october|previous)\b/i, mustNot: /\b(so far|november)\b/i });
      add(money("change_vs_same_days_last_month"), { must: /\b(more|less|up|down|higher|lower|than|difference)\b/i });
      break;
    }
    case "spend_last_month": {
      const category = value("last_month_top_category")?.split(",")[0];
      const categoryWords = category ? `|${escapeRegExp(category)}` : "";
      add(money("last_month_total"), {
        must: /\b(spent|spend|spending|total|october|last month)\b/i,
        mustNot: new RegExp(`\\b(this month|november|so far|biggest|categor\\w*${categoryWords})\\b`, "i"),
      });
      if (category) add(money("last_month_top_category"), { must: new RegExp(`\\b(${escapeRegExp(category)})\\b`, "i"), mustNot: /\btotal\b/i });
      break;
    }
    case "top_items":
      withPrefix("top_item_").forEach((f, i) => {
        const shop = noteShop(shopFrom(f.value, /^(.+?), £/));
        const rank = i === 0 ? { mustNot: /\b(second|third)\b/i } : { mustNot: new RegExp(`(?<!${i === 1 ? "second" : "third"} )\\b(biggest|largest|top)\\b`, "i") };
        add(moneyIn(f.value)[0], { ...rank, merchant: shop, dates: datesIn(f.value) });
      });
      break;
    case "duplicates":
      for (const f of withPrefix("duplicate_")) add(moneyIn(f.value)[0], { merchant: noteShop(shopFrom(f.value, /^(.+?), £/)), dates: datesIn(f.value) });
      break;
    case "price_changes":
      for (const f of withPrefix("price_change_")) {
        const shop = noteShop(shopFrom(f.value, /^(.+?) went /));
        const [before, after, change] = moneyIn(f.value);
        add(before, { must: /\b(from|was|were|used to|previous\w*|before|had been)\b/i, mustNot: /\bby\b/i, merchant: shop });
        add(after, { mustNot: /\b(from|by)\s*$/i, notFollowedBy: /^\s+(more|less|extra)\b/i, merchant: shop, dates: datesIn(f.value) });
        add(change, { must: /\b(by|more|less|extra|difference|increase|decrease|rise|up|down)\b/i, merchant: shop });
      }
      break;
    case "days_until_due":
    case "minimum_payment": {
      add(money("current_balance"), {
        must: /\b(current|everything|total|overall|balance|owe|owing)\b/i,
        mustNot: /\b(bill|statement|minimum|due|payable|must pay|pay by|by (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i,
      });
      add(money("statement_balance"), { must: /\b(bill|statement|due|pay|payment)\b/i, mustNot: /\b(current|everything|overall|total balance|owe|owing|minimum)\b/i });
      add(money("minimum_payment"), { must: /\b(minimum|least)\b/i, mustNot: /\b(current|balance)\b/i });
      add(moneyIn(value("last_payment"))[0], { must: /\b(last|paid|payment)\b/i, mustNot: /\b(bill|statement|minimum|current|due)\b/i });
      break;
    }
    case "merchant_transactions": {
      const shop = noteShop(set.merchant);
      add(money("merchant_total"), {
        must: /\b(total\w*|spent|spend|altogether|in all|net|comes? to|paid|at)\b/i,
        mustNot: /\b(latest|last (?:one|purchase|transaction|refund)|most recent|each|single)\b/i,
        merchant: shop,
      });
      for (const f of withPrefix("transaction_")) {
        const isRefund = f.value.includes("refund)");
        add(moneyIn(f.value)[0], {
          must: isRefund ? /\b(refund\w*|back|credit\w*)\b/i : undefined,
          mustNot: isRefund ? /\b(total\w*|altogether)\b/i : /\b(refund\w*|total\w*|altogether)\b/i,
          merchant: shop,
          dates: datesIn(f.value),
        });
      }
      break;
    }
    case "merchant_refunds":
      for (const f of withPrefix("refund_")) {
        const shop = noteShop(shopFrom(f.label, /^(?:Pending|Completed) (.+?) refund/));
        const [refund, purchase] = moneyIn(f.value);
        const pending = f.key.startsWith("refund_pending_");
        const dates = datesIn(f.value);
        claims.push(
          pending
            ? { amount: refund, must: NOT_YET, mustNot: /\b(no longer pending|not pending|isn't pending|finished|cleared|landed|completed|done)\b/i, merchant: shop, dates }
            : { amount: refund, mustNot: /\b(pending|not (?:yet )?arrived|hasn't arrived|on its way|processing|waiting)\b/i, merchant: shop, dates },
        );
        add(purchase, { must: /\b(purchase\w*|bought|order\w*|paid)\b/i, mustNot: /\brefund/i, merchant: shop, dates });
      }
      break;
    case "spend_pause":
      add(money("check_over"), { must: /\b(over|above|check\w*|more than|limit|threshold)\b/i, mustNot: /\bbudget\b/i, notFollowedBy: /^\s+(left|remaining)\b/i });
      add(money("monthly_budget"), { must: /\bbudget\b/i, notFollowedBy: /^\s+(left|remaining|over|spent)\b/i });
      add(money("budget_spent"), { must: /\b(spent|used|towards)\b/i, notFollowedBy: /^\s+(left|remaining|over)\b/i });
      add(money("budget_left"), { must: /\b(left|remain\w*)\b/i, mustNot: /\bover\b/i });
      add(money("budget_over"), { must: /\bover\b/i, mustNot: /\b(left|remain\w*)\b/i });
      break;
  }

  const on = value("spend_pause_status") === "On";
  const forbidden: Partial<Record<AnswerFactSet["intent"], RegExp | undefined>> = {
    duplicates: /\b(once|one time|single charge|just one|only one)\b/i,
    price_changes: /\b(same|unchanged|stayed|didn't change|hasn't changed|no change)\b/i,
    spend_pause: on ? /\b(off|disabled|inactive|turned off|switched off)\b/i : /\bpause\b[^.]*\b(on|enabled|active)\b/i,
  };

  const counts: ClaimSet["counts"] = [];
  const countOf = (key: string, noun: string) => {
    if (value(key)) counts.push({ noun, value: Number(value(key)) });
  };
  countOf("merchant_transactions", "transactions?");
  countOf("merchant_purchases", "purchases?");
  countOf("last_month_purchases", "purchases?");

  const left = value("days_until_due")?.match(/(\d+) days?/)?.[1];
  return { claims, forbidden: forbidden[set.intent], counts, days: left ? Number(left) : undefined, merchants };
}

/** Null if every figure in the reply belongs where it was put, otherwise the reason it doesn't. */
export function claimProblem(reply: string, set: AnswerFactSet): string | null {
  const { claims, forbidden, counts, days, merchants } = claimsFor(set);
  if (forbidden?.test(reply)) return "contradicts facts";

  for (const { noun, value } of counts ?? []) {
    const stated = [...reply.matchAll(new RegExp(`\\b(\\d+)\\s+(?:[\\w']+\\s+){0,2}${noun}\\b`, "gi"))];
    if (stated.some((m) => Number(m[1]) !== value)) return "contradicts facts";
  }

  const stated = [...reply.matchAll(/\b(\d+) days?\b/gi)];
  if (days !== undefined && stated.some((m) => Number(m[1]) !== days)) return "contradicts facts";

  for (const span of amountSpans(reply)) {
    const candidates = claims.filter((c) => c.amount === span.amount);
    if (candidates.length === 0) return "no supporting fact";
    if (!candidates.some((c) => meets(c, reply, span, merchants))) return "contradicts facts";
  }

  // A pending refund can't also be said to have arrived, whatever else its words say.
  if (set.intent === "merchant_refunds") {
    const pending = set.facts.filter((f) => f.key.startsWith("refund_pending_")).map((f) => moneyIn(f.value)[0]);
    const completed = set.facts.filter((f) => f.key.startsWith("refund_completed_")).map((f) => moneyIn(f.value)[0]);
    const spans = amountSpans(reply);
    for (const [i, span] of spans.entries()) {
      if (!pending.includes(span.amount) || completed.includes(span.amount)) continue;
      // Reads on past "and": "is pending and has arrived" still says it arrived.
      const sentenceEnd = reply.slice(span.end).search(/[.!?;](?:\s|$)/);
      const end = spans[i + 1]?.from ?? (sentenceEnd === -1 ? reply.length : span.end + sentenceEnd);
      if (ARRIVED.test(reply.slice(span.from, end).replace(NEGATED, ""))) return "contradicts facts";
    }
  }
  return null;
}
