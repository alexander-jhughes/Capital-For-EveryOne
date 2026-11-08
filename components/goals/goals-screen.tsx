"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { CalendarCheck, CircleAlert, CircleCheck, CircleDashed, CircleX, Flag, History, Pencil, PiggyBank, Plus, Target, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { dialogClasses } from "@/components/spend-pause/confirm-change";
import { actionClass, panelClass } from "@/components/spend-pause/styles";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ui/panel";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { historyStart, monthKey, monthName, monthRange, monthsWithData, nextMonth } from "@/lib/dial/months";
import { SPENDING_CATEGORIES } from "@/lib/dial/spending-filters";
import type { Goal, GoalProgress, GoalSpec, MonthKey } from "@/lib/dial/types";
import { formatPence, formatShortDate } from "@/lib/format";
import { describeGoal } from "@/lib/goals/describe";
import { goalHistory, goalMilestones } from "@/lib/goals/progress";
import { useGoals } from "@/lib/goals/provider";
import { MAX_GOAL_AMOUNT, MAX_GOALS, withSaved } from "@/lib/goals/store";
import { weeklyTrend } from "@/lib/insights";
import { utilisationPercent } from "@/lib/learn/credit";
import { usePreferences } from "@/lib/preferences/provider";
import { useCountUse } from "@/lib/profile/provider";
import { parsePounds } from "@/lib/spend-pause/settings";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";

type Category = (typeof SPENDING_CATEGORIES)[number];
/** What the form offers. Saving goals are one spec kind with two purposes, so they're two choices here. */
type FormKind = Exclude<GoalSpec["kind"], "save_up"> | "emergency" | "purchase";

const optionClass = "flex min-h-(--target-min) cursor-pointer items-center gap-3 rounded-(--radius) border-2 border-input bg-card px-3 py-1 text-base has-checked:border-primary has-checked:font-bold";
const radioClass = "scroll-mb-[calc(var(--target-min)*3)] size-[max(1.5em,24px)] shrink-0 accent-primary";
const fieldClass = "scroll-mb-[calc(var(--target-min)*3)] min-h-(--target-min) w-full rounded-(--radius) border-2 border-input bg-card px-3 text-base text-foreground";
const linkClass = "inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4";

// Supportive wording: a missed goal is "not this time", never a failure.
const STATUS: Record<GoalProgress["status"], { text: string; Icon: typeof CircleCheck; tone: string }> = {
  on_track: { text: "On track", Icon: CircleCheck, tone: "text-success" },
  met: { text: "Reached", Icon: CircleCheck, tone: "text-success" },
  at_risk: { text: "Needs a look", Icon: CircleAlert, tone: "text-warning" },
  missed: { text: "Not this time", Icon: CircleX, tone: "text-attention" },
  not_measurable: { text: "Can't be measured yet", Icon: CircleDashed, tone: "text-muted-foreground" },
};
const statusText = (p: GoalProgress, spec: GoalSpec) =>
  p.status === "at_risk" ? (spec.kind === "spend_reduction" ? "Behind" : spec.kind === "category_cap" || spec.kind === "stay_in_budget" ? "Close to the limit" : "Needs a look") : STATUS[p.status].text;

const GROUPS: { name: string; kinds: { kind: FormKind; label: string; hint: string }[] }[] = [
  {
    name: "Spending",
    kinds: [
      { kind: "category_cap", label: "Keep a category under an amount", hint: "For example, eating out under £80 a month." },
      { kind: "spend_reduction", label: "Spend less than a past month", hint: "Adds up how much less you spend than that month, until a month you choose." },
      { kind: "stay_in_budget", label: "Stay within my monthly budget", hint: "Uses the monthly budget you set in Spend Pause." },
    ],
  },
  {
    name: "Debt and credit",
    kinds: [
      { kind: "pay_down", label: "Reduce what I owe", hint: "Bring your card balance down to an amount, or to zero, by a month." },
      { kind: "utilisation", label: "Use less of my limit", hint: "Keep your balance under a share of your credit limit." },
      { kind: "pay_on_time", label: "Pay on time, every bill", hint: "At least the minimum, by the due date." },
    ],
  },
  {
    name: "Saving",
    kinds: [
      { kind: "emergency", label: "Build an emergency fund", hint: "Money set aside for the unexpected. You tell us what you've saved." },
      { kind: "purchase", label: "Save for something", hint: "A holiday, a laptop, a deposit. You tell us what you've saved." },
    ],
  },
];

function amountError(text: string, { allowZero = false } = {}): string | null {
  const pence = parsePounds(text);
  if (pence === null) return "Enter an amount in pounds, like 80 or 80.50.";
  if (pence <= 0 && !allowZero) return "The amount needs to be more than £0.";
  return pence > MAX_GOAL_AMOUNT ? `The amount needs to be ${formatPence(MAX_GOAL_AMOUNT).replace(".00", "")} or less.` : null;
}

const toPounds = (p: number) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));
const formKind = (s: GoalSpec): FormKind => (s.kind === "save_up" ? s.purpose : s.kind);

function GoalForm({ editing, onDone, onCancel }: { editing?: Goal; onDone: (goal: Goal, repeat: boolean) => void; onCancel: () => void }) {
  const { add, update, goals } = useGoals();
  const { account, transactions, settings } = useAccount();
  const current = monthKey(DEMO_TODAY);
  const start = historyStart(transactions);
  // Only complete months in the history can be compared with.
  const baselines = monthsWithData(transactions).filter((k) => k < current && !monthRange(k, DEMO_TODAY, start).partial);
  const byMonths: MonthKey[] = [];
  for (let k = nextMonth(current); byMonths.length < 24; k = nextMonth(k)) byMonths.push(k);
  const e = editing?.spec;

  const [kind, setKind] = useState<FormKind>(e ? formKind(e) : "category_cap");
  const [category, setCategory] = useState<Category>(e?.kind === "category_cap" ? e.category : "Eating out");
  const [amount, setAmount] = useState(
    !e ? "" : e.kind === "category_cap" ? toPounds(e.monthlyLimit) : e.kind === "spend_reduction" || e.kind === "pay_down" || e.kind === "save_up" ? toPounds(e.target) : "",
  );
  const [saved, setSaved] = useState(e?.kind === "save_up" ? toPounds(e.saved) : "0");
  const [label, setLabel] = useState(e?.kind === "save_up" ? (e.label ?? "") : "");
  const [percent, setPercent] = useState(e?.kind === "utilisation" ? e.percent : 30);
  const [baseline, setBaseline] = useState<MonthKey>(e?.kind === "spend_reduction" ? e.baselineMonth : (baselines.at(-1) ?? ""));
  const [by, setBy] = useState<MonthKey>(e && "by" in e ? e.by : byMonths[kind === "emergency" ? 5 : 2]);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const needsAmount = kind !== "stay_in_budget" && kind !== "pay_on_time" && kind !== "utilisation";
  const hasBy = kind !== "category_cap" && kind !== "stay_in_budget" && kind !== "pay_on_time";
  const used = utilisationPercent(account.currentBalance, account.creditLimit) ?? 0;
  const startBalance = e && (e.kind === "pay_down" || e.kind === "utilisation") ? e.startBalance : account.currentBalance;

  const check = (): string | null => {
    if (needsAmount) {
      const m = amountError(amount, { allowZero: kind === "pay_down" });
      if (m) return m;
      if (kind === "pay_down" && parsePounds(amount)! >= startBalance) return `Your balance is ${formatPence(startBalance)}, so choose an amount below that.`;
    }
    if (kind === "emergency" || kind === "purchase") {
      const m = amountError(saved, { allowZero: true });
      if (m) return `Saved so far: ${m}`;
      if (label && !/^[\p{L}\p{N}][\p{L}\p{N} ',.&-]{0,23}$/u.test(label.trim())) return "Use up to 24 letters, numbers and spaces for the name.";
    }
    if (kind === "utilisation" && !e && used <= percent) return `You're already using ${used}% of your limit, at or under ${percent}%. Choose a lower share.`;
    return null;
  };

  const spec = (): GoalSpec | null => {
    if (check()) return null;
    const pence = parsePounds(amount) ?? 0;
    switch (kind) {
      case "stay_in_budget":
      case "pay_on_time":
        return { kind };
      case "category_cap":
        return { kind, category, monthlyLimit: pence };
      case "spend_reduction":
        return baseline ? { kind, target: pence, by, baselineMonth: baseline } : null;
      case "pay_down":
        return { kind, target: pence, by, startBalance };
      case "utilisation":
        return { kind, percent, by, startBalance };
      case "emergency":
      case "purchase": {
        const s = parsePounds(saved) ?? 0;
        const before = e?.kind === "save_up" ? e : null;
        const base = { kind: "save_up" as const, purpose: kind, target: pence, by, saved: s, log: before?.log ?? [], ...(kind === "purchase" && label.trim() ? { label: label.trim() } : {}) };
        return before && before.saved === s ? base : withSaved(base, s, DEMO_TODAY);
      }
    }
  };

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setFailure(null);
    const message = check();
    setError(message);
    if (message) {
      amountRef.current?.focus();
      return;
    }
    const s = spec();
    if (!s) return;
    try {
      if (editing) onDone(update(editing.id, s), false);
      else {
        const goal = add(s);
        onDone(goal, goals.some((g) => g.id === goal.id));
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "That goal couldn't be saved.");
    }
  };

  const preview = spec();
  const amountId = "goal-amount";
  const errorId = "goal-error";

  return (
    <form onSubmit={submit} noValidate className={`flex flex-col gap-(--space) ${panelClass}`} aria-labelledby="goal-form-h">
      <h2 id="goal-form-h" className="text-lg font-bold">
        {editing ? "Change this goal" : "Add a goal"}
      </h2>
      {!editing &&
        GROUPS.map((g) => (
          <fieldset key={g.name} className="flex flex-col gap-2">
            <legend className="pb-2 text-base font-bold">{g.name}</legend>
            {g.kinds.map((k) => (
              <label key={k.kind} className={optionClass}>
                <input
                  type="radio"
                  name="goal-kind"
                  checked={kind === k.kind}
                  onChange={() => {
                    setKind(k.kind);
                    setBy(byMonths[k.kind === "emergency" ? 5 : 2]);
                    setError(null);
                  }}
                  className={radioClass}
                />
                <span className="flex flex-col">
                  <span>{k.label}</span>
                  <span className="text-sm font-normal text-muted-foreground">{k.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}

      {kind === "category_cap" && (
        <div className="flex flex-col gap-1">
          <label htmlFor="goal-category" className="text-base font-bold">
            Category
          </label>
          <select id="goal-category" value={category} onChange={(ev) => setCategory(ev.target.value as Category)} className={fieldClass}>
            {SPENDING_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}

      {kind === "spend_reduction" &&
        (baselines.length ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="goal-baseline" className="text-base font-bold">
              Compare with
            </label>
            <select id="goal-baseline" value={baseline} onChange={(ev) => setBaseline(ev.target.value)} className={fieldClass}>
              {baselines.map((k) => (
                <option key={k} value={k}>
                  {monthName(k, DEMO_TODAY)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="font-bold text-warning">There isn&apos;t a complete month in your history to compare with yet.</p>
        ))}

      {kind === "utilisation" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-base font-bold">Use no more than</legend>
          <p className="text-sm text-muted-foreground">You&apos;re using {used}% of your limit now.</p>
          <div className="flex flex-wrap gap-2">
            {[10, 20, 30, 50].map((p) => (
              <label key={p} className={`${optionClass} flex-1`}>
                <input type="radio" name="goal-percent" checked={percent === p} onChange={() => setPercent(p)} className={radioClass} />
                {p}%
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {kind === "purchase" && (
        <div className="flex flex-col gap-1">
          <label htmlFor="goal-label" className="text-base font-bold">
            What it&apos;s for (optional)
          </label>
          <input id="goal-label" value={label} maxLength={24} onChange={(ev) => setLabel(ev.target.value)} placeholder="A new laptop" className={fieldClass} />
        </div>
      )}

      {needsAmount && (
        <div className="flex flex-col gap-1">
          <label htmlFor={amountId} className="text-base font-bold">
            {kind === "category_cap"
              ? "Monthly limit in pounds"
              : kind === "spend_reduction"
                ? "How much less in total, in pounds"
                : kind === "pay_down"
                  ? `Bring my balance down to (it's ${formatPence(startBalance)} now)`
                  : "Target in pounds"}
          </label>
          <input
            ref={amountRef}
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(ev) => setAmount(ev.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={fieldClass}
          />
          {kind === "pay_down" && (
            <button type="button" onClick={() => setAmount("0")} className="self-start text-sm font-bold text-primary underline underline-offset-4 min-h-(--target-min)">
              Pay it all off (£0)
            </button>
          )}
        </div>
      )}

      {(kind === "emergency" || kind === "purchase") && (
        <div className="flex flex-col gap-1">
          <label htmlFor="goal-saved" className="text-base font-bold">
            Saved so far, in pounds
          </label>
          <p className="text-sm text-muted-foreground">We can&apos;t see your savings account, so tell us what you have. You can update it any time.</p>
          <input id="goal-saved" inputMode="decimal" autoComplete="off" value={saved} onChange={(ev) => setSaved(ev.target.value)} className={fieldClass} />
        </div>
      )}

      {hasBy && (
        <div className="flex flex-col gap-1">
          <label htmlFor="goal-by" className="text-base font-bold">
            By the end of
          </label>
          <select id="goal-by" value={by} onChange={(ev) => setBy(ev.target.value)} className={fieldClass}>
            {byMonths.map((k) => (
              <option key={k} value={k}>
                {monthName(k, DEMO_TODAY)}
              </option>
            ))}
          </select>
        </div>
      )}

      {kind === "stay_in_budget" && (
        <p className="text-base">
          {settings.monthlyBudget === null ? (
            <>
              You haven&apos;t set a monthly budget yet, so this goal can&apos;t be measured until you do.{" "}
              <Link href="/account/spend-pause" className={linkClass}>
                Set one in Spend Pause
              </Link>
            </>
          ) : (
            <>Your monthly budget is {formatPence(settings.monthlyBudget)}. You can change it in Spend Pause.</>
          )}
        </p>
      )}

      {error && (
        <p id={errorId} className="font-bold text-warning">
          {error}
        </p>
      )}
      {preview && (
        <p className="rounded-lg bg-accent p-3 text-accent-foreground">
          <span className="font-bold">Your goal: </span>
          {describeGoal(preview, DEMO_TODAY)}
        </p>
      )}
      {failure && (
        <p role="alert" className="font-bold text-attention">
          {failure}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" className={actionClass} disabled={kind === "spend_reduction" && !baselines.length}>
          {editing ? "Save changes" : "Add this goal"}
        </Button>
        <Button type="button" variant="outline" className={`${actionClass} border-input`} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** "What have you saved now?" for saving goals: one field, one button. */
function SavedUpdate({ goal, onSaved }: { goal: Goal & { spec: Extract<GoalSpec, { kind: "save_up" }> }; onSaved: (text: string) => void }) {
  const { update } = useGoals();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = `saved-${goal.id}`;
  return (
    <form
      className="flex flex-col gap-1"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const m = amountError(value, { allowZero: true });
        setError(m);
        if (m) return;
        update(goal.id, withSaved(goal.spec, parsePounds(value)!, DEMO_TODAY));
        setValue("");
        onSaved(`Saved amount updated to ${formatPence(parsePounds(value)!)}.`);
      }}
    >
      <label htmlFor={id} className="font-bold">
        Update what you&apos;ve saved
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          placeholder={toPounds(goal.spec.saved)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`${fieldClass} min-w-0 flex-1`}
        />
        <Button type="submit" className={actionClass}>
          Update
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} className="font-bold text-warning">
          {error}
        </p>
      )}
    </form>
  );
}

function GoalCard({
  goal,
  progress,
  onRemove,
  onEdit,
  onSaved,
}: {
  goal: Goal;
  progress: GoalProgress;
  onRemove: (goal: Goal, button: HTMLButtonElement) => void;
  onEdit: (goal: Goal) => void;
  onSaved: (text: string) => void;
}) {
  const simple = useMode().mode === "simple";
  const { prefs } = usePreferences();
  const { account, transactions, settings } = useAccount();
  const s = STATUS[progress.status];
  const headingId = `goal-${goal.id}`;
  const milestones = goalMilestones(progress.percent);
  const history = goalHistory(goal, { account, txns: transactions, settings, today: DEMO_TODAY });
  const next = milestones.find((m) => !m.reached);
  return (
    <li className={`flex flex-col gap-2 ${panelClass}`} aria-labelledby={headingId}>
      <h3 id={headingId} className="text-lg font-bold leading-snug">
        {progress.title}
      </h3>
      <p className={`flex items-center gap-2 font-bold ${s.tone}`}>
        <s.Icon aria-hidden className="size-[1.2em] shrink-0" />
        <span>
          {statusText(progress, goal.spec)}
          {progress.percent !== null && <span className="text-foreground">, {progress.percent}%</span>}
        </span>
      </p>
      {progress.percent !== null && prefs.charts === "show" && (
        <Meter label={progress.title} value={progress.percent} valueText={`${progress.percent}%`} tone={progress.status === "missed" ? "attention" : progress.status === "met" ? "success" : "chart"} />
      )}
      {milestones.length > 0 && (
        <ol aria-label="Milestones" className="flex flex-wrap gap-2">
          {milestones.map((m) => (
            <li key={m.at} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-bold ${m.reached ? "bg-primary text-primary-foreground" : "hairline text-muted-foreground"}`}>
              {m.reached ? <Flag aria-hidden className="size-[0.9em]" /> : null}
              {m.at}%<span className="sr-only">{m.reached ? ", reached" : ", not yet"}</span>
            </li>
          ))}
        </ol>
      )}
      <p>{progress.statement}</p>
      {next && progress.status !== "missed" && <p className="text-sm font-bold">Next milestone: {next.at}%.</p>}
      {progress.limitations.length > 0 && (
        <ul className={`flex flex-col gap-0.5 text-sm text-muted-foreground ${simple ? "" : "list-disc pl-5"}`}>
          {progress.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {goal.spec.kind === "stay_in_budget" && progress.status === "not_measurable" && (
        <Link href="/account/spend-pause" className={linkClass}>
          Set a budget in Spend Pause
        </Link>
      )}
      {(goal.spec.kind === "pay_down" || goal.spec.kind === "pay_on_time" || goal.spec.kind === "utilisation") && progress.status !== "met" && (
        <Link href="/account/pay" className={linkClass}>
          Make a payment
        </Link>
      )}
      {goal.spec.kind === "save_up" && <SavedUpdate goal={goal as Goal & { spec: Extract<GoalSpec, { kind: "save_up" }> }} onSaved={onSaved} />}
      {history.length > 0 && (
        <details>
          <summary className={`${linkClass} cursor-pointer gap-1.5`}>
            <History aria-hidden className="size-[1em]" />
            History ({history.length})
          </summary>
          <ul className="mt-1 flex flex-col">
            {history.map((h, i) => (
              <li key={`${h.date}-${i}`} className="flex justify-between gap-3 border-b py-1.5 last:border-0">
                <span className="text-muted-foreground">{formatShortDate(h.date)}</span>
                <span className="font-semibold">{h.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-sm text-muted-foreground">Set on {formatShortDate(goal.createdOn)}.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {goal.spec.kind !== "stay_in_budget" && goal.spec.kind !== "pay_on_time" && (
          <Button variant="outline" className={`${actionClass} border-input`} onClick={() => onEdit(goal)}>
            <Pencil aria-hidden className="size-[1em]" />
            Change<span className="sr-only">: {progress.title}</span>
          </Button>
        )}
        <Button variant="outline" className={`${actionClass} border-input`} onClick={(ev) => onRemove(goal, ev.currentTarget)}>
          <Trash2 aria-hidden className="size-[1em]" />
          Remove<span className="sr-only">: {progress.title}</span>
        </Button>
      </div>
    </li>
  );
}

/** The week at a glance: facts about spending and how goals stand, in an encouraging voice. Never a score. */
function CheckIn({ progress }: { progress: GoalProgress[] }) {
  const { account, transactions, settings } = useAccount();
  const week = weeklyTrend({ account, txns: transactions, settings, today: DEMO_TODAY }).insights[0];
  const count = (st: GoalProgress["status"][]) => progress.filter((p) => st.includes(p.status)).length;
  const going = count(["on_track", "met"]);
  const look = count(["at_risk"]);
  const missed = count(["missed"]);
  const parts = [going && `${going} going well`, look && `${look} worth a look`, missed && `${missed} didn't work out this time`].filter(Boolean);
  const message =
    missed > 0
      ? "Goals don't always go to plan, and that's normal. You can change the amount or the date, or start fresh."
      : look > 0
        ? "One small step this week, like checking a category or making a payment, can bring a goal back on track."
        : progress.length
          ? "Steady progress. Small, regular steps add up."
          : "Setting one small goal is a good first step.";
  return (
    <section aria-labelledby="checkin-h" className={`flex flex-col gap-2 ${panelClass}`}>
      <h2 id="checkin-h" className="flex items-center gap-2 text-lg font-bold">
        <CalendarCheck aria-hidden className="size-[1.1em] text-primary" />
        This week&apos;s check-in
      </h2>
      {week && <p>{week.statement}</p>}
      {parts.length > 0 && <p className="font-bold">Your goals: {parts.join(", ")}.</p>}
      <p className="text-muted-foreground">{message}</p>
    </section>
  );
}

/** Milestones reached and goals completed since the last render, so a change made here is celebrated once. */
function useCelebrations(progress: GoalProgress[]) {
  const seen = useRef<Map<string, number> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const announce = useAnnounce();
  useEffect(() => {
    const prev = seen.current;
    const now = new Map(progress.map((p) => [p.goalId, p.status === "met" ? 100 : (p.percent ?? 0)]));
    seen.current = now;
    if (!prev) return;
    for (const p of progress) {
      const before = prev.get(p.goalId);
      const after = now.get(p.goalId)!;
      if (before === undefined) continue;
      const crossed = [25, 50, 75, 100].filter((m) => before < m && after >= m).at(-1);
      if (crossed) {
        const text = crossed === 100 ? `Goal reached: ${p.title}. That's a real achievement.` : `Milestone reached: ${crossed}% of "${p.title}". Keep going.`;
        setMessage(text);
        announce(text);
        return;
      }
    }
  }, [progress, announce]);
  return [message, () => setMessage(null)] as const;
}

export function GoalsScreen() {
  useCountUse("goals");
  const { goals, progress, remove, saved, ready, full } = useGoals();
  const announce = useAnnounce();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [removing, setRemoving] = useState<Goal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [celebration, clearCelebration] = useCelebrations(progress);
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const tell = (text: string) => {
    setNotice(text);
    announce(text);
  };

  const finished = (goal: Goal, repeat: boolean) => {
    const wasEditing = editing !== null;
    setAdding(false);
    setEditing(null);
    const title = describeGoal(goal.spec, DEMO_TODAY);
    tell(wasEditing ? `Goal changed: ${title}.` : repeat ? `You already have this goal: ${title}.` : `Goal added: ${title}.`);
    requestAnimationFrame(() => heading.current?.focus());
  };

  const confirmRemove = () => {
    if (!removing) return;
    const title = describeGoal(removing.spec, DEMO_TODAY);
    remove(removing.id);
    setRemoving(null);
    returnFocus.current = heading.current;
    tell(`Goal removed: ${title}.`);
  };

  if (!ready) {
    return (
      <div className="flex flex-col gap-(--space)">
        <h1 className="text-xl font-bold">Goals</h1>
        <p role="status">Loading your goals.</p>
      </div>
    );
  }

  const form = adding || editing;
  return (
    <div className="flex flex-col gap-(--space) [&_a]:scroll-mb-[calc(var(--target-min)*3)]">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight focus:outline-none">
        Goals
      </h1>
      <p>Set a goal for your debt, your saving or your spending, and see your progress. Goals don&apos;t move money or change your card.</p>
      <p className="text-sm text-muted-foreground">
        {saved ? "Your goals are kept with your session, so they're here next time. They aren't shared with anyone." : "Your goals can't be saved right now, so they'll only last until you close this page."}
      </p>

      {celebration && (
        <div className={`${panelClass} flex flex-col items-start gap-2 border-2 border-success`}>
          <p className="flex items-center gap-2 text-lg font-bold text-success">
            <Flag aria-hidden className="size-[1.1em]" />
            {celebration}
          </p>
          <button type="button" onClick={clearCelebration} className={linkClass}>
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <p className={`${panelClass} border-2 border-primary font-bold`} role="status">
          {notice}
        </p>
      )}

      <CheckIn progress={progress} />

      {goals.length === 0 ? (
        <section aria-labelledby="goals-empty" className={`flex flex-col items-start gap-2 ${panelClass}`}>
          <Target aria-hidden className="size-[2em] text-primary" />
          <h2 id="goals-empty" className="text-lg font-bold">
            You don&apos;t have any goals yet
          </h2>
          <p>A goal could be paying your balance down, building an emergency fund, or keeping eating out under an amount each month.</p>
        </section>
      ) : (
        <section aria-labelledby="goals-list" className="flex flex-col gap-2">
          <h2 id="goals-list" className="text-lg font-bold">
            Your goals ({goals.length})
          </h2>
          <ul className="flex flex-col gap-(--space)">
            {goals.map((g, i) =>
              editing?.id === g.id ? null : (
                <GoalCard
                  key={g.id}
                  goal={g}
                  progress={progress[i]}
                  onSaved={tell}
                  onEdit={(goal) => {
                    setNotice(null);
                    setAdding(false);
                    setEditing(goal);
                  }}
                  onRemove={(goal, button) => {
                    returnFocus.current = button;
                    setRemoving(goal);
                  }}
                />
              ),
            )}
          </ul>
        </section>
      )}

      {form ? (
        <GoalForm
          key={editing?.id ?? "new"}
          editing={editing ?? undefined}
          onDone={finished}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
            requestAnimationFrame(() => (addButton.current ?? heading.current)?.focus());
          }}
        />
      ) : full ? (
        <p className="text-base">You have {MAX_GOALS} goals, the most you can have. Remove one to add another.</p>
      ) : (
        <Button
          ref={addButton}
          className={actionClass}
          onClick={() => {
            setNotice(null);
            setAdding(true);
          }}
        >
          {goals.length ? <Plus aria-hidden className="size-[1em]" /> : <PiggyBank aria-hidden className="size-[1em]" />}
          Add a goal
        </Button>
      )}

      <p className="text-sm text-muted-foreground">Reminders outside the app aren&apos;t available in this demo. Your check-in is here whenever you open Goals.</p>

      <AlertDialog.Root open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className={dialogClasses.backdropClass} />
          <AlertDialog.Popup className={dialogClasses.popupClass} finalFocus={returnFocus}>
            <AlertDialog.Title className="text-lg font-bold">Remove this goal?</AlertDialog.Title>
            <AlertDialog.Description className="text-base">
              {removing ? describeGoal(removing.spec, DEMO_TODAY) : ""}. This only removes the goal. Your spending and transactions don&apos;t change.
            </AlertDialog.Description>
            <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap">
              <Button onClick={confirmRemove} className={actionClass}>
                Yes, remove it
              </Button>
              <AlertDialog.Close render={<Button variant="outline" className={`${actionClass} border-input`} />}>Keep it</AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
