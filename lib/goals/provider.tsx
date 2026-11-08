"use client";

// Goals for every screen that needs them. Saved on this device only (localStorage "cfe-goals"), and they keep
// working in memory when storage is blocked: `saved` is then false so the screen can say so.
// Safe to nest: an inner GoalsProvider passes its children straight through to the outer one, so there is only
// ever one copy of the goals and one writer to storage.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_TODAY } from "../demo-clock";
import type { Goal, GoalProgress, GoalSpec } from "../dial/types";
import { useAccount } from "../state/account-context";
import { goalProgress } from "./progress";
import { GOALS_KEY, MAX_GOALS, addGoal, goalsStore, readGoals, removeGoal, writeGoals } from "./store";

export interface GoalsState {
  goals: Goal[];
  /** One per goal, in the same order, from real transactions. */
  progress: GoalProgress[];
  /** Adds the goal and returns it. The same goal twice returns the first. Throws if the spec is invalid or there are MAX_GOALS already. */
  add: (spec: GoalSpec) => Goal;
  remove: (id: string) => void;
  /** False when goals can't be saved here, so they only last until the page closes. */
  saved: boolean;
  /** False until saved goals have been read (they can only be read in the browser). */
  ready: boolean;
  /** True when there are MAX_GOALS goals, so no more can be added. */
  full: boolean;
}

const GoalsContext = createContext<GoalsState | null>(null);

export function GoalsProvider({ children }: { children: React.ReactNode }) {
  const outer = useContext(GoalsContext);
  return outer ? <>{children}</> : <GoalsRoot>{children}</GoalsRoot>;
}

function GoalsRoot({ children }: { children: React.ReactNode }) {
  const { account, transactions, settings } = useAccount();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [saved, setSaved] = useState(true);
  const [ready, setReady] = useState(false);
  // Read by add() and remove(), so two quick changes both see the first before React has rendered it.
  const latest = useRef<Goal[]>([]);
  const loaded = useRef(false);

  const load = useCallback(() => {
    const store = goalsStore();
    const read = readGoals(store);
    latest.current = read;
    loaded.current = true;
    setGoals(read);
    setSaved(store !== null);
  }, []);

  useEffect(() => {
    load();
    setReady(true);
    // Another tab changed the goals: show its version rather than overwrite it later.
    const onStorage = (e: StorageEvent) => {
      if (e.key === GOALS_KEY || e.key === null) load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [load]);

  const update = useCallback((next: Goal[]) => {
    latest.current = next;
    setGoals(next);
    setSaved(writeGoals(goalsStore(), next));
  }, []);

  const add = useCallback(
    (spec: GoalSpec) => {
      // Never write over saved goals that haven't been read yet.
      if (!loaded.current) load();
      const result = addGoal(latest.current, spec, DEMO_TODAY);
      if (!result.ok) throw new Error(result.reason);
      if (!result.repeat) update(result.goals);
      return result.goal;
    },
    [load, update],
  );

  const remove = useCallback(
    (id: string) => {
      if (!loaded.current) load();
      if (latest.current.some((g) => g.id === id)) update(removeGoal(latest.current, id));
    },
    [load, update],
  );

  const progress = useMemo(() => {
    const ctx = { account, txns: transactions, settings, today: DEMO_TODAY };
    return goals.map((g) => goalProgress(g, ctx));
  }, [goals, account, transactions, settings]);

  const value = useMemo(
    () => ({ goals, progress, add, remove, saved, ready, full: goals.length >= MAX_GOALS }),
    [goals, progress, add, remove, saved, ready],
  );
  return <GoalsContext.Provider value={value}>{children}</GoalsContext.Provider>;
}

export function useGoals(): GoalsState {
  const ctx = useContext(GoalsContext);
  if (!ctx) throw new Error("useGoals must be used inside GoalsProvider");
  return ctx;
}
