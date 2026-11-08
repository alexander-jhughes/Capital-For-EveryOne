// The Dial planner: one utterance (typed or spoken) in, a short list of allowlisted steps out.
//
//   text ─► self-correction ─► segment() ─► classify each part (rules first) ─► DialStep[] (validated)
//
// Pure and deterministic: no network, no React, no router, and nothing here can move money. Most requests are
// answered by rules (controls, display, navigation, visuals, what-ifs, goals, Pay and Spend Pause). Only open or
// ambiguous money questions become an "ask" step, the one step that may reach the backend.
import { formatPence } from "../format";
import type { UiAction } from "../preferences/schema";
import { describeActions } from "../preferences/schema";
import { splitCorrection } from "../voice/correction";
import { interpret, isQuestionText, normaliseUtterance, type Interpretation } from "../voice/interpret";
import { isStopWord } from "../voice/transcript";
import { nextSubject } from "./context";
import {
  addMonths,
  findAmount,
  findCategories,
  findMerchants,
  findMonthMatches,
  findMonths,
  findTargetMonth,
  findTransactionRef,
  lowerSame,
  monthName,
  monthOf,
  validPence,
  type AmountMatch,
  type CategoryMatch,
  type MerchantMatch,
  type MonthMatch,
  type SpendCategory,
  type TxnSummary,
} from "./entities";
import { findPlace, OPENABLE, PAY_NOTE, PLACES, ROUTE_INFO, ROUTE_WORDS, SECTION_INFO, validateStep } from "./registry";
import { segment } from "./segment";
import type { ControlCommand, DialContext, DialPlan, DialRoute, DialStep, DialSubject, GoalSpec, HomeSection, MonthKey, PlanEnv, SpendingFilters, VisualRequest, WhatIfScenario } from "./types";

/**
 * PlanEnv, plus an optional list of transactions so "open the Argos purchase" can name the one transaction. Without
 * it, a shop's purchase opens Spending filtered to that shop. Optional, so a plain PlanEnv is always enough.
 */
export type PlanEnvWithTransactions = PlanEnv & { transactions?: readonly TxnSummary[] };

/** A plan has at most this many steps; anything after is said back, not done. */
export const MAX_STEPS = 4;

const FOOD_PAIR: SpendCategory[] = ["Groceries", "Eating out"];
const FOOD_SAY = "Food covers two categories, groceries and eating out, so here are both.";
const FOOD_CLARIFY = "Do you mean groceries or eating out? Food covers both.";
const NOT_UNDERSTOOD = "Sorry, I didn't understand that. You can ask about your money, open a page such as Spending, or change how the app looks.";

// ─── Reading one part ───────────────────────────────────────────────────────────────────────────────────────────

interface Said {
  text: string;
  /** Normalised: lower case, plain words, a space at each end. */
  s: string;
  categories: SpendCategory[];
  /** "food" on its own: groceries or eating out, never guessed. */
  food: boolean;
  merchants: string[];
  /** "Tesco Mobile": a different business that shares a known shop's name. */
  otherBusiness: string | null;
  months: MonthKey[];
  unavailable: MonthKey[];
  /** "the last three months" or "September to November". */
  span: boolean;
  question: boolean;
  amount: AmountMatch | null;
}

function read(text: string, env: PlanEnvWithTransactions): Said {
  const cats = findCategories(text);
  const shops = findMerchants(text, env.merchants);
  const months = findMonths(text, env);
  return {
    text,
    s: normaliseUtterance(text),
    categories: [...new Set(cats.filter((c) => c.category !== "food").map((c) => c.category as SpendCategory))],
    food: cats.some((c) => c.category === "food"),
    merchants: [...new Set(shops.matches.map((m) => m.merchant))],
    otherBusiness: shops.otherBusiness,
    months: months.months,
    unavailable: months.unavailable,
    span: months.lastN,
    question: isQuestionText(text),
    amount: findAmount(text),
  };
}

/** What this part named, for the conversation's subject. Only one unambiguous category or shop counts. */
function subjectOf(said: Said): DialSubject {
  const out: DialSubject = {};
  if (said.categories.length === 1 && !said.food) out.category = said.categories[0];
  if (said.merchants.length === 1) out.merchant = said.merchants[0];
  if (said.months.length) out.months = said.months;
  return out;
}

const current = (env: PlanEnv) => monthOf(env.today);
const available = (k: MonthKey, env: PlanEnv) => k === current(env) || env.months.includes(k);
const money = (p: number) => formatPence(p).replace(/\.00$/, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const has = (s: string, re: RegExp) => re.test(s);

function rangeLabel(env: PlanEnv): string {
  const all = [...new Set([...env.months, current(env)])].sort();
  return all.length > 1 ? `${monthName(all[0], env.today)} to ${monthName(all.at(-1)!, env.today)}` : monthName(all[0], env.today);
}

function monthsPhrase(months: MonthKey[] | undefined, env: PlanEnv, fallback = " this month"): string {
  if (!months?.length) return fallback;
  if (months.length === 1) return months[0] === current(env) ? " this month" : ` in ${monthName(months[0], env.today)}`;
  const sorted = [...months].sort();
  const contiguous = sorted.every((k, i) => i === 0 || addMonths(sorted[i - 1], 1) === k);
  const names = sorted.map((k) => monthName(k, env.today));
  return contiguous ? ` from ${names[0]} to ${names.at(-1)}` : ` in ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ─── Words that decide which rule applies ───────────────────────────────────────────────────────────────────────

const MONEY = / (spend|spent|spending|money|bill|balance|owe|owed|pay|paid|payment|payments|budget|statement|interest|credit|refund|refunds|charge|charged|subscription|subscriptions|transaction|transactions|purchase|purchases|cost|costs|save|saving|savings) /;
const STRONG_NAV =
  /^ (?:(?:please|ok|okay|hey|dial|now|right|so|can|could) )*(?:you )?(?:please )?(?:take me(?: back)?(?: to)?|go(?: back)? to|open(?: up)?|navigate to|bring up|jump to|head to|get me to|(?:i want|i'd like|i need|i wanna) to go to|let me go to|switch to|move to|load|go) /;
const WEAK_NAV =
  /^ (?:(?:please|ok|okay|now|right|so) )*(?:can you |could you |would you )?(?:please )?(?:show(?: me)?|see|view|display|check|let me see|(?:i want|i'd like|i wanna) to see|where(?:'s| is| are| can i find| do i find| can i see)|find|look at|pull up|give me) /;
const DIAL_NOTICED = / (what has dial noticed|what did dial notice|what dial (has )?noticed|what's dial noticed|has dial noticed anything|anything dial noticed|what have you noticed|anything i should know) /;
const PAY_INTENT = /^ (?:please )?(?:i want to |i'd like to |i would like to |i need to |i wanna |let me |can i |could i |how do i |how can i |help me )?(?:pay|make a payment|make my payment|pay off) /;
const JUDGEMENT = / (why|should|shall|ought|recommend|advice|advise|afford|worth|ok|okay|alright|normal|too much|a lot|good|bad|explain|safe|enough|worried|healthy|wise|unusual|weird|strange) /;
const ANAPHORA = / (that|it|this|those|these|them) /;
const SHOW = /^ (?:(?:please|ok|okay|now|so) )*(?:can you |could you )?(?:please )?(?:show|see|view|display|let me see|i want to see|i'd like to see|give me|pull up|open|take me to|go to) /;
const SPEND = / (spend|spent|spending|money|costs?|outgoings|expenses?) /;
const COMPARE =
  / (compare|comparison|compared|comparing|versus|vs|against|changed?|changing|difference|different|gone up|gone down|went up|went down|go up|go down|going up|going down|rising|falling|more than|less than|higher|lower|increased?|decreased?|up or down) /;
const TREND = / (over time|month by month|each month|every month|per month|monthly|trend|history|over the (last|past)|across) /;
const BREAKDOWN =
  / (where (does|did|do) (most of |all of |all )?my money (go|going)|where('s| is| has) (all )?my money (going|gone|been going)|where my money (goes|went)|what (do|did|am) i (spend|spent|spending) (the )?most on|what am i spending (my money )?on|what do i spend my money on|biggest (spending )?categor(y|ies)|by category|categor(y|ies)|breakdown|break down|split of my spending) /;
const BIGGEST =
  / (?:biggest|largest|most expensive|top|highest|priciest|costliest|dearest) (?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten) )?(?:single )?(purchases?|expenses?|spends|transactions?|buys|things i (?:bought|paid for)|items?|payments?|costs?|charges?) /;
const BUDGET = / budget /;
const LAYOUT = / (home screen|home page|at the top|to the top|on top|first|stand out|more visible|from home|on home|dashboard|section|sections|widget) /;
const BUDGET_CHANGE = / (set|change|edit|update|adjust|raise|lower|reset|increase|decrease|move) (my |the )?(monthly )?budget /;
const BUDGET_LEFT = / (left|remaining|how much|on track|over|within|under|progress|doing|stand|going|used|use|use up|spent|close) /;
const TOTAL = / (how much|what) (did|have|do|has) i (spend|spent|spending)|what('s| is| was) my (total )?spend(ing)?|my total spend(ing)?|total spend(ing)?|how much have i spent /;

const COUNT: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ─── Turns ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Turn {
  steps: DialStep[];
  understood: string;
  /** True when this turn builds on the last one ("what about eating out?"), so the subject is merged, not replaced. */
  followUp?: boolean;
  /** Set for turns where the person's own words should not change the subject (controls, display). */
  keepSubject?: boolean;
}

const unsupported = (say: string, understood = "Not something Dial can do"): Turn => ({ steps: [{ type: "unsupported", say }], understood, keepSubject: true });

function ask(question: string, ctx: DialContext): Turn {
  // Plain words only: markup or control characters are dropped here, so the validator never has to refuse a question.
  const q = question.replace(/[<>{}\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "Can you help me?";
  const step: DialStep = ctx.lastQuestion ? { type: "ask", question: q, previousQuestion: ctx.lastQuestion.slice(0, 300) } : { type: "ask", question: q };
  return { steps: [step], understood: q };
}

const CONTROL_LABEL: Record<ControlCommand, string> = {
  yes: "Yes",
  no: "No",
  stop: "Stop",
  undo: "Undo",
  reset: "Back to the original look",
  exit: "Close Dial",
  help: "Help",
  readPage: "Read the page aloud",
  readBalance: "Read my balance",
  save: "Save my settings",
};

function prefsTurn(actions: UiAction[]): Turn {
  return { steps: [{ type: "preferences", actions }], understood: cap(describeActions(actions)), keepSubject: true };
}

function modeTurn(mode: "simple" | "complex"): Turn {
  return { steps: [{ type: "setMode", mode }], understood: mode === "simple" ? "Switch to Simple view" : "Switch to Detailed view", keepSubject: true };
}

function describeVisual(v: VisualRequest, env: PlanEnv): string {
  switch (v.kind) {
    case "category_breakdown":
      return `Where your money went${monthsPhrase(v.months, env)}`;
    case "month_comparison": {
      const [a, b] = v.months ?? [current(env), addMonths(current(env), -1)];
      return `${v.category ? `${v.category}: ` : ""}${monthName(a, env.today)} compared with ${monthName(b, env.today)}`;
    }
    case "biggest_purchases":
      return `${v.limit === 1 ? "Your biggest purchase" : `Your ${v.limit ?? 5} biggest purchases`}${v.category ? ` on ${v.category.toLowerCase()}` : ""}${monthsPhrase(v.months, env, "")}`;
    case "budget_progress":
      return "Budget left this month";
    case "monthly_trend":
      return `${v.category ? `${v.category} spending` : "Spending"} month by month${monthsPhrase(v.months, env, "")}`;
    case "category_trend":
      return `${v.category ?? "Spending"}${monthsPhrase(v.months, env)}`;
  }
}

function visualTurn(requests: VisualRequest[], env: PlanEnv, extra: Partial<Turn> = {}, lead: DialStep[] = []): Turn {
  const steps: DialStep[] = [...lead, ...requests.map((request): DialStep => ({ type: "visual", request }))];
  return { steps, understood: requests.map((r) => describeVisual(r, env)).join(" and "), ...extra };
}

function describeNavigate(step: Extract<DialStep, { type: "navigate" }>, env: PlanEnv): string {
  if (step.focus) return `Show ${SECTION_INFO[step.focus].spoken} on Home`;
  const f = step.filters;
  if (!f) return `Open ${ROUTE_INFO[step.to].name}`;
  if (f.txn) return `Open transaction ${f.txn}`;
  const what = [f.category, f.merchant].filter(Boolean).join(", ");
  const when = f.month ? monthsPhrase([f.month], env).trim() : "";
  const sorted = f.sort === "highest" ? "biggest first" : "";
  return `Open Spending${[what, when, sorted].some(Boolean) ? `: ${[what, when, sorted].filter(Boolean).join(" ")}` : ""}`;
}

function navTurn(to: DialRoute, opts: { filters?: SpendingFilters; focus?: HomeSection; say?: string } = {}, env: PlanEnv): Turn {
  const step: Extract<DialStep, { type: "navigate" }> = { type: "navigate", to };
  if (opts.filters && Object.keys(opts.filters).length) step.filters = opts.filters;
  if (opts.focus) step.focus = opts.focus;
  if (opts.say) step.say = opts.say;
  return { steps: [step], understood: describeNavigate(step, env) };
}

// ─── Rules ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Make this easier to understand" and "simplify my dashboard" depend on the view the person is in. */
function displayTurn(said: Said, ir: Interpretation, ctx: DialContext): Turn | null {
  const { s } = said;
  if (said.question && has(s, MONEY)) return null;
  const easier = has(s, / (easier to (understand|follow)|hard to (understand|follow)|too complicated|too complex|less complicated|less confusing|plain english|plainer|simpler words) /) && !has(s, MONEY);
  // Detailed view is the busy one, so the simplest fix is Simple view. Already simple: plainer explanations and a
  // calmer home screen. Either way nothing is hidden for good: Detailed view and every section stay one step away.
  if (easier) return ctx.mode === "complex" ? modeTurn("simple") : prefsTurn([{ type: "density", value: "calm" }, { type: "explanations", value: "stepByStep" }]);
  const simplify = has(s, / (simplify|simpler|declutter|less cluttered) /) && ir.kind === "ui" && ir.actions.some((a) => a.type === "density" && a.value === "calm");
  if (simplify && ctx.mode === "complex") return modeTurn("simple");
  return null;
}

function goalTurn(said: Said, env: PlanEnv): Turn | null {
  const { s } = said;
  if (has(s, / (delete|remove|cancel|drop|get rid of|stop|end|clear|scrap) (my |the |that |this |a )?([a-z' ]{0,30} )?goal /))
    // The planner has no list of goals, so it can't name one. The Goals screen lists them and confirms a removal.
    return navTurn("/account/goals", { say: "Here are your goals. Choose Remove on the one you want to delete, and I'll check with you first." }, env);
  if (has(s, / (show|see|view|check|open|list|what are|how are|how's|how is|how am i doing (with|on)|track|progress (on|of))( me)? (my |all my |the |on my )?(savings |spending |monthly )?goals? |^ (my )?goals $/))
    return navTurn("/account/goals", {}, env);

  const create =
    has(s, / (set|create|make|add|start|new|give me|set up|setup)( me)? (a |an |my |me a |up a )?(new )?(savings |saving |spending |monthly )?(goal|target) /) ||
    has(s, / (i want to|i'd like to|i would like to|help me|i need to|i'm trying to|im trying to|my goal is to|goal to|goal is to|i'm going to|im going to|i will|i plan to|i'd love to) (save|spend less|spend under|spend no more|spend at most|spend below|keep|stay|stick|cut|limit|cap|not spend|only spend|reduce) /) ||
    // "Keep my takeaways under £60 a month": an instruction with a limit is a goal too.
    (has(s, /^ (?:please )?(?:keep|limit|cap) my /) && has(s, / (under|below|less than|no more than|at most|to) /));
  if (!create) return null;

  if (has(s, / (stay|keep|stick|remain)( well)? (within|in|to|under|inside|on) (my |the )?(monthly )?budget | on budget | within budget /))
    return goalCreate({ kind: "stay_in_budget" }, "New goal: stay within my budget");

  const amount = findAmount(said.text, { loose: true });
  if (amount && !validPence(amount.pence)) return unsupported("I can only work with amounts under £100,000.");
  const capWords = has(s, / (less than|under|no more than|below|max|maximum|at most|cap|limit|each month|a month|per month|monthly|every month) /);
  const saveWords = has(s, / (save|saving|less|cut|reduce) /);
  if (capWords && (said.categories.length || said.food) && !has(s, / by (the end|christmas|next|january|february|march|april|may|june|july|august|september|october|november|december) /)) {
    if (said.food || said.categories.length > 1) return unsupported(said.food ? FOOD_CLARIFY : "Which category should the goal be for? Say one at a time.");
    if (!amount) return unsupported(`How much a month for ${said.categories[0].toLowerCase()}? For example, less than £80 on ${said.categories[0].toLowerCase()} each month.`);
    return goalCreate({ kind: "category_cap", category: said.categories[0], monthlyLimit: amount.pence }, `New goal: ${said.categories[0]} under ${money(amount.pence)} a month`);
  }
  if (saveWords) {
    const by = findTargetMonth(said.text, env.today);
    if (!amount) return unsupported("How much would you like to save, and by when? For example, save £500 by January.");
    if (!by) return unsupported(`By when would you like to save ${money(amount.pence)}? For example, by January.`);
    // Measured against the last full month, so a part-month doesn't make the baseline look low.
    const baselineMonth = addMonths(current(env), -1);
    return goalCreate({ kind: "spend_reduction", target: amount.pence, by, baselineMonth }, `New goal: spend ${money(amount.pence)} less than ${monthName(baselineMonth, env.today)} by ${monthName(by, env.today)}`);
  }
  if (capWords) return unsupported("Which category should the limit be for? For example, less than £80 on eating out each month. Or say: help me stay within my budget.");
  return unsupported("What would you like your goal to be? For example: save £500 by January, spend less than £80 on eating out each month, or stay within my budget.");
}

const goalCreate = (spec: GoalSpec, understood: string): Turn => ({ steps: [{ type: "goal", op: "create", spec }], understood });

const WHAT_IF =
  / (what if|what would happen if|what happens if|what about if|suppose|supposing|imagine|let's say|say i|if i (spent|spend|paid|pay|saved|save|cut|put|only spent|only spend|reduced|reduce)|could i save|can i save|would i be able to save|will i be able to save|is it possible to save|am i able to save|how long would it take to (pay|save|clear)) /;

function whatIfTurn(said: Said, env: PlanEnv): Turn | null {
  const { s } = said;
  if (!has(s, WHAT_IF)) return null;
  const amount = findAmount(said.text, { loose: true });
  const howMuch = "How much? For example: what if I spend £100 less next month?";
  if (amount && !validPence(amount.pence)) return unsupported("I can only work with amounts under £100,000.");
  const what = (scenario: WhatIfScenario, understood: string): Turn => ({ steps: [{ type: "whatIf", scenario }], understood });

  if (has(s, / (pay|paid|paying|put|clear) /) && has(s, / (a month|per month|each month|every month|monthly|off my card|off the card|towards my card|to my card|off my balance) /)) {
    if (!amount) return unsupported("How much a month? For example: what if I paid £200 a month off my card?");
    return what({ kind: "pay_monthly", amount: amount.pence }, `What if: pay ${money(amount.pence)} a month off your card`);
  }
  if (has(s, / (save|saving|saved) /)) {
    if (!amount) return unsupported("How much would you like to save, and by when? For example: could I save £500 by January?");
    const by = findTargetMonth(said.text, env.today);
    if (!by) return unsupported(`By when would you like to save ${money(amount.pence)}? For example, by January.`);
    return what({ kind: "save_by", target: amount.pence, by }, `What if: save ${money(amount.pence)} by ${monthName(by, env.today)}`);
  }
  if (has(s, / (less|cut|reduce|reduced|fewer|lower|down) /) && has(s, / (spend|spent|spending|cut|reduce|reduced|less on) /)) {
    if (!amount) return unsupported(howMuch);
    if (said.food) return unsupported(FOOD_CLARIFY);
    const category = said.categories.length === 1 ? said.categories[0] : undefined;
    if (said.categories.length > 1) return unsupported("Which category? I can work out one at a time.");
    return what(
      category ? { kind: "spend_less", amount: amount.pence, category } : { kind: "spend_less", amount: amount.pence },
      `What if: spend ${money(amount.pence)} less${category ? ` on ${category.toLowerCase()}` : ""} next month`,
    );
  }
  return unsupported("I can work out three kinds of what-if: spending less, saving an amount by a month, or paying a set amount off your card each month.");
}

/** The two months a comparison shows, newest first, using only months that have data. */
function comparisonMonths(months: MonthKey[], env: PlanEnv): [MonthKey, MonthKey] | null {
  const ok = [...new Set(months)].filter((k) => available(k, env)).sort().reverse();
  if (ok.length >= 2) return [ok[0], ok[1]];
  const m = ok[0] ?? current(env);
  if (available(addMonths(m, -1), env)) return [m, addMonths(m, -1)];
  const next = addMonths(m, 1);
  return next <= current(env) && available(next, env) ? [next, m] : null;
}

function categoriesFor(said: Said): SpendCategory[] {
  return [...new Set([...(said.food ? FOOD_PAIR : []), ...said.categories])].slice(0, 3);
}

/** Questions and requests answered with a chart built on the device from verified data. */
function visualsTurn(said: Said, env: PlanEnv): Turn | null {
  const { s } = said;
  if (has(s, JUDGEMENT) || said.merchants.length || said.otherBusiness) return null;
  const cats = categoriesFor(said);
  const kindWanted =
    has(s, BREAKDOWN) ||
    has(s, BIGGEST) ||
    (has(s, BUDGET) && has(s, BUDGET_LEFT)) ||
    // "Have my subscriptions gone up?" is about prices, which the backend checks charge by charge.
    (has(s, COMPARE) && (has(s, SPEND) || said.months.length + said.unavailable.length >= 2 || has(s, / compare /) || (cats.length > 0 && !cats.includes("Subscriptions")))) ||
    (has(s, TREND) && (has(s, SPEND) || cats.length > 0)) ||
    (cats.length > 0 && (has(s, SPEND) || has(s, / (how much|total|show|see|view) /))) ||
    has(s, TOTAL);
  if (!kindWanted) return null;
  if (said.unavailable.length && !said.months.length) return unsupported(`I only have spending from ${rangeLabel(env)}.`, "Months without data");

  const months = said.months.length ? [...said.months].sort() : undefined;
  const food = said.food ? { understood: `Food (groceries and eating out)${monthsPhrase(months, env)}` } : {};
  const withCat = (r: VisualRequest, c?: SpendCategory): VisualRequest => (c ? { ...r, category: c } : r);
  const each = (r: VisualRequest) => (cats.length ? cats.map((c) => withCat(r, c)) : [r]);

  if (has(s, BREAKDOWN)) return visualTurn([months ? { kind: "category_breakdown", months } : { kind: "category_breakdown" }], env);
  const biggest = s.match(BIGGEST);
  if (biggest) {
    const count = biggest[1];
    const n = count ? Number(count) || COUNT[count] : undefined;
    // "my biggest purchases" is a short list; "the biggest expense" is one.
    const plural = /s$|^things/.test(biggest[2]);
    const limit = Math.min(Math.max(n ?? (plural ? 5 : 1), 1), 10);
    const r: VisualRequest = { kind: "biggest_purchases", limit };
    if (cats.length === 1) r.category = cats[0];
    if (months) r.months = months;
    return visualTurn([r], env);
  }
  if (has(s, BUDGET) && has(s, BUDGET_LEFT)) return visualTurn([{ kind: "budget_progress" }], env);
  if (has(s, COMPARE) && (said.span || (months?.length ?? 0) >= 3)) return visualTurn(each({ kind: "monthly_trend", ...(months ? { months } : {}) }), env, food);
  if (has(s, COMPARE)) {
    const pair = comparisonMonths(months ?? [current(env)], env);
    if (!pair) return unsupported(`I only have spending from ${rangeLabel(env)}, so there's nothing to compare that with.`, "Nothing to compare");
    return visualTurn(each({ kind: "month_comparison", months: pair }), env, food);
  }
  if (has(s, TREND) && !(months?.length === 1)) {
    if (cats.length) return visualTurn(cats.map((c) => ({ kind: "category_trend", category: c, ...(months ? { months } : {}) })), env, food);
    return visualTurn([{ kind: "monthly_trend", ...(months ? { months } : {}) }], env);
  }
  if (cats.length) {
    const requests = cats.map((c): VisualRequest => ({ kind: "category_trend", category: c, months: months ?? [current(env)] }));
    if (!has(s, SHOW)) return visualTurn(requests, env, food);
    // "Show my groceries spending for October": the filtered list and the chart.
    const filters: SpendingFilters = {};
    if (cats.length === 1) filters.category = cats[0];
    if (months?.length === 1) filters.month = months[0];
    const list = navTurn("/account/spending", { filters, say: said.food ? FOOD_SAY : undefined }, env);
    return visualTurn(requests, env, { understood: `${list.understood}, with a chart` }, list.steps);
  }
  if (has(s, TOTAL)) return visualTurn([months ? { kind: "category_breakdown", months } : { kind: "category_breakdown" }], env);
  return null;
}

/** A follow-up visual: the last one, with the category or months the person just changed. */
function adapt(v: VisualRequest, said: Said, env: PlanEnv): VisualRequest[] {
  const cats = categoriesFor(said);
  const base: VisualRequest = { ...v };
  if (said.months.length) {
    const months = [...said.months].sort();
    if (base.kind === "month_comparison") {
      const pair = comparisonMonths(months, env);
      if (pair) base.months = pair;
      else {
        base.kind = "category_trend";
        base.months = months;
      }
    } else if (base.kind === "monthly_trend" && months.length === 1) {
      base.kind = base.category ? "category_trend" : "category_breakdown";
      base.months = months;
    } else base.months = months;
  }
  if (cats.length && (base.kind === "category_breakdown" || base.kind === "budget_progress")) base.kind = "category_trend";
  const out = cats.length ? cats.map((c) => ({ ...base, category: c })) : [base];
  return out.map((r) => (r.kind === "category_trend" && !r.months ? { ...r, months: v.months ?? [current(env)] } : r));
}

/** A part that is only names: a category, shop, month, amount or page, with nothing asked. */
interface Fragment {
  categories: CategoryMatch[];
  merchants: MerchantMatch[];
  months: MonthMatch[];
  amount: AmountMatch | null;
  route: { start: number; end: number; text: string; to: DialRoute } | null;
}

const FILLER = new Set(
  "the my on in for at of to and or just only specifically instead please i mean meant it's its it was is sorry no um uh er erm oh then also with this that one page screen section tab spend spent spending transactions purchases what how about same again too as well actually wait".split(" "),
);

function fragment(text: string, env: PlanEnv): Fragment | null {
  const lower = lowerSame(text);
  const categories = findCategories(text);
  const merchants = findMerchants(text, env.merchants).matches;
  const months = findMonthMatches(text, env.today, "past");
  const amount = findAmount(text);
  let route: Fragment["route"] = null;
  for (const [re, to] of ROUTE_WORDS) {
    const m = lower.match(re);
    if (m && m.index !== undefined && !route) route = { start: m.index, end: m.index + m[0].length, text: text.slice(m.index, m.index + m[0].length), to };
  }
  const slots = [...categories, ...merchants, ...months, ...(amount ? [amount] : [])];
  // A page name only counts as the slot when nothing else was named ("spending", not "groceries spending").
  const spansUsed = slots.length ? slots : route ? [route] : [];
  if (!spansUsed.length) return null;
  let rest = lower;
  for (const sp of spansUsed) rest = rest.slice(0, sp.start) + " ".repeat(sp.end - sp.start) + rest.slice(sp.end);
  // "Change that to Tesco" is a correction, but "change my budget" is a request, so "change" alone isn't filler.
  const words = rest.replace(/\bchange (?:that|it) to\b/, " ").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.every((w) => FILLER.has(w))) return null;
  return { categories, merchants, months, amount, route: slots.length ? null : route };
}

const isFragment = (text: string, env: PlanEnv) => fragment(text, env) !== null;

/** "Explain that again": the same thing once more. */
const AGAIN = / (explain|say|show|show me|tell me|go over|go through|repeat) (that|it|this) (to me )?(again|once more|one more time) /;
const BIGGEST_ONE = / (biggest|largest|most expensive|highest|priciest|top) one /;

/** "what about X", "and X", "X instead": the shapes a follow-up takes. */
const ELLIPSIS = /^ (?:(?:and|so|ok|okay|right|now|but) )?(?:what|how) about .+ $|^ and .+ $|^ (?:the )?same (?:for|with) .+ $|^ .+ instead $|^ (?:now |then )?(?:for|in) .+ $/;
const LIST =
  / (show (it|that|this|them|those|these)( to me)?( as a list| in a list| as transactions)?|show me instead|as a list|in a list|list (it|them|those|that|these)|(show|see|open|view) (me )?(those|these|the) (transactions|purchases)|those transactions|these transactions|which transactions|what were they|which ones were they) /;

function filtersFromContext(ctx: DialContext): SpendingFilters {
  const v = ctx.lastVisual;
  const f: SpendingFilters = {};
  const category = v?.category ?? ctx.subject.category;
  const months = v?.months ?? ctx.subject.months;
  if (category) f.category = category;
  else if (ctx.subject.merchant) f.merchant = ctx.subject.merchant;
  if (months?.length === 1 || v?.kind === "month_comparison") f.month = months?.[0];
  if (!f.month) delete f.month;
  if (v?.kind === "biggest_purchases") f.sort = "highest";
  return f;
}

/** "Why is that higher?" made explicit from what was on screen, or null when there is nothing definite to name. */
function whyQuestion(said: Said, ctx: DialContext, env: PlanEnv): string | null {
  const v = ctx.lastVisual;
  const category = v?.category ?? ctx.subject.category;
  const months = v?.months ?? ctx.subject.months;
  if (!v && !category) return null;
  if (v && (v.kind === "biggest_purchases" || v.kind === "budget_progress")) return null;
  if (v && v.kind === "category_breakdown" && !category) return null;
  if (v?.kind === "monthly_trend" && !category && !(months && months.length >= 2)) return null;

  let pair: [MonthKey, MonthKey] | null = null;
  if (v?.kind === "month_comparison") pair = (v.months as [MonthKey, MonthKey] | undefined) ?? comparisonMonths([current(env)], env);
  else if (months && months.length >= 2) {
    const sorted = [...months].sort().reverse();
    pair = [sorted[0], sorted[1]];
  } else {
    // One month: compare it with the month before, and only if that month has data. Never a month nobody saw.
    const m = months?.[0] ?? current(env);
    pair = available(addMonths(m, -1), env) ? [m, addMonths(m, -1)] : null;
  }

  const dir = has(said.s, / (higher|up|more|increase|increased|bigger|so much|so high|rise|rose|grown|grew) /)
    ? "higher"
    : has(said.s, / (lower|down|less|decrease|decreased|dropped|drop|fell|smaller|so low) /)
      ? "lower"
      : null;
  const what = `${category ? `${category} ` : ""}spending`;
  if (!pair) return dir ? `Why ${months?.[0] === current(env) || !months ? "is" : "was"} my ${what} so ${dir === "higher" ? "high" : "low"}${monthsPhrase(months, env)}?` : null;
  const [a, b] = pair.map((k) => monthName(k, env.today));
  if (!dir) return `Why did my ${what} change from ${b} to ${a}?`;
  return `Why ${pair[0] === current(env) ? "is" : "was"} my ${what} ${dir} in ${a} than ${b}?`;
}

function followUpTurn(said: Said, env: PlanEnv): Turn | null {
  const ctx = env.context;
  const { s } = said;
  const v = ctx.lastVisual;

  if (v && has(s, AGAIN)) return { ...visualTurn([v], env), followUp: true };
  if (has(s, BIGGEST_ONE)) {
    const category = v?.category ?? ctx.subject.category;
    const months = v?.months ?? ctx.subject.months;
    // This chart can't filter by shop and shows one month, so a shop goes to the backend, and several months mean the latest.
    if (!ctx.subject.merchant && (v || category || months)) {
      const month = months && [...months].sort().at(-1);
      return { ...visualTurn([{ kind: "biggest_purchases", limit: 1, ...(category ? { category } : {}), ...(month ? { months: [month] } : {}) }], env), followUp: true };
    }
    if (ctx.lastQuestion) return { ...ask(said.text, ctx), followUp: true };
  }
  if (has(s, LIST)) {
    if (!v && !ctx.subject.category && !ctx.subject.merchant && !ctx.subject.months) return null;
    return { ...navTurn("/account/spending", { filters: filtersFromContext(ctx) }, env), followUp: true };
  }
  if (has(s, /^ (?:but |and |so |ok |okay )?why /)) {
    const own = said.categories.length || said.food || said.merchants.length || said.months.length;
    const explicit = own ? null : whyQuestion(said, ctx, env);
    return { ...ask(explicit ?? said.text, ctx), followUp: true };
  }
  if (v && has(s, ANAPHORA) && has(s, COMPARE) && !said.categories.length && !said.merchants.length && !has(s, / (why|should|normal|ok|okay) /)) {
    const base = v.months?.[0] ?? current(env);
    const pair = comparisonMonths(said.months.length ? [base, said.months[0]] : [base], env);
    if (pair) return { ...visualTurn([{ kind: "month_comparison", months: pair, ...(v.category ? { category: v.category } : {}) }], env), followUp: true };
  }

  const elliptical = has(s, ELLIPSIS) || isFragment(said.text, env);
  const frag = fragment(said.text, env);
  if (!elliptical || !frag || frag.route || frag.amount) return null;
  // After an answer from the backend, it resolves the follow-up against its own full question.
  if (!v && ctx.lastQuestion) return { ...ask(said.text, ctx), followUp: true };
  if (frag.merchants.length) {
    if (v || ctx.subject.months) {
      const months = said.months.length ? said.months : (v?.months ?? ctx.subject.months);
      return { ...ask(`How much did I spend at ${said.merchants[0]}${monthsPhrase(months, env, "")}?`, ctx), followUp: true };
    }
    return { ...navTurn("/account/spending", { filters: { merchant: said.merchants[0] } }, env), followUp: true };
  }
  if (v) return { ...visualTurn(adapt(v, said, env), env), followUp: true };
  // No context: the fragment on its own, as a fresh request.
  const cats = categoriesFor(said);
  const months = said.months.length ? [...said.months].sort() : undefined;
  if (said.unavailable.length && !said.months.length) return unsupported(`I only have spending from ${rangeLabel(env)}.`, "Months without data");
  // "How much on food in October", then "actually, groceries": two charts leave no last visual, but the month stands.
  if (cats.length) return visualTurn(cats.map((c) => ({ kind: "category_trend", category: c, months: months ?? ctx.subject.months ?? [current(env)] })), env);
  if (months) return visualTurn([{ kind: "category_breakdown", months }], env);
  return null;
}

/** Navigation by plain words. `strong` is "take me to", "open", "go to"; otherwise "show me", "where is", or just a name. */
function placeTurn(said: Said, env: PlanEnvWithTransactions, strong: boolean): Turn | null {
  const { s } = said;
  const words = s.trim().split(" ").length;
  const weak = has(s, WEAK_NAV);
  const bare = words <= 5 && isBarePlace(s);
  const noticed = has(s, DIAL_NOTICED);
  if (!strong && !weak && !bare && !noticed && !has(s, / (transaction|transactions|purchase|purchases|charges|orders) /)) return null;
  if (noticed) return navTurn("/account", { focus: "insights" }, env);

  const ref = findTransactionRef(said.text, env);
  if (ref?.kind === "id") return navTurn("/account/spending", { filters: { txn: ref.id } }, env);
  if (ref?.kind === "unknown") return unsupported(`I can't find transaction ${ref.id}. Try saying the shop's name instead.`, "Transaction not found");
  if (ref?.kind === "merchant") return navTurn("/account/spending", { filters: ref.id ? { txn: ref.id } : { merchant: ref.merchant } }, env);

  const listWords = has(s, / (transactions?|purchases?|spending|charges|orders|payments) /);
  if (said.otherBusiness && !said.merchants.length && (listWords || strong || weak))
    return unsupported(`I can't see any ${said.otherBusiness} transactions. I can only show shops that appear in your account.`, "Shop not found");
  const month = said.months.length === 1 ? said.months[0] : undefined;
  if (said.merchants.length === 1 && (strong || weak || listWords)) {
    const filters: SpendingFilters = { merchant: said.merchants[0] };
    if (month) filters.month = month;
    return navTurn("/account/spending", { filters }, env);
  }
  const unknownShop = s.match(/ (?:my|the|all my|all the|any) ([a-z][a-z']+) (?:transactions|purchases|charges|orders) /)?.[1];
  if (unknownShop && !said.categories.length && !said.food && !said.merchants.length && !KNOWN_LIST_WORDS.has(unknownShop))
    return unsupported(`I can't find any ${unknownShop.charAt(0).toUpperCase() + unknownShop.slice(1)} transactions. I can only show shops that appear in your account.`, "Shop not found");

  const place = findPlace(s);
  if (!place) {
    if ((strong || weak) && (said.categories.length || said.food || said.months.length) && !said.question) {
      return spendingTurn(said, env);
    }
    return null;
  }
  if (place.to === "/account/spending") return spendingTurn(said, env);
  return navTurn(place.to, { focus: place.focus, say: place.say }, env);
}

const KNOWN_LIST_WORDS = new Set(["recent", "latest", "last", "biggest", "largest", "card", "other", "pending", "past", "previous", "monthly", "new", "old", "own", "online", "refunded", "november", "october", "september"]);

const BARE_FILLER = ["my", "the", "our", "please", "page", "screen", "section", "tab", "information", "info", "details", "dial", "now"];
/** Every word used in a place name, so "my credit limit" or "accessibility preferences" reads as just a name. */
const PLACE_WORDS = new Set([...BARE_FILLER, ...PLACES.flatMap((p) => p.re.source.match(/[a-z']+/g) ?? [])]);

/** Just the name of a place ("credit information", "my savings goal", "budgets"), with nothing else asked. */
function isBarePlace(s: string): boolean {
  return findPlace(s) !== null && s.trim().split(" ").every((w) => PLACE_WORDS.has(w) || findPlace(` ${w} `) !== null);
}

/** Open Spending with whatever the person named, plus the chart when they named a category. */
function spendingTurn(said: Said, env: PlanEnv): Turn {
  const filters: SpendingFilters = {};
  if (said.categories.length === 1 && !said.food) filters.category = said.categories[0];
  if (said.months.length === 1) filters.month = said.months[0];
  if (has(said.s, / (biggest|largest|most expensive|highest) /)) filters.sort = "highest";
  const nav = navTurn("/account/spending", { filters, say: said.food ? FOOD_SAY : undefined }, env);
  const cats = categoriesFor(said);
  if (!cats.length || filters.sort) return nav;
  const months = said.months.length ? [...said.months].sort() : [current(env)];
  const requests = cats.map((c): VisualRequest => ({ kind: "category_trend", category: c, months }));
  return { ...visualTurn(requests, env, {}, nav.steps), understood: `${nav.understood}, with a chart` };
}

/** One instruction, rules first. Every rule is local except the last resort, which asks the backend. */
function classify(text: string, env: PlanEnvWithTransactions): Turn {
  const ctx = env.context;
  const said = read(text, env);
  const { s } = said;
  if (!s.trim()) return unsupported("I didn't catch that. Please try again.", "Nothing heard");
  const ir = interpret(text, { textSize: env.textSize });
  const moneyQuestion = said.question && (has(s, MONEY) || said.text.includes("£"));

  // "Wait." and "Cancel." stop Dial, as they do while it is speaking. With a preview showing, "cancel" means no to it.
  if (isStopWord(text) && !(ctx.pending && ir.kind === "control" && ir.command === "no")) return { steps: [{ type: "control", command: "stop" }], understood: CONTROL_LABEL.stop, keepSubject: true };
  if (ir.kind === "control") {
    if ((ir.command === "yes" || ir.command === "no") && !ctx.pending) return unsupported("There's nothing waiting for a yes or no right now.", CONTROL_LABEL[ir.command]);
    return { steps: [{ type: "control", command: ir.command }], understood: CONTROL_LABEL[ir.command], keepSubject: true };
  }
  if (ir.kind === "navigate" && ir.to === "back") return { steps: [{ type: "back" }], understood: "Go back", keepSubject: true };
  if (ir.kind === "mode") return modeTurn(ir.mode);
  const display = displayTurn(said, ir, ctx);
  if (display) return display;

  const strong = has(s, STRONG_NAV);
  if (strong) {
    const nav = placeTurn(said, env, true);
    if (nav) return nav;
  }
  const goal = goalTurn(said, env);
  if (goal) return goal;
  const whatIf = whatIfTurn(said, env);
  if (whatIf) return whatIf;
  // Dial never pays: "pay my bill" opens Pay, where the person chooses and confirms.
  if (has(s, PAY_INTENT)) return navTurn("/account/pay", { say: PAY_NOTE }, env);
  // The budget lives in Spend Pause, and only the person changes it there.
  if (has(s, BUDGET_CHANGE)) return navTurn("/account/spend-pause", { say: "Your monthly budget is set in Spend Pause. You can change it here." }, env);

  // "Hide Spend Pause on the home screen" is about the layout; "Turn off Spend Pause" is about Spend Pause itself.
  if (ir.kind === "ui" && has(s, LAYOUT) && !moneyQuestion) return prefsTurn(ir.actions);
  const local = env.localReply?.(text);
  if (local?.text) {
    const step: DialStep = local.link ? { type: "local", text: local.text, link: local.link } : { type: "local", text: local.text };
    return { steps: [validateStep(step) ?? { type: "local", text: local.text }], understood: "Answered from your account" };
  }

  // Layout and display changes, unless it's really a money question or a ranking ("my top 3 purchases").
  if (ir.kind === "ui" && ir.actions.some((a) => a.type !== "show") && !moneyQuestion && !has(s, BIGGEST)) return prefsTurn(ir.actions);

  const follow = followUpTurn(said, env);
  if (follow) return follow;
  const visual = visualsTurn(said, env);
  if (visual) return visual;
  const nav = placeTurn(said, env, false);
  if (nav) return nav;

  if (ir.kind === "navigate") return navTurn(ir.to as DialRoute, {}, env);
  if (ir.kind === "ui") return prefsTurn(ir.actions);
  if (strong && !has(s, /^ (?:[a-z]+ )*?switch to /)) return unsupported(`I can't open that. ${OPENABLE}`, "Can't open that");
  if (said.question || has(s, MONEY) || said.text.includes("£") || said.merchants.length) return ask(text, ctx);
  return unsupported(NOT_UNDERSTOOD, "Not understood");
}

// ─── Self-correction ────────────────────────────────────────────────────────────────────────────────────────────

const splice = (text: string, span: { start: number; end: number }, insert: string) => text.slice(0, span.start) + insert + text.slice(span.end);

function append(text: string, words: string): string {
  const m = text.match(/^([\s\S]*?)([.?!]*)\s*$/)!;
  return `${m[1]} ${words}${m[2]}`;
}

/**
 * Merges a correction into what it corrects. A fragment ("groceries", "September", "Tesco", "spending") replaces
 * the slot of the same kind in `before`; anything else is a whole new request and replaces `before` entirely.
 */
function merge(before: string, after: string, env: PlanEnv): string {
  const a = after.trim().replace(/[.?!,]+$/, "");
  const frag = fragment(a, env);
  if (!frag) return after.trim();
  let out = before;
  const phrase = (sp: { start: number; end: number }) => a.slice(sp.start, sp.end);

  if (frag.route) {
    const m = ROUTE_WORDS.map(([re]) => out.match(re)).find((x) => x && x.index !== undefined);
    return m && m.index !== undefined ? splice(out, { start: m.index, end: m.index + m[0].length }, phrase(frag.route)) : after.trim();
  }
  const what = frag.categories[0] ?? frag.merchants[0];
  if (what) {
    const inBefore = [...findCategories(out), ...findMerchants(out, env.merchants).matches].sort((x, y) => y.start - x.start)[0];
    out = inBefore ? splice(out, inBefore, phrase(what)) : append(out, `${"merchant" in what ? "at" : "on"} ${phrase(what)}`);
  }
  if (frag.months[0]) {
    const inBefore = findMonthMatches(out, env.today, "past").at(-1);
    out = inBefore ? splice(out, inBefore, phrase(frag.months[0])) : append(out, `${frag.months[0].kind === "name" || frag.months[0].kind === "range" ? "in " : ""}${phrase(frag.months[0])}`);
  }
  if (frag.amount) {
    const inBefore = findAmount(out, { loose: true });
    out = inBefore ? splice(out, inBefore, phrase(frag.amount)) : after.trim();
  }
  return out;
}

/** Applies every correction, earliest first, so "A, actually B, no I mean C" ends as C merged into B merged into A. */
function resolveCorrections(text: string, env: PlanEnv): string {
  const split = splitCorrection(text);
  return split ? merge(resolveCorrections(split.before, env), split.after, env) : text;
}

function corrected(input: { text: string; replaces?: string }, env: PlanEnv): string {
  if (input.replaces?.trim()) return merge(resolveCorrections(input.replaces, env), resolveCorrections(input.text, env), env);
  return resolveCorrections(input.text, env);
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────────────────────

function advance(ctx: DialContext, turn: Turn, said: Said): DialContext {
  const steps = turn.steps;
  const visuals = steps.filter((st): st is Extract<DialStep, { type: "visual" }> => st.type === "visual");
  // Two charts at once (food: groceries and eating out) leave no single thing for "that" to mean.
  const visual = new Set(visuals.map((v) => v.request.category ?? "")).size === 1 ? visuals[0] : undefined;
  const cleared = visuals.length > 0 && !visual;
  const nav = [...steps].reverse().find((st): st is Extract<DialStep, { type: "navigate" }> => st.type === "navigate");
  return {
    ...ctx,
    subject: turn.keepSubject ? ctx.subject : said.food && !turn.followUp ? subjectOf(said) : nextSubject(ctx.subject, subjectOf(said), !!turn.followUp),
    // An asked question moves the conversation on from the last chart, so "that" now means the answer, not the chart.
    lastVisual: visual ? visual.request : cleared || steps.some((st) => st.type === "ask") ? null : ctx.lastVisual,
    route: nav ? nav.to : ctx.route,
  };
}

function standalone(part: string, env: PlanEnvWithTransactions): boolean {
  if (isFragment(part, env)) return false;
  const t = classify(part, env);
  return t.steps.length > 0 && t.steps.every((st) => st.type !== "unsupported");
}

const actionKey = (a: UiAction) => `${a.type}${"widget" in a ? `:${a.widget}` : ""}`;

/** Plans one utterance. Pure: the same text and environment always give the same plan. */
export function plan(input: { text: string; replaces?: string }, env: PlanEnvWithTransactions): DialPlan {
  const text = corrected(input, env).replace(/\s+/g, " ").trim().slice(0, 600);
  const blank: PlanEnvWithTransactions = { ...env, context: { ...env.context, subject: {}, lastVisual: null, lastQuestion: null } };
  const parts = segment(text, (p) => standalone(p, blank));
  if (!parts.length) {
    const t = unsupported("I didn't catch that. Please try again.", "Nothing heard");
    return { steps: t.steps, context: env.context, understood: t.understood, local: true };
  }

  let ctx = env.context;
  const turns: { part: string; turn: Turn; said: Said }[] = [];
  for (const part of parts) {
    const turn = classify(part, { ...env, context: ctx });
    const said = read(part, env);
    const prev = turns.at(-1);
    // "Make everything bigger. Use more contrast." is one preview, not two.
    if (prev && prev.turn.steps.length === 1 && prev.turn.steps[0].type === "preferences" && turn.steps.length === 1 && turn.steps[0].type === "preferences") {
      const merged = new Map(prev.turn.steps[0].actions.map((a) => [actionKey(a), a]));
      for (const a of turn.steps[0].actions) merged.set(actionKey(a), a);
      prev.turn = prefsTurn([...merged.values()]);
      continue;
    }
    turns.push({ part, turn, said });
    ctx = advance(ctx, turn, said);
  }

  const total = turns.reduce((n, t) => n + t.turn.steps.length, 0);
  let kept = turns;
  let steps: DialStep[] = turns.flatMap((t) => t.turn.steps);
  if (total > MAX_STEPS) {
    kept = [];
    let n = 0;
    for (const t of turns) {
      if (n + t.turn.steps.length > MAX_STEPS - 1 && kept.length > 0) break;
      kept.push(t);
      n += t.turn.steps.length;
    }
    const left = turns.slice(kept.length).map((t) => `"${t.part.slice(0, 60)}"`);
    steps = kept.flatMap((t) => t.turn.steps).slice(0, MAX_STEPS - 1);
    const say = left.length
      ? `That's a lot at once, so I've done the first ${kept.length === 1 ? "part" : `${kept.length} parts`}. I left out ${left.join(", ")}. Ask me for ${left.length === 1 ? "it" : "those"} next.`
      : "That's a lot at once, so I've done the first part. Ask me for the rest next.";
    steps.push({ type: "unsupported", say: say.slice(0, 500) });
    ctx = kept.reduce((c, t) => advance(c, t.turn, t.said), env.context);
  }

  // Defence in depth: every step is rebuilt by the validator. A rule that produced something invalid is a bug, and
  // the person hears that Dial couldn't do it rather than anything half-formed.
  const safe = steps.map((st) => validateStep(st) ?? ({ type: "unsupported", say: "Sorry, I couldn't do that." } as DialStep));
  return {
    steps: safe,
    context: { ...ctx, pending: env.context.pending, lastQuestion: env.context.lastQuestion, mode: env.context.mode },
    understood: kept.map((t) => t.turn.understood).join(", then ").slice(0, 200),
    local: !safe.some((st) => st.type === "ask"),
  };
}
