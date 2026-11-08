import { describe, expect, it } from "vitest";
import type { Goal, GoalSpec } from "../dial/types";
import { GOALS_KEY, MAX_GOALS, addGoal, newGoalId, readGoals, removeGoal, sanitizeGoals, sanitizeSpec, writeGoals } from "./store";

const cap: GoalSpec = { kind: "category_cap", category: "Eating out", monthlyLimit: 8000 };
const reduce: GoalSpec = { kind: "spend_reduction", target: 50000, by: "2027-01", baselineMonth: "2026-10" };
const goal = (id: string, spec: GoalSpec = cap): Goal => ({ id, spec, createdOn: "2026-11-08" });

function memoryStore() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}
const blocked = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("sanitizeGoals", () => {
  it("keeps valid goals and drops extra fields", () => {
    const raw = [{ ...goal("g-1"), extra: "x", spec: { ...cap, note: "<script>" } }, goal("g-2", reduce), goal("g-3", { kind: "stay_in_budget" })];
    expect(sanitizeGoals(raw)).toEqual([goal("g-1"), goal("g-2", reduce), goal("g-3", { kind: "stay_in_budget" })]);
  });

  it("rejects junk", () => {
    const junk: unknown[] = [
      null,
      "goal",
      42,
      [],
      { id: "g-1" },
      { ...goal("g-1"), id: "<img onerror>" },
      { ...goal("g-1"), createdOn: "yesterday" },
      goal("g-1", { kind: "category_cap", category: "Payments", monthlyLimit: 8000 } as unknown as GoalSpec),
      goal("g-1", { kind: "category_cap", category: "Eating out", monthlyLimit: 80.5 }),
      goal("g-1", { kind: "category_cap", category: "Eating out", monthlyLimit: -1 }),
      goal("g-1", { kind: "category_cap", category: "Eating out", monthlyLimit: 1e12 }),
      goal("g-1", { ...reduce, by: "2027-13" }),
      goal("g-1", { ...reduce, baselineMonth: "2027-02" }),
      goal("g-1", { kind: "save_everything" } as unknown as GoalSpec),
    ];
    expect(sanitizeGoals(junk)).toEqual([]);
    expect(sanitizeGoals({ goals: [goal("g-1")] })).toEqual([]);
    expect(sanitizeGoals(undefined)).toEqual([]);
  });

  it("keeps each id once and at most ten goals", () => {
    expect(sanitizeGoals([goal("g-1"), goal("g-1", reduce)])).toEqual([goal("g-1")]);
    const many = Array.from({ length: 15 }, (_, i) => goal(`g-${i}`, { ...cap, monthlyLimit: 1000 + i }));
    expect(sanitizeGoals(many)).toHaveLength(MAX_GOALS);
  });

  it("checks a single spec", () => {
    expect(sanitizeSpec({ kind: "stay_in_budget", budget: 1 })).toEqual({ kind: "stay_in_budget" });
    expect(sanitizeSpec(reduce)).toEqual(reduce);
    expect(sanitizeSpec("stay_in_budget")).toBeNull();
  });
});

describe("storage", () => {
  it("round-trips through storage", () => {
    const store = memoryStore();
    expect(writeGoals(store, [goal("g-1")])).toBe(true);
    expect(store.data.has(GOALS_KEY)).toBe(true);
    expect(readGoals(store)).toEqual([goal("g-1")]);
  });

  it("works when storage is blocked or broken", () => {
    expect(readGoals(blocked)).toEqual([]);
    expect(writeGoals(blocked, [goal("g-1")])).toBe(false);
    expect(readGoals(null)).toEqual([]);
    expect(writeGoals(null, [])).toBe(false);
    const store = memoryStore();
    store.data.set(GOALS_KEY, "{not json");
    expect(readGoals(store)).toEqual([]);
    store.data.set(GOALS_KEY, JSON.stringify([goal("g-1"), { junk: true }]));
    expect(readGoals(store)).toEqual([goal("g-1")]);
  });
});

describe("addGoal and removeGoal", () => {
  it("adds a clean goal with a new id", () => {
    const r = addGoal([], { ...cap, extra: 1 } as GoalSpec, "2026-11-08", "g-abc");
    expect(r).toEqual({ ok: true, goals: [goal("g-abc")], goal: goal("g-abc"), repeat: false });
  });

  it("returns the existing goal for the same spec, so a repeated confirmation adds nothing", () => {
    const goals = [goal("g-1")];
    const r = addGoal(goals, { ...cap }, "2026-11-09");
    expect(r).toMatchObject({ ok: true, repeat: true, goal: goal("g-1") });
    if (r.ok) expect(r.goals).toBe(goals);
  });

  it("refuses an invalid spec and an eleventh goal", () => {
    expect(addGoal([], { kind: "category_cap", category: "Eating out", monthlyLimit: 0 }, "2026-11-08").ok).toBe(false);
    const ten = Array.from({ length: MAX_GOALS }, (_, i) => goal(`g-${i}`, { ...cap, monthlyLimit: 1000 + i }));
    const r = addGoal(ten, reduce, "2026-11-08");
    expect(r).toEqual({ ok: false, reason: "You can have up to 10 goals. Remove one to add another." });
  });

  it("never reuses an id", () => {
    const r = addGoal([goal("g-1")], reduce, "2026-11-08", "g-1");
    expect(r.ok && r.goal.id).not.toBe("g-1");
    expect(newGoalId([goal("g-00000000")], () => 0)).not.toBe("g-00000000");
  });

  it("removes by id", () => {
    expect(removeGoal([goal("g-1"), goal("g-2", reduce)], "g-1")).toEqual([goal("g-2", reduce)]);
    expect(removeGoal([goal("g-1")], "nope")).toEqual([goal("g-1")]);
  });
});
