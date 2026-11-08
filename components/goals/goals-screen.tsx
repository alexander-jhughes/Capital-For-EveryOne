"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Plus, Target, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { dialogClasses } from "@/components/spend-pause/confirm-change";
import { actionClass, panelClass } from "@/components/spend-pause/styles";
import { Button } from "@/components/ui/button";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { historyStart, monthKey, monthName, monthRange, monthsWithData, nextMonth } from "@/lib/dial/months";
import { SPENDING_CATEGORIES } from "@/lib/dial/spending-filters";
import type { Goal, GoalProgress, GoalSpec, MonthKey } from "@/lib/dial/types";
import { formatPence } from "@/lib/format";
import { describeGoal } from "@/lib/goals/describe";
import { useGoals } from "@/lib/goals/provider";
import { MAX_GOAL_AMOUNT, MAX_GOALS } from "@/lib/goals/store";
import { parsePounds } from "@/lib/spend-pause/settings";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";

type Kind = GoalSpec["kind"];
type Category = (typeof SPENDING_CATEGORIES)[number];

const optionClass = "flex min-h-(--target-min) cursor-pointer items-center gap-3 rounded-(--radius) border-2 border-input bg-card px-3 py-1 text-base has-checked:border-primary has-checked:font-bold";
const radioClass = "scroll-mb-[calc(var(--target-min)*3)] size-[max(1.5em,24px)] shrink-0 accent-primary";
const fieldClass = "scroll-mb-[calc(var(--target-min)*3)] min-h-(--target-min) w-full rounded-(--radius) border-2 border-input bg-card px-3 text-base text-foreground";
const linkClass = "inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4";

const STATUS: Record<GoalProgress["status"], { text: string; Icon: typeof CircleCheck; tone: string }> = {
  on_track: { text: "On track", Icon: CircleCheck, tone: "text-success" },
  met: { text: "Met", Icon: CircleCheck, tone: "text-success" },
  at_risk: { text: "Close to the limit", Icon: CircleAlert, tone: "text-warning" },
  missed: { text: "Missed", Icon: CircleX, tone: "text-attention" },
  not_measurable: { text: "Can't be measured yet", Icon: CircleDashed, tone: "text-muted-foreground" },
};
const statusText = (p: GoalProgress, spec: GoalSpec) => (p.status === "at_risk" && spec.kind === "spend_reduction" ? "Behind" : STATUS[p.status].text);

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "category_cap", label: "Keep a category under an amount", hint: "For example, eating out under £80 a month." },
  { kind: "spend_reduction", label: "Spend less than a past month", hint: "Adds up how much less you spend than that month, until a month you choose." },
  { kind: "stay_in_budget", label: "Stay within my monthly budget", hint: "Uses the monthly budget you set in Spend Pause." },
];

function amountError(text: string): string | null {
  const pence = parsePounds(text);
  if (pence === null) return "Enter an amount in pounds, like 80 or 80.50.";
  if (pence <= 0) return "The amount needs to be more than £0.";
  return pence > MAX_GOAL_AMOUNT ? `The amount needs to be ${formatPence(MAX_GOAL_AMOUNT).replace(".00", "")} or less.` : null;
}

function GoalForm({ onDone, onCancel }: { onDone: (goal: Goal, repeat: boolean) => void; onCancel: () => void }) {
  const { add, goals } = useGoals();
  const { transactions, settings } = useAccount();
  const current = monthKey(DEMO_TODAY);
  const start = historyStart(transactions);
  // Only complete months in the history can be compared with.
  const baselines = monthsWithData(transactions).filter((k) => k < current && !monthRange(k, DEMO_TODAY, start).partial);
  const byMonths: MonthKey[] = [];
  for (let k = nextMonth(current); byMonths.length < 12; k = nextMonth(k)) byMonths.push(k);

  const [kind, setKind] = useState<Kind>("category_cap");
  const [category, setCategory] = useState<Category>("Eating out");
  const [amount, setAmount] = useState("");
  const [baseline, setBaseline] = useState<MonthKey>(baselines.at(-1) ?? "");
  const [by, setBy] = useState<MonthKey>(byMonths[1]);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const spec = (): GoalSpec | null => {
    if (kind === "stay_in_budget") return { kind };
    const pence = parsePounds(amount);
    if (pence === null || amountError(amount)) return null;
    return kind === "category_cap" ? { kind, category, monthlyLimit: pence } : baseline ? { kind, target: pence, by, baselineMonth: baseline } : null;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);
    if (kind !== "stay_in_budget") {
      const message = amountError(amount);
      setError(message);
      if (message) {
        amountRef.current?.focus();
        return;
      }
    }
    const s = spec();
    if (!s) return;
    try {
      const goal = add(s);
      onDone(goal, goals.some((g) => g.id === goal.id));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "That goal couldn't be added.");
    }
  };

  const preview = spec();
  const amountId = "goal-amount";

  return (
    <form onSubmit={submit} noValidate className={`flex flex-col gap-(--space) ${panelClass}`} aria-labelledby="goal-form-h">
      <h2 id="goal-form-h" className="text-lg font-bold">
        Add a goal
      </h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-base font-bold">What kind of goal?</legend>
        {KINDS.map((k) => (
          <label key={k.kind} className={optionClass}>
            <input type="radio" name="goal-kind" checked={kind === k.kind} onChange={() => {
                setKind(k.kind);
                setError(null);
              }} className={radioClass} />
            <span className="flex flex-col">
              <span>{k.label}</span>
              <span className="text-sm font-normal text-muted-foreground">{k.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind === "category_cap" && (
        <div className="flex flex-col gap-1">
          <label htmlFor="goal-category" className="text-base font-bold">
            Category
          </label>
          <select id="goal-category" value={category} onChange={(e) => setCategory(e.target.value as Category)} className={fieldClass}>
            {SPENDING_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}

      {kind === "spend_reduction" && (
        <>
          {baselines.length ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="goal-baseline" className="text-base font-bold">
                Compare with
              </label>
              <select id="goal-baseline" value={baseline} onChange={(e) => setBaseline(e.target.value)} className={fieldClass}>
                {baselines.map((k) => (
                  <option key={k} value={k}>
                    {monthName(k, DEMO_TODAY)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="font-bold text-warning">There isn&apos;t a complete month in your history to compare with yet.</p>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor="goal-by" className="text-base font-bold">
              By the end of
            </label>
            <select id="goal-by" value={by} onChange={(e) => setBy(e.target.value)} className={fieldClass}>
              {byMonths.map((k) => (
                <option key={k} value={k}>
                  {monthName(k, DEMO_TODAY)}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {kind !== "stay_in_budget" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={amountId} className="text-base font-bold">
            {kind === "category_cap" ? "Monthly limit in pounds" : "How much less in total, in pounds"}
          </label>
          <input
            ref={amountRef}
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${amountId}-error` : undefined}
            className={fieldClass}
          />
          {error && (
            <p id={`${amountId}-error`} className="font-bold text-warning">
              {error}
            </p>
          )}
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
          Add this goal
        </Button>
        <Button type="button" variant="outline" className={`${actionClass} border-input`} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function GoalCard({ goal, progress, onRemove }: { goal: Goal; progress: GoalProgress; onRemove: (goal: Goal, button: HTMLButtonElement) => void }) {
  const simple = useMode().mode === "simple";
  const s = STATUS[progress.status];
  const headingId = `goal-${goal.id}`;
  const over = progress.status === "missed";
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
      {progress.percent !== null && (
        <span aria-hidden className="block h-3 w-full overflow-hidden rounded-full bg-chart-track hairline">
          <span className={`block h-full rounded-full ${over ? "bg-attention" : "bg-chart"}`} style={{ width: `${progress.percent}%` }} />
        </span>
      )}
      <p>{progress.statement}</p>
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
      <Button variant="outline" className={`${actionClass} border-input`} onClick={(e) => onRemove(goal, e.currentTarget)}>
        <Trash2 aria-hidden className="size-[1em]" />
        Remove<span className="sr-only">: {progress.title}</span>
      </Button>
    </li>
  );
}

export function GoalsScreen() {
  const { goals, progress, remove, saved, ready, full } = useGoals();
  const announce = useAnnounce();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Goal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const tell = (text: string) => {
    setNotice(text);
    announce(text);
  };

  const added = (goal: Goal, repeat: boolean) => {
    setAdding(false);
    const title = describeGoal(goal.spec, DEMO_TODAY);
    tell(repeat ? `You already have this goal: ${title}.` : `Goal added: ${title}.`);
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

  return (
    <div className="flex flex-col gap-(--space) [&_a]:scroll-mb-[calc(var(--target-min)*3)]">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight focus:outline-none">
        Goals
      </h1>
      <p>Set a spending goal, and Dial tracks it from your real transactions. Goals don&apos;t move money or change your card.</p>
      <p className="text-sm text-muted-foreground">
        {saved ? "Your goals are kept with your session, so they're here next time. They aren't shared with anyone." : "Your goals can't be saved right now, so they'll only last until you close this page."}
      </p>

      {notice && (
        <p className={`${panelClass} border-2 border-primary font-bold`} role="status">
          {notice}
        </p>
      )}

      {goals.length === 0 ? (
        <section aria-labelledby="goals-empty" className={`flex flex-col items-start gap-2 ${panelClass}`}>
          <Target aria-hidden className="size-[2em] text-primary" />
          <h2 id="goals-empty" className="text-lg font-bold">
            You don&apos;t have any goals yet
          </h2>
          <p>A goal could be keeping eating out under an amount each month, or staying within your Spend Pause budget.</p>
        </section>
      ) : (
        <section aria-labelledby="goals-list" className="flex flex-col gap-2">
          <h2 id="goals-list" className="text-lg font-bold">
            Your goals ({goals.length})
          </h2>
          <ul className="flex flex-col gap-(--space)">
            {goals.map((g, i) => (
              <GoalCard
                key={g.id}
                goal={g}
                progress={progress[i]}
                onRemove={(goal, button) => {
                  returnFocus.current = button;
                  setRemoving(goal);
                }}
              />
            ))}
          </ul>
        </section>
      )}

      {adding ? (
        <GoalForm
          onDone={added}
          onCancel={() => {
            setAdding(false);
            requestAnimationFrame(() => addButton.current?.focus());
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
          <Plus aria-hidden className="size-[1em]" />
          Add a goal
        </Button>
      )}

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
