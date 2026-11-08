// CONTRACT (Dial 2.0, owned by the lead; changes need agreeing with every workstream that imports it).
//
// One pipeline for typed and spoken input:
//
//   text or Utterance ─► correct() ─► segment() ─► plan() ─► DialStep[] ─► runner (trusted app code) ─► UI
//                                                     │
//                                                     └─► "ask" steps only ─► askDial() ─► /api/ask (Groq)
//
// plan() is pure and deterministic. It never calls the network, never touches money and never returns code.
// Every step it returns is a member of DialStep and passes validateStep() before the runner executes it.
// Groq never sees this contract and never chooses a step: it only words answers to "ask" steps on the server.
import type { Category, ISODate, Mode, Pence } from "../types";
import type { UiAction } from "../preferences/schema";
import type { Scope, SituationId } from "../access/catalogue";

// ─── Routes and screens (from the real app/(dial) tree; nothing invented) ───────────────────────────────────────

export const DIAL_ROUTES = [
  "/account",
  "/account/spending",
  "/account/pay",
  "/account/spend-pause",
  "/account/spend-pause/check",
  "/account/settings",
  "/account/personalise",
  "/account/goals",
  "/account/credit",
] as const;
export type DialRoute = (typeof DIAL_ROUTES)[number];

/** Sections on Home that a navigation can scroll to and focus. Match the `data-widget` values on Home. */
export const HOME_SECTIONS = ["bill", "balance", "insights", "budget", "chart", "recent", "pause"] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

/** A calendar month, "YYYY-MM". */
export type MonthKey = string;
export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Filters the Spending screen reads from its URL, so they survive reloads, back/forward and a Dial switch.
 * `?category=Groceries&month=2026-10&txn=t012&sort=highest&highlight=t001,t002`
 */
export interface SpendingFilters {
  category?: Exclude<Category, "Payments">;
  month?: MonthKey;
  merchant?: string;
  /** One transaction to open (scrolled to, highlighted and described). */
  txn?: string;
  sort?: "newest" | "oldest" | "highest" | "lowest" | "shop";
  /** Evidence ids from an answer (existing behaviour). */
  highlight?: string[];
}

// ─── Visual responses (built by lib/dial/visuals.ts from verified data only) ────────────────────────────────────

export const VISUAL_KINDS = [
  /** Where this month's spending went, by category. */
  "category_breakdown",
  /** Two months side by side, like for like days, total and by category. */
  "month_comparison",
  /** The largest purchases in a period. */
  "biggest_purchases",
  /** This month's spending against the Spend Pause monthly budget. */
  "budget_progress",
  /** Spending month by month over the available history (partial months labelled). */
  "monthly_trend",
  /** One category month by month. */
  "category_trend",
] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

export interface VisualRequest {
  kind: VisualKind;
  category?: Exclude<Category, "Payments">;
  /** For month_comparison: [current, previous]. Otherwise the period to describe. Defaults to the demo month. */
  months?: MonthKey[];
  /** For biggest_purchases. 1 to 10, default 5. */
  limit?: number;
}

export interface VisualDatum {
  label: string;
  /** Pence for money; a count otherwise. Always from lib/finance or lib/insights. */
  value: number;
  /** Exactly as shown on screen and read aloud (lib/format). */
  display: string;
  /** e.g. "8 days so far" for a partial month. */
  note?: string;
  /** Transactions behind this bar or row. */
  evidenceIds?: string[];
}

export interface VisualSeries {
  name: string;
  data: VisualDatum[];
}

export interface Visual {
  kind: VisualKind;
  title: string;
  /** "bars": horizontal bars, one series. "columns": grouped columns. "progress": one meter. "list": ranked rows. */
  chart: "bars" | "columns" | "progress" | "list";
  series: VisualSeries[];
  /** A complete text equivalent of the chart: every figure it shows, in reading order. Read aloud in Voice Mode. */
  textAlternative: string;
  /** One-sentence summary for the conversation. Every figure in it appears in `series`. */
  summary: string;
  limitations: string[];
  evidenceIds: string[];
  /** Where to see it in full, with filters applied. */
  link?: { label: string; to: DialRoute; filters?: SpendingFilters };
}

// ─── What-if simulator (lib/dial/what-if.ts): deterministic, every assumption stated ────────────────────────────

export type WhatIfScenario =
  /** "What if I spend £100 less next month?" */
  | { kind: "spend_less"; amount: Pence; category?: Exclude<Category, "Payments"> }
  /** "Could I save £500 by January?" */
  | { kind: "save_by"; target: Pence; by: MonthKey }
  /** "What if I paid £200 a month off my card?" */
  | { kind: "pay_monthly"; amount: Pence };

export interface WhatIfResult {
  scenario: WhatIfScenario;
  /** Always true. The card and the spoken answer both say "This is an estimate, not a forecast." */
  hypothetical: true;
  title: string;
  /** Plain English. Every figure in it is in `figures`. */
  statement: string;
  figures: { label: string; display: string; value: number }[];
  /** Every assumption the arithmetic depends on, in plain English. Never empty. */
  assumptions: string[];
  /** "achievable" etc. are statements about the arithmetic, never promises. */
  outcome: "fits" | "stretch" | "not_enough_data" | "not_possible";
}

// ─── Goals (lib/goals): stored on this device only, tracked from real transactions ──────────────────────────────

export type GoalSpec =
  /** Keep a category under a monthly amount, e.g. eating out under £80. */
  | { kind: "category_cap"; category: Exclude<Category, "Payments">; monthlyLimit: Pence }
  /** Spend this much less than a baseline month, cumulatively, by a month. Tracks spending, not a savings account. */
  | { kind: "spend_reduction"; target: Pence; by: MonthKey; baselineMonth: MonthKey }
  /** Stay within the Spend Pause monthly budget (read from Spend Pause; changing it happens on that screen). */
  | { kind: "stay_in_budget" };

export interface Goal {
  id: string;
  spec: GoalSpec;
  createdOn: ISODate;
}

export interface GoalProgress {
  goalId: string;
  title: string;
  /** 0 to 100, whole number, from real transactions. null when it can't be measured yet. */
  percent: number | null;
  status: "on_track" | "at_risk" | "missed" | "met" | "not_measurable";
  statement: string;
  limitations: string[];
}

// ─── Conversation context: compact, local, never sent whole to the backend ──────────────────────────────────────

export interface DialSubject {
  category?: Exclude<Category, "Payments">;
  merchant?: string;
  months?: MonthKey[];
}

export interface DialContext {
  /** The page the person is on now. */
  route: DialRoute | null;
  mode: Mode;
  /** What the conversation is about, from the last turn that named something. Only things the person said. */
  subject: DialSubject;
  /** The last visual shown, so "why is that higher?" and "show it as a list" have a referent. */
  lastVisual: VisualRequest | null;
  /** Backend's resolvedQuestion (or the person's own words) from the last "ask" step. Sent as previousQuestion. */
  lastQuestion: string | null;
  /** A step waiting for "yes" or "no". */
  pending: DialStep | null;
}

export const EMPTY_CONTEXT: DialContext = { route: null, mode: "simple", subject: {}, lastVisual: null, lastQuestion: null, pending: null };

// ─── Steps: the only things Dial can do ─────────────────────────────────────────────────────────────────────────

export type ControlCommand = "yes" | "no" | "stop" | "undo" | "reset" | "exit" | "help" | "readPage" | "readBalance" | "save";

export type DialStep =
  /** Go to a page, optionally with Spending filters or a Home section to focus. Never needs confirmation. */
  | { type: "navigate"; to: DialRoute; filters?: SpendingFilters; focus?: HomeSection; say?: string }
  /** Browser back. Keeps the browser's own history intact. */
  | { type: "back" }
  /** Simple or Detailed view. Previewed, then "Keep it" (existing behaviour). */
  | { type: "setMode"; mode: Mode }
  /** Display preferences. Previewed, then "Keep it" (existing behaviour in lib/preferences). */
  | { type: "preferences"; actions: UiAction[] }
  /**
   * The person described their situation ("I have trouble seeing at night"). The changes come from the fixed catalogue
   * (lib/access/catalogue.ts), never from a model: a step only names situations. Previewed with a reason for each
   * change, then kept for the scope (night only, for now, or always). `tentative`: Dial wasn't sure, so it asks. `cloud`: the
   * cloud model named the situation (the on-device model wasn't sure), so the reply doesn't claim it stayed on the phone.
   */
  | { type: "adapt"; situations: SituationId[]; scope: Scope; tentative?: boolean; cloud?: boolean }
  | { type: "control"; command: ControlCommand }
  /** Show a chart built from verified data. */
  | { type: "visual"; request: VisualRequest }
  /** Run a deterministic what-if and show it, labelled hypothetical. */
  | { type: "whatIf"; scenario: WhatIfScenario }
  /** Create or remove a goal. Always confirmed first. */
  | { type: "goal"; op: "create"; spec: GoalSpec }
  | { type: "goal"; op: "remove"; goalId: string }
  | { type: "goal"; op: "list" }
  /** Answered on the device from live state (Pay, Spend Pause). Links to the screen that confirms any change. */
  | { type: "local"; text: string; link?: { label: string; href: string } }
  /** Needs the backend. The only step that may cause a Groq call. */
  | { type: "ask"; question: string; previousQuestion?: string }
  /** Dial didn't understand or can't do it. Says so plainly; never guesses. */
  | { type: "unsupported"; say: string };

export type DialStepType = DialStep["type"];

/** Steps that change something the person keeps. They are previewed or confirmed before they take effect. */
export const CONFIRMED_STEPS: ReadonlySet<DialStepType> = new Set(["setMode", "preferences", "adapt", "goal"]);

export interface DialPlan {
  /** Executed in order. At most 4: a longer chain is cut and the rest is said back to the person. */
  steps: DialStep[];
  /** The context after this utterance (before the runner learns anything from the backend). */
  context: DialContext;
  /** What was understood after corrections, shown under the transcript ("Understood: groceries in October"). */
  understood: string;
  /** Debug/telemetry only: true when no step needs the network. */
  local: boolean;
}

/** Outcome of running one step. The UI shows failures as failures; nothing pretends to have worked. */
export type StepResult =
  | { ok: true; step: DialStep; say?: string }
  | { ok: false; step: DialStep; say: string };

/** What the conversation layer needs to know about the app to plan. Read-only snapshot; no money is moved. */
export interface PlanEnv {
  context: DialContext;
  /** Current text size, so "bigger" steps from it. */
  textSize: import("../preferences/schema").TextSize;
  /** Known merchants, for "show me my Tesco transactions". */
  merchants: string[];
  /** Ids of transactions that exist, for "open transaction t012" and evidence follow-ups. */
  transactionIds: string[];
  /** Months that have transactions, oldest first. */
  months: MonthKey[];
  today: ISODate;
  /** Local answers for Pay and Spend Pause (existing lib/payments/dial and lib/spend-pause/dial), injected by the caller. */
  localReply?: (text: string) => { text: string; link?: { label: string; href: string } } | null;
}
