// Goals saved on this device only. Everything read is checked, because storage can be old, edited or blocked,
// and the app must still work without it (goals then last until the page closes).
import { isMonthKey } from "../dial/months";
import { SPENDING_CATEGORIES } from "../dial/spending-filters";
import type { Goal, GoalSpec } from "../dial/types";
import type { ISODate } from "../types";

export const GOALS_KEY = "cfe-goals";
export const MAX_GOALS = 10;
/** The largest amount a goal can hold: £100,000, the same ceiling as the Spend Pause amounts. */
export const MAX_GOAL_AMOUNT = 10_000_000;

type Store = Pick<Storage, "getItem" | "setItem">;

const GOAL_ID = /^[a-z0-9-]{1,40}$/i;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAmount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_GOAL_AMOUNT;

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

export function readGoals(store: Store | null): Goal[] {
  try {
    const raw = store?.getItem(GOALS_KEY);
    return raw ? sanitizeGoals(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** False when the goals couldn't be saved (no storage, blocked, or full). */
export function writeGoals(store: Store | null, goals: Goal[]): boolean {
  try {
    if (!store) return false;
    store.setItem(GOALS_KEY, JSON.stringify(goals));
    return true;
  } catch {
    return false;
  }
}

/** localStorage, or null where it's blocked. Merely touching window.localStorage can throw. */
export function goalsStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
