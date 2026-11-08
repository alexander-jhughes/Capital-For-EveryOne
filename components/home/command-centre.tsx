"use client";

// The financial command centre sections added to Home: spending by category, what's coming up, payments, progress.
// Presentation only. Every figure comes from lib/finance, lib/insights, lib/payments or lib/goals, the same code Dial
// and the other screens use, so a section can never disagree with them.
import { CalendarClock, CircleAlert, CircleCheck, CircleDashed, CircleX, GraduationCap, ListChecks, Repeat, Sparkles, Target, Wallet } from "lucide-react";
import Link from "next/link";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { budgetStatus, daysUntilDue, findPossibleDuplicates, monthOverMonth } from "@/lib/finance";
import { formatLongDate, formatMonth, formatPence, formatShortDate } from "@/lib/format";
import { useGoals } from "@/lib/goals/provider";
import { recurring, upcomingObligations } from "@/lib/insights";
import type { GoalProgress } from "@/lib/dial/types";
import { paymentStatus } from "@/lib/home/payment-status";
import { paymentHistory } from "@/lib/payments/rules";
import { usePreferences } from "@/lib/preferences/provider";
import { useAccount } from "@/lib/state/account-context";
import { BarList, EmptyState, linkButton, Meter, Panel } from "../ui/panel";

const icon = "size-[1.1em] text-primary";

const STATE = {
  paid: { Icon: CircleCheck, tone: "text-success" },
  due: { Icon: CircleDashed, tone: "text-foreground" },
  late: { Icon: CircleX, tone: "text-attention" },
} as const;

export function Categories({ simple }: { simple: boolean }) {
  const { transactions } = useAccount();
  const { prefs } = usePreferences();
  const mom = monthOverMonth(transactions, DEMO_TODAY);
  const now = mom.thisMonth;
  const before = mom.lastMonthSamePeriod;
  const month = formatMonth(now.from);
  const lastMonth = formatMonth(before.from);
  const rows = now.byCategory
    .filter((c) => c.total > 0)
    .slice(0, simple ? 3 : 6)
    .map((c) => {
      const prev = before.byCategory.find((x) => x.category === c.category)?.total ?? 0;
      const diff = c.total - prev;
      return {
        key: c.category,
        label: c.category,
        value: c.total,
        display: formatPence(c.total),
        note: simple ? undefined : prev === 0 ? `None in the same days of ${lastMonth}` : diff === 0 ? `Same as the same days of ${lastMonth}` : `${formatPence(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than the same days of ${lastMonth}`,
      };
    });
  const pendingSet = new Set(transactions.filter((t) => t.status === "pending").map((t) => t.id));
  const pending = transactions.filter((t) => now.ids.includes(t.id) && pendingSet.has(t.id) && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  return (
    <Panel id="w-categories" title={`Where it went in ${month}`} icon={<ListChecks aria-hidden className={icon} />} action={{ href: "/account/spending", label: "Spending" }}>
      {rows.length === 0 ? (
        <EmptyState title={`No spending in ${month} yet.`}>Categories appear here after your first purchase this month.</EmptyState>
      ) : (
        <>
          <p className="text-muted-foreground">
            {formatPence(now.total)} so far, across {now.count} {now.count === 1 ? "purchase" : "purchases"}.
          </p>
          <BarList rows={rows} label={`Spending by category in ${month}`} bars={prefs.charts === "show"} />
          <p className="text-sm text-muted-foreground">
            {[
              pending > 0 && `Includes ${formatPence(pending)} still pending, which may change.`,
              now.refunds > 0 && `${formatPence(now.refunds)} of refunds are taken off.`,
              "Card payments aren't counted as spending.",
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        </>
      )}
    </Panel>
  );
}

export function Upcoming({ simple }: { simple: boolean }) {
  const { account, transactions, settings } = useAccount();
  const ctx = { account, txns: transactions, settings, today: DEMO_TODAY };
  const items = upcomingObligations(ctx).insights;
  const regular = recurring(ctx).insights;
  const [bill, ...expected] = items;
  return (
    <Panel id="w-upcoming" title="Coming up" icon={<CalendarClock aria-hidden className={icon} />}>
      {bill && <p className="font-semibold">{bill.statement}</p>}
      {expected.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Charges expected before your bill">
          {expected.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b py-2 last:border-0">
              <span>
                <span className="block font-bold">{i.subject}</span>
                <span className="text-sm text-muted-foreground">Expected around {i.figures.find((f) => f.unit === "date")?.display}, estimated</span>
              </span>
              <span className="font-bold">{i.figures[0]?.display}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No regular charges are expected before your bill.</p>
      )}
      {!simple && regular.length > 0 && (
        <details className="group">
          <summary className={`${linkButton} cursor-pointer`}>
            <Repeat aria-hidden className="size-[1em]" />
            Your regular charges ({regular.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {regular.map((r) => (
              <li key={r.id} className="text-base">
                {r.statement}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-sm text-muted-foreground">Expected charges are estimates from past charges. Dial can&apos;t see future bills.</p>
    </Panel>
  );
}


export function Payments({ simple }: { simple: boolean }) {
  const { account, transactions, payments } = useAccount();
  const days = daysUntilDue(account, DEMO_TODAY);
  const status = paymentStatus(account.statementBalance, account.minimumPayment, payments.reduce((sum, p) => sum + p.amount, 0), days);
  const s = { ...STATE[status.state], text: status.text };
  const history = paymentHistory(transactions).slice(0, simple ? 2 : 4);
  return (
    <Panel id="w-payments" title="Payments" icon={<Wallet aria-hidden className={icon} />} action={{ href: "/account/pay", label: "Pay" }}>
      <p className={`flex items-start gap-2 font-bold ${s.tone}`}>
        <s.Icon aria-hidden className="mt-1 size-[1.1em] shrink-0" />
        <span>{s.text}</span>
      </p>
      {!simple && (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Statement balance</dt>
          <dd className="text-right font-bold">{formatPence(account.statementBalance)}</dd>
          <dt className="text-muted-foreground">Minimum payment</dt>
          <dd className="text-right font-bold">{formatPence(account.minimumPayment)}</dd>
          <dt className="text-muted-foreground">Due date</dt>
          <dd className="text-right font-bold">{formatLongDate(account.paymentDueDate)}</dd>
        </dl>
      )}
      <h3 className="font-bold">Recent payments</h3>
      {history.length === 0 ? (
        <EmptyState title="No payments in your history yet." />
      ) : (
        <ul className="flex flex-col">
          {history.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b py-2 last:border-0">
              <span>
                {formatShortDate(t.date)}
                {t.status === "pending" && <span className="ml-2 text-sm text-muted-foreground">(processing)</span>}
              </span>
              <span className="font-bold text-success">{formatPence(-t.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const GOAL_STATUS: Record<GoalProgress["status"], { text: string; Icon: typeof CircleCheck; tone: string }> = {
  on_track: { text: "On track", Icon: CircleCheck, tone: "text-success" },
  met: { text: "Reached", Icon: CircleCheck, tone: "text-success" },
  at_risk: { text: "Needs a look", Icon: CircleAlert, tone: "text-warning" },
  missed: { text: "Not this time", Icon: CircleX, tone: "text-attention" },
  not_measurable: { text: "Not measurable yet", Icon: CircleDashed, tone: "text-muted-foreground" },
};
export { GOAL_STATUS };

/** Wellbeing: goals, facts worth feeling good about, and things worth a look. Never a score, never advice. */
export function Progress({ simple }: { simple: boolean }) {
  const { account, transactions, settings } = useAccount();
  const { goals, progress, ready } = useGoals();
  const { prefs } = usePreferences();
  const mom = monthOverMonth(transactions, DEMO_TODAY);
  const budget = budgetStatus(transactions, settings, DEMO_TODAY);
  const dupes = findPossibleDuplicates(transactions);
  const good = [
    mom.difference < 0 && mom.lastMonthSamePeriod.total > 0 && `You've spent ${formatPence(-mom.difference)} less than the same days of ${formatMonth(mom.lastMonthSamePeriod.from)}.`,
    budget && budget.remaining >= 0 && `You're within your ${formatPence(budget.budget)} monthly budget so far.`,
    account.lastPayment.amount > 0 && `Your last payment was ${formatPence(account.lastPayment.amount)} on ${formatShortDate(account.lastPayment.date)}.`,
    account.statementBalance === 0 && "Your latest bill is paid in full.",
  ].filter((x): x is string => typeof x === "string");
  const shown = progress.slice(0, simple ? 2 : 3);
  return (
    <Panel id="w-progress" title="Your progress" icon={<Target aria-hidden className={icon} />} action={{ href: "/account/goals", label: "Goals" }}>
      {!ready ? null : goals.length === 0 ? (
        <EmptyState title="No goals yet.">
          <Link href="/account/goals" className={linkButton}>
            Set a goal
          </Link>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Goals">
          {shown.map((p) => {
            const s = GOAL_STATUS[p.status];
            return (
              <li key={p.goalId} className="flex flex-col gap-1">
                <span className="font-semibold leading-snug">{p.title}</span>
                <span className={`flex items-center gap-1.5 text-sm font-bold ${s.tone}`}>
                  <s.Icon aria-hidden className="size-[1.1em]" />
                  {s.text}
                  {p.percent !== null && <span className="text-foreground">, {p.percent}%</span>}
                </span>
                {p.percent !== null && prefs.charts === "show" && (
                  <Meter label={p.title} value={p.percent} valueText={`${p.percent}%, ${s.text.toLowerCase()}`} tone={p.status === "missed" ? "attention" : "chart"} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {good.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-accent p-3 text-accent-foreground">
          <p className="flex items-center gap-2 font-bold">
            <Sparkles aria-hidden className="size-[1em]" />
            Going well
          </p>
          <ul className="flex flex-col gap-1">
            {good.slice(0, simple ? 1 : 3).map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}
      {dupes.length > 0 && !simple && (
        <p className="text-base">
          <strong>Worth a look: </strong>
          {dupes.length === 1 ? "one charge" : `${dupes.length} charges`} may be a duplicate.{" "}
          <Link href="/account/spending" className="font-bold text-primary underline underline-offset-4">
            Check your spending
          </Link>
        </p>
      )}
      {prefs.learning === "on" && (
        <Link href="/account/learn" className={linkButton}>
          <GraduationCap aria-hidden className="size-[1.1em]" />
          Learn how credit works
        </Link>
      )}
    </Panel>
  );
}
