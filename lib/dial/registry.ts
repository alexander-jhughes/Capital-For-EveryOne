// What Dial can open, and the gate every step passes before the runner executes it.
// validateStep() rebuilds a step from allowlists only: a route that isn't real, a section that isn't on Home, a
// display setting the preferences schema doesn't know, or a string with markup is rejected, never repaired.
import { sanitize, WIDGETS, type UiAction } from "../preferences/schema";
import type { Mode } from "../types";
import { SPENDING_CATEGORIES, spendingHref } from "./spending-filters";
import {
  DIAL_ROUTES,
  HOME_SECTIONS,
  MONTH_KEY,
  VISUAL_KINDS,
  type ControlCommand,
  type DialRoute,
  type DialStep,
  type GoalSpec,
  type HomeSection,
  type SpendingFilters,
  type VisualRequest,
  type WhatIfScenario,
} from "./types";

export const ROUTE_INFO: Record<DialRoute, { name: string; spoken: string }> = {
  "/account": { name: "Home", spoken: "your home screen" },
  "/account/spending": { name: "Spending", spoken: "your spending" },
  "/account/pay": { name: "Pay", spoken: "payments" },
  "/account/spend-pause": { name: "Spend Pause", spoken: "Spend Pause" },
  "/account/spend-pause/check": { name: "Spend Pause check", spoken: "the Spend Pause check" },
  "/account/settings": { name: "Settings", spoken: "display and voice settings" },
  "/account/personalise": { name: "Personalise", spoken: "personalising the app" },
  "/account/goals": { name: "Goals", spoken: "your goals" },
  "/account/learn": { name: "Learning Lab", spoken: "the Credit Learning Lab" },
  "/account/learn/utilisation": { name: "Credit utilisation", spoken: "the credit utilisation lesson" },
  "/account/learn/minimum-payments": { name: "Minimum payments", spoken: "the minimum payments lesson" },
  "/account/learn/interest": { name: "APR and interest", spoken: "the APR and interest lesson" },
  "/account/learn/statement": { name: "Your statement, explained", spoken: "the statement lesson" },
  "/account/learn/quiz": { name: "Credit quiz", spoken: "the credit quiz" },
  "/account/more": { name: "More", spoken: "everything else in the app" },
};

export const SECTION_INFO: Record<HomeSection, { name: string; spoken: string }> = {
  bill: { name: "Bill", spoken: "your bill and next payment" },
  balance: { name: "Balance and credit", spoken: "your balance and credit" },
  insights: { name: "Dial noticed", spoken: "what Dial has noticed" },
  budget: { name: "Spending this month", spoken: "your spending this month" },
  categories: { name: "Spending by category", spoken: "your spending by category" },
  upcoming: { name: "Coming up", spoken: "what's coming up before your bill" },
  chart: { name: "Daily spending chart", spoken: "your daily spending chart" },
  recent: { name: "Recent transactions", spoken: "your recent transactions" },
  progress: { name: "Your progress", spoken: "your progress on your goals" },
  pause: { name: "Spend Pause", spoken: "Spend Pause" },
};

/** Said when someone asks for a place that doesn't exist. Lists only real screens. */
export const OPENABLE =
  "I can open Home, Spending, Pay, Spend Pause, Goals, the Learning Lab, Settings, Personalise and More, or show your bill, balance and credit, budget, spending categories, what's coming up, your progress or what Dial has noticed on Home.";

export interface Place {
  /** Matched against the normalised text (lower case, padded with spaces). */
  re: RegExp;
  to: DialRoute;
  focus?: HomeSection;
  say?: string;
}

const BUDGET_NOTE = "Your monthly budget is set in Spend Pause.";
/** Dial can't see a credit score and the app never shows one, so a request for one opens the lessons that exist. */
export const CREDIT_SCORE_NOTE =
  "I can't see your credit score, and the Learning Lab doesn't cover scores. It explains credit utilisation, minimum payments, APR and interest, and your statement.";
export const LEARN_NOTE = "The Learning Lab explains credit utilisation, minimum payments, APR and interest, and your statement, and has a short quiz.";
export const PAY_NOTE = "Dial never makes a payment for you. Choose the amount and confirm it here.";

/**
 * Home sections that share words with other places ("upcoming payments" isn't Pay, "spending categories" isn't the
 * category chart). Matched first, and only when the request is just the section's name: see sectionTurn in plan.ts.
 */
export const SECTION_PLACES: Place[] = [
  { re: / (upcoming (payments?|bills?|charges|costs)|payments? coming up|what('s| is| are)? coming up|coming up|due soon|due before (my|the) bill|before (my|the) (next )?bill) /, to: "/account", focus: "upcoming" },
  { re: / (my progress|progress|goals? progress|progress (on|with|towards?) (my )?goals?) /, to: "/account", focus: "progress" },
  { re: / (spending categories|my categories|the categories|categories section|category section|spending by category) /, to: "/account", focus: "categories" },
];

/**
 * Everyday names for every place Dial can open, most specific first: "pay my bill" is Pay, "my bill" is the bill on
 * Home, "next payment" is the bill too, and "payments" is Pay. Only routes in DIAL_ROUTES appear here.
 */
export const PLACES: Place[] = [
  ...SECTION_PLACES,
  { re: / (set|change|edit|update|adjust|raise|lower) (my |the )?(monthly )?budget /, to: "/account/spend-pause", say: BUDGET_NOTE },
  { re: / (spend pause|pause page|pause settings) /, to: "/account/spend-pause" },
  { re: / (personali[sz]e|personali[sz]ation|personali[sz]ing|make it (mine|yours|my own)|make the app (mine|my own)) /, to: "/account/personalise" },
  { re: / (settings|preferences|accessibility|display and voice|display options|voice options|voice and display) /, to: "/account/settings" },
  { re: / (goals?|savings goals?|saving goals?) /, to: "/account/goals" },
  { re: / (credit scores?|credit ratings?|credit reports?|credit files?) /, to: "/account/learn", say: CREDIT_SCORE_NOTE },
  { re: / (credit quiz|quiz|test my knowledge) /, to: "/account/learn/quiz" },
  { re: / (learning lab|learn lab|credit learning lab|learning centre|learning center|lessons|learning) /, to: "/account/learn" },
  { re: / (more features|more options|more screens|more pages|more page|more menu|the more page|everything else|other features|all features|all the features) /, to: "/account/more" },
  { re: / (pay (my |the |off (my |the )?)?(bill|card|balance|statement)|make a payment|pay page|pay screen|payment page|payments page|payment screen) /, to: "/account/pay", say: PAY_NOTE },
  { re: / (credit (information|info|limit|details|available)|available credit|my credit|how much credit|my balance|the balance|balance|credit) /, to: "/account", focus: "balance" },
  { re: / (budgets?) /, to: "/account", focus: "budget", say: BUDGET_NOTE },
  { re: / (financial insights|insights?|dial noticed|has dial noticed|dial has noticed|alerts?|things to check) /, to: "/account", focus: "insights" },
  { re: / (my bill|the bill|bill|next payment|due date|statement) /, to: "/account", focus: "bill" },
  { re: / (payments?|pay|paying) /, to: "/account/pay", say: PAY_NOTE },
  { re: / (spending chart|daily spending chart|daily chart|chart|graph) /, to: "/account", focus: "chart" },
  { re: / (spending|transactions?|purchases?|activity|statement lines|what i (bought|spent)|expenses?) /, to: "/account/spending" },
  { re: / (home|home page|home screen|dashboard|main page|main screen|start|overview|my account) /, to: "/account" },
];

/** Short names for each route, so a correction ("Take me to pay, no wait, spending") can swap one for another. */
export const ROUTE_WORDS: [RegExp, DialRoute][] = [
  [/\b(?:spend pause)\b/i, "/account/spend-pause"],
  [/\b(?:spending|transactions)\b/i, "/account/spending"],
  [/\b(?:payments?|pay)\b/i, "/account/pay"],
  [/\b(?:settings|preferences)\b/i, "/account/settings"],
  [/\b(?:personali[sz]e)\b/i, "/account/personalise"],
  [/\b(?:goals?)\b/i, "/account/goals"],
  [/\b(?:learning lab|learning|lessons)\b/i, "/account/learn"],
  [/\b(?:more features|more page)\b/i, "/account/more"],
  [/\b(?:home|dashboard|home screen)\b/i, "/account"],
];

/**
 * Learning Lab topics, matched only when the person is asking to learn ("teach me about", "lesson", "explain how"),
 * so "show me my statement" still opens the bill and "what's my APR" is still a question about the account.
 */
export const LEARN_CUE = / (teach me|learn about|learn more about|i want to learn|learning lab|lesson|lessons|explainer|explainers|tutorial|course|how does (a |an |my |the )?[a-z ]{0,25}work|quiz) /;
export const LEARN_TOPICS: { re: RegExp; to: DialRoute; say?: string }[] = [
  { re: / (credit scores?|credit ratings?|credit reports?|credit files?) /, to: "/account/learn", say: CREDIT_SCORE_NOTE },
  { re: / (quiz|test my knowledge) /, to: "/account/learn/quiz" },
  { re: / (credit utili[sz]ation|utili[sz]ation|how much of (my|the|your) limit) /, to: "/account/learn/utilisation" },
  { re: / (minimum payments?|minimum repayments?|paying (only |just )?the minimum) /, to: "/account/learn/minimum-payments" },
  { re: / (apr|interest rates?|interest) /, to: "/account/learn/interest" },
  { re: / (statements?) /, to: "/account/learn/statement" },
];

export function findPlace(normalised: string): Place | null {
  return PLACES.find((p) => p.re.test(normalised)) ?? null;
}

// ─── Validation ─────────────────────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
/** Only these keys, and each one either absent, undefined or present in `required`. */
function keysOk(o: Obj, allowed: string[], required: string[] = []) {
  return Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => o[k] !== undefined);
}
const oneOf = <T>(v: unknown, list: readonly T[]): v is T => list.includes(v as T);
const ID = /^[a-z0-9-]{1,40}$/i;
const MERCHANT = /^[A-Za-z0-9 '&.-]{1,40}$/;
/** Plain text only: no markup, braces or control characters. */
const PLAIN = /^[^<>{}\u0000-\u001f\u007f]+$/;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && PLAIN.test(v);
export const validAmount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 10_000_000;
const month = (v: unknown): v is string => typeof v === "string" && MONTH_KEY.test(v);
const SORTS = ["newest", "oldest", "highest", "lowest", "shop"] as const;
const CONTROLS: ControlCommand[] = ["yes", "no", "stop", "undo", "reset", "exit", "help", "readPage", "readBalance", "save"];
const MODES: Mode[] = ["simple", "complex"];

/** Copies only the defined keys, so a rebuilt step never carries `key: undefined`. */
function defined<T extends Obj>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function filters(x: unknown): SpendingFilters | null {
  if (!isObj(x) || !keysOk(x, ["category", "month", "merchant", "txn", "sort", "highlight"])) return null;
  const { category, month: m, merchant, txn, sort, highlight } = x;
  if (category !== undefined && !oneOf(category, SPENDING_CATEGORIES)) return null;
  if (m !== undefined && !month(m)) return null;
  if (merchant !== undefined && !(typeof merchant === "string" && MERCHANT.test(merchant))) return null;
  if (txn !== undefined && !(typeof txn === "string" && ID.test(txn))) return null;
  if (sort !== undefined && !oneOf(sort, SORTS)) return null;
  if (highlight !== undefined && !(Array.isArray(highlight) && highlight.length > 0 && highlight.length <= 50 && highlight.every((h) => typeof h === "string" && ID.test(h)))) return null;
  return defined({ category, month: m, merchant, txn, sort, highlight: highlight ? [...(highlight as string[])] : undefined }) as SpendingFilters;
}

const SCALAR_ACTIONS = ["textSize", "contrast", "spacing", "motion", "theme", "targets", "explanations", "voiceFirst", "onboarding", "answerStyle", "listenMode", "speechInput"] as const;

/** One display action, checked against the preferences schema's own allowlists (sanitize keeps only allowed values). */
function uiAction(x: unknown): UiAction | null {
  if (!isObj(x) || typeof x.type !== "string") return null;
  const t = x.type;
  if (oneOf(t, SCALAR_ACTIONS)) {
    if (!keysOk(x, ["type", "value"], ["value"])) return null;
    const kept = sanitize({ [t]: x.value }) as unknown as Obj;
    return kept[t] === x.value ? ({ type: t, value: x.value } as UiAction) : null;
  }
  if (t === "density") {
    if (!keysOk(x, ["type", "value"], ["value"])) return null;
    return sanitize({ layout: { density: x.value } }).layout.density === x.value ? { type: "density", value: x.value as "standard" | "calm" } : null;
  }
  if (t === "moveToTop" || t === "emphasize" || t === "show" || t === "hide") {
    if (!keysOk(x, ["type", "widget"], ["widget"]) || !oneOf(x.widget, WIDGETS)) return null;
    return { type: t, widget: x.widget };
  }
  if (t === "clearEmphasis" || t === "reset") return keysOk(x, ["type"]) ? { type: t } : null;
  return null;
}

function visual(x: unknown): VisualRequest | null {
  if (!isObj(x) || !keysOk(x, ["kind", "category", "months", "limit"], ["kind"]) || !oneOf(x.kind, VISUAL_KINDS)) return null;
  const { kind, category, months, limit } = x;
  if (category !== undefined && !oneOf(category, SPENDING_CATEGORIES)) return null;
  if (months !== undefined && !(Array.isArray(months) && months.length >= 1 && months.length <= 12 && months.every(month))) return null;
  if (kind === "month_comparison" && months !== undefined && (months as string[]).length !== 2) return null;
  if (limit !== undefined && !(typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 10)) return null;
  return defined({ kind, category, months: months ? [...(months as string[])] : undefined, limit }) as VisualRequest;
}

function scenario(x: unknown): WhatIfScenario | null {
  if (!isObj(x)) return null;
  switch (x.kind) {
    case "spend_less":
      if (!keysOk(x, ["kind", "amount", "category"], ["amount"]) || !validAmount(x.amount)) return null;
      if (x.category !== undefined && !oneOf(x.category, SPENDING_CATEGORIES)) return null;
      return defined({ kind: "spend_less", amount: x.amount, category: x.category }) as WhatIfScenario;
    case "save_by":
      return keysOk(x, ["kind", "target", "by"], ["target", "by"]) && validAmount(x.target) && month(x.by) ? { kind: "save_by", target: x.target, by: x.by } : null;
    case "pay_monthly":
      return keysOk(x, ["kind", "amount"], ["amount"]) && validAmount(x.amount) ? { kind: "pay_monthly", amount: x.amount } : null;
    default:
      return null;
  }
}

function goalSpec(x: unknown): GoalSpec | null {
  if (!isObj(x)) return null;
  switch (x.kind) {
    case "category_cap":
      return keysOk(x, ["kind", "category", "monthlyLimit"], ["category", "monthlyLimit"]) && oneOf(x.category, SPENDING_CATEGORIES) && validAmount(x.monthlyLimit)
        ? { kind: "category_cap", category: x.category, monthlyLimit: x.monthlyLimit }
        : null;
    case "spend_reduction":
      return keysOk(x, ["kind", "target", "by", "baselineMonth"], ["target", "by", "baselineMonth"]) && validAmount(x.target) && month(x.by) && month(x.baselineMonth)
        ? { kind: "spend_reduction", target: x.target, by: x.by, baselineMonth: x.baselineMonth }
        : null;
    case "stay_in_budget":
      return keysOk(x, ["kind"]) ? { kind: "stay_in_budget" } : null;
    default:
      return null;
  }
}

/** An in-app link: a real route, optionally with a plain query string. Never another origin or a script URL. */
function internalHref(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200 || !/^\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&,_.%-]*)?$/.test(v)) return false;
  return oneOf(v.split("?")[0], DIAL_ROUTES);
}

/**
 * The step, rebuilt from allowlisted parts, or null. Strict: unknown keys, unknown values, out-of-range amounts and
 * strings with markup all fail. The runner executes only what this returns.
 */
export function validateStep(x: unknown): DialStep | null {
  if (!isObj(x) || typeof x.type !== "string") return null;
  switch (x.type) {
    case "navigate": {
      if (!keysOk(x, ["type", "to", "filters", "focus", "say"], ["to"]) || !oneOf(x.to, DIAL_ROUTES)) return null;
      const f = x.filters === undefined ? undefined : filters(x.filters);
      if (f === null) return null;
      // Filters only mean something on Spending, and a section only on Home.
      if (f && x.to !== "/account/spending") return null;
      if (x.focus !== undefined && !(x.to === "/account" && oneOf(x.focus, HOME_SECTIONS))) return null;
      if (x.say !== undefined && !text(x.say, 300)) return null;
      return defined({ type: "navigate", to: x.to, filters: f, focus: x.focus as HomeSection | undefined, say: x.say as string | undefined }) as DialStep;
    }
    case "back":
      return keysOk(x, ["type"]) ? { type: "back" } : null;
    case "setMode":
      return keysOk(x, ["type", "mode"], ["mode"]) && oneOf(x.mode, MODES) ? { type: "setMode", mode: x.mode } : null;
    case "preferences": {
      if (!keysOk(x, ["type", "actions"], ["actions"]) || !Array.isArray(x.actions) || x.actions.length < 1 || x.actions.length > 12) return null;
      const actions = x.actions.map(uiAction);
      return actions.every((a): a is UiAction => a !== null) ? { type: "preferences", actions } : null;
    }
    case "control":
      return keysOk(x, ["type", "command"], ["command"]) && oneOf(x.command, CONTROLS) ? { type: "control", command: x.command } : null;
    case "visual": {
      if (!keysOk(x, ["type", "request"], ["request"])) return null;
      const request = visual(x.request);
      return request ? { type: "visual", request } : null;
    }
    case "whatIf": {
      if (!keysOk(x, ["type", "scenario"], ["scenario"])) return null;
      const s = scenario(x.scenario);
      return s ? { type: "whatIf", scenario: s } : null;
    }
    case "goal": {
      if (x.op === "create") {
        const spec = keysOk(x, ["type", "op", "spec"], ["spec"]) ? goalSpec(x.spec) : null;
        return spec ? { type: "goal", op: "create", spec } : null;
      }
      if (x.op === "remove") return keysOk(x, ["type", "op", "goalId"], ["goalId"]) && typeof x.goalId === "string" && ID.test(x.goalId) ? { type: "goal", op: "remove", goalId: x.goalId } : null;
      if (x.op === "list") return keysOk(x, ["type", "op"]) ? { type: "goal", op: "list" } : null;
      return null;
    }
    case "local": {
      if (!keysOk(x, ["type", "text", "link"], ["text"]) || !text(x.text, 600)) return null;
      if (x.link === undefined) return { type: "local", text: x.text };
      const l = x.link;
      if (!isObj(l) || !keysOk(l, ["label", "href"], ["label", "href"]) || !text(l.label, 60) || !internalHref(l.href)) return null;
      return { type: "local", text: x.text, link: { label: l.label, href: l.href } };
    }
    case "ask":
      if (!keysOk(x, ["type", "question", "previousQuestion"], ["question"]) || !text(x.question, 300)) return null;
      if (x.previousQuestion !== undefined && !text(x.previousQuestion, 300)) return null;
      return defined({ type: "ask", question: x.question, previousQuestion: x.previousQuestion as string | undefined }) as DialStep;
    case "unsupported":
      return keysOk(x, ["type", "say"], ["say"]) && text(x.say, 500) ? { type: "unsupported", say: x.say } : null;
    default:
      return null;
  }
}

/** Where a navigate step goes, as an in-app href. Null for any other step, or one that fails validation. */
export function stepHref(step: DialStep): string | null {
  const s = validateStep(step);
  if (!s || s.type !== "navigate") return null;
  if (s.to === "/account/spending" && s.filters) return spendingHref(s.filters);
  if (s.to === "/account" && s.focus) return `/account?focus=${s.focus}`;
  return s.to;
}
