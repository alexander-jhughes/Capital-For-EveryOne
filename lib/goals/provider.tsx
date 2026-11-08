"use client";

// Goals for every screen that needs them. Kept by the server in the visitor's session (GET and PUT /api/goals), and
// they keep working in memory when the server can't be reached: `saved` is then false so the screen can say so.
// Safe to nest: an inner GoalsProvider passes its children straight through to the outer one, so there is only
// ever one copy of the goals and one writer to the server.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_TODAY } from "../demo-clock";
import type { Goal, GoalProgress, GoalSpec } from "../dial/types";
import { useAccount } from "../state/account-context";
import { accountApi } from "../state/account-api";
import { goalProgress } from "./progress";
import { MAX_GOALS, addGoal, removeGoal, updateGoal } from "./store";

export interface GoalsState {
  goals: Goal[];
  /** One per goal, in the same order, from real transactions. */
  progress: GoalProgress[];
  /** Adds the goal and returns it. The same goal twice returns the first. Throws if the spec is invalid or there are MAX_GOALS already. */
  add: (spec: GoalSpec) => Goal;
  remove: (id: string) => void;
  /** Replaces a goal's spec, keeping its id and start date. Throws if the spec is invalid or the goal is gone. */
  update: (id: string, spec: GoalSpec) => Goal;
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
  // Only the newest server reply counts, so a slow reply to an earlier change can't undo a later one.
  const changes = useRef(0);

  const show = useCallback((next: Goal[]) => {
    latest.current = next;
    setGoals(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    accountApi.loadGoals().then((result) => {
      if (cancelled) return;
      // A goal added before the saved ones arrived (Dial can be quick) is kept alongside them.
      if (result.ok) show([...result.state.goals, ...latest.current.filter((g) => !result.state.goals.some((s) => s.id === g.id))].slice(0, MAX_GOALS));
      setSaved(result.ok);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [show]);

  const update = useCallback(
    (next: Goal[]) => {
      show(next);
      const mine = ++changes.current;
      accountApi.goals(() => latest.current).then((result) => {
        if (mine !== changes.current) return;
        setSaved(result.ok);
        if (result.ok) show(result.state.goals);
      });
    },
    [show],
  );

  const add = useCallback(
    (spec: GoalSpec) => {
      const result = addGoal(latest.current, spec, DEMO_TODAY);
      if (!result.ok) throw new Error(result.reason);
      if (!result.repeat) update(result.goals);
      return result.goal;
    },
    [update],
  );

  const remove = useCallback(
    (id: string) => {
      if (latest.current.some((g) => g.id === id)) update(removeGoal(latest.current, id));
    },
    [update],
  );

  const change = useCallback(
    (id: string, spec: GoalSpec) => {
      const result = updateGoal(latest.current, id, spec);
      if (!result.ok) throw new Error(result.reason);
      update(result.goals);
      return result.goal;
    },
    [update],
  );

  const progress = useMemo(() => {
    const ctx = { account, txns: transactions, settings, today: DEMO_TODAY };
    return goals.map((g) => goalProgress(g, ctx));
  }, [goals, account, transactions, settings]);

  const value = useMemo(
    () => ({ goals, progress, add, remove, update: change, saved, ready, full: goals.length >= MAX_GOALS }),
    [goals, progress, add, remove, change, saved, ready],
  );
  return <GoalsContext.Provider value={value}>{children}</GoalsContext.Provider>;
}

export function useGoals(): GoalsState {
  const ctx = useContext(GoalsContext);
  if (!ctx) throw new Error("useGoals must be used inside GoalsProvider");
  return ctx;
}
