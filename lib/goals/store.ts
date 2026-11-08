// Goal rules, shared by the browser (lib/goals/provider.tsx) and the server (lib/server/account.ts), which keeps the
// goals in the visitor's session. Everything read is checked, because a saved list can be old or edited.
import { isMonthKey } from "../dial/months";
import { SPENDING_CATEGORIES } from "../dial/spending-filters";
import type { Goal, GoalSpec } from "../dial/types";
import type { ISODate } from "../types";

export const MAX_GOALS = 10;
/** The largest amount a goal can hold: £100,000, the same ceiling as the Spend Pause amounts. */
export const MAX_GOAL_AMOUNT = 10_000_000;

const GOAL_ID = /^[a-z0-9-]{1,40}$/i;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAmount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_GOAL_AMOUNT;
const isAmountOrZero = (v: unknown): v is number => v === 0 || isAmount(v);
/** The most saved-amount updates a goal remembers, so a goal stays small enough for the session cookie. */
export const MAX_GOAL_LOG = 6;
/** Plain words only: letters, numbers, spaces and a little punctuation, up to 24 characters. */
const GOAL_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ',.&-]{0,23}$/u;
const PURPOSES = ["emergency", "purchase"] as const;

function cleanLog(v: unknown): [ISODate, number][] | null {
  if (!Array.isArray(v) || v.length > MAX_GOAL_LOG) return null;
  const out: [ISODate, number][] = [];
  for (const row of v) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !ISO_DATE.test(row[0]) || !isAmountOrZero(row[1])) return null;
    out.push([row[0], row[1]]);
  }
  return out;
}

/** A clean copy of a goal spec, or null. Unknown fields are dropped, never kept. */
export function sanitizeSpec(v: unknown): GoalSpec | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case "category_cap":
      return (SPENDING_CATEGORIES as unknown[]).includes(v.category) && isAmount(v.monthlyLimit)
        ? { kind: "category_cap", category: v.category as Extract<GoalSpec, { kind: "category_cap" }>["category"], monthlyLimit: v.monthlyLimit }
        : null;
    case "spend_reduction":
      return isAmount(v.target) && isMonthKey(v.by) && isMonthKey(v.baselineMonth) && v.baselineMonth < v.by
        ? { kind: "spend_reduction", target: v.target, by: v.by, baselineMonth: v.baselineMonth }
        : null;
    case "stay_in_budget":
      return { kind: "stay_in_budget" };
    case "pay_down":
      return isAmountOrZero(v.target) && isAmount(v.startBalance) && v.target < v.startBalance && isMonthKey(v.by)
        ? { kind: "pay_down", target: v.target, by: v.by, startBalance: v.startBalance }
        : null;
    case "utilisation":
      return Number.isInteger(v.percent) && (v.percent as number) >= 1 && (v.percent as number) <= 100 && isAmountOrZero(v.startBalance) && isMonthKey(v.by)
        ? { kind: "utilisation", percent: v.percent as number, by: v.by, startBalance: v.startBalance }
        : null;
    case "save_up": {
      const log = cleanLog(v.log ?? []);
      const label = typeof v.label === "string" ? v.label.trim() : undefined;
      if (!(PURPOSES as readonly unknown[]).includes(v.purpose) || !isAmount(v.target) || !isMonthKey(v.by) || !isAmountOrZero(v.saved) || !log) return null;
      if (label !== undefined && label !== "" && !GOAL_LABEL.test(label)) return null;
      return { kind: "save_up", purpose: v.purpose as "emergency" | "purchase", target: v.target, by: v.by, saved: v.saved, log, ...(label ? { label } : {}) };
    }
    case "pay_on_time":
      return { kind: "pay_on_time" };
    default:
      return null;
  }
}

/** Valid goals only, at most MAX_GOALS, each id once. Anything else (junk, edited or old data) is dropped. */
export function sanitizeGoals(v: unknown): Goal[] {
  if (!Array.isArray(v)) return [];
  const out: Goal[] = [];
  const ids = new Set<string>();
  for (const item of v) {
    if (out.length >= MAX_GOALS) break;
    if (!isRecord(item) || typeof item.id !== "string" || !GOAL_ID.test(item.id) || ids.has(item.id)) continue;
    if (typeof item.createdOn !== "string" || !ISO_DATE.test(item.createdOn)) continue;
    const spec = sanitizeSpec(item.spec);
    if (!spec) continue;
    ids.add(item.id);
    out.push({ id: item.id, spec, createdOn: item.createdOn });
  }
  return out;
}

/** Two specs that would track exactly the same thing. */
export const sameSpec = (a: GoalSpec, b: GoalSpec) => JSON.stringify(sanitizeSpec(a)) === JSON.stringify(sanitizeSpec(b));

export type AddResult = { ok: true; goals: Goal[]; goal: Goal; repeat: boolean } | { ok: false; reason: string };

/** Adds a goal. The same goal twice returns the first, unchanged. Refuses an invalid spec or an eleventh goal. */
export function addGoal(goals: Goal[], spec: GoalSpec, createdOn: ISODate, id: string = newGoalId(goals)): AddResult {
  const clean = sanitizeSpec(spec);
  if (!clean) return { ok: false, reason: "That goal can't be tracked." };
  const existing = goals.find((g) => sameSpec(g.spec, clean));
  if (existing) return { ok: true, goals, goal: existing, repeat: true };
  if (goals.length >= MAX_GOALS) return { ok: false, reason: `You can have up to ${MAX_GOALS} goals. Remove one to add another.` };
  const goal: Goal = { id: goals.some((g) => g.id === id) || !GOAL_ID.test(id) ? newGoalId(goals) : id, spec: clean, createdOn };
  return { ok: true, goals: [...goals, goal], goal, repeat: false };
}

export const removeGoal = (goals: Goal[], id: string) => goals.filter((g) => g.id !== id);

/** Replaces one goal's spec, keeping its id and start date. Refuses an invalid spec or an unknown id. */
export function updateGoal(goals: Goal[], id: string, spec: GoalSpec): AddResult {
  const clean = sanitizeSpec(spec);
  const goal = goals.find((g) => g.id === id);
  if (!clean || !goal) return { ok: false, reason: "That goal can't be changed." };
  const next = { ...goal, spec: clean };
  return { ok: true, goals: goals.map((g) => (g.id === id ? next : g)), goal: next, repeat: false };
}

/** A saved-amount update for a save_up goal: the new amount, with today's entry added to the short log. */
export function withSaved(spec: Extract<GoalSpec, { kind: "save_up" }>, saved: number, today: ISODate): GoalSpec {
  const log = [...spec.log.filter(([d]) => d !== today), [today, saved] as [ISODate, number]].slice(-MAX_GOAL_LOG);
  return { ...spec, saved, log };
}

/** A short id no existing goal has. Not secret: it only tells goals apart on this device. */
export function newGoalId(existing: Goal[], random: () => number = Math.random): string {
  const taken = new Set(existing.map((g) => g.id));
  for (let i = 0; i < 20; i++) {
    const id = `g-${Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0")}`;
    if (!taken.has(id)) return id;
  }
  let n = existing.length;
  while (taken.has(`g-${n}`)) n++;
  return `g-${n}`;
}
