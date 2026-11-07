"use client";

import { ArrowRight, CalendarClock, ChevronRight, Mic, PauseCircle, Sparkles, TrendingUp } from "lucide-react";
import Link from "next/link";
import { evidenceHref } from "@/lib/assistant/client";
import { DEMO_TODAY } from "@/lib/demo-clock";
import {
  availableCredit,
  budgetStatus,
  dailySpend,
  daysUntilDue,
  findPossibleDuplicates,
  findPriceChanges,
  flagTransactions,
  monthOverMonth,
} from "@/lib/finance";
import { formatDate, formatLongDate, formatMonth, formatPence, formatShortDate } from "@/lib/format";
import { usePreferences } from "@/lib/preferences/provider";
import { DEFAULT_PREFS, visibleWidgets, WIDGET_LABELS, type WidgetId } from "@/lib/preferences/schema";
import { activeSince } from "@/lib/spend-pause/dial";
import { describeChecks } from "@/lib/spend-pause/settings";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import { FlagBadges } from "../account/flag-badges";
import { useAskDial } from "../assistant/ask-dial";
import { Money } from "../ui/money";

const card = "elevated rounded-xl bg-card p-(--space)";
const linkBtn = "inline-flex min-h-(--target-min) items-center gap-1.5 font-bold text-primary underline-offset-4 hover:underline";

function useHomeData() {
  const { account, transactions, settings, spendPauseActivity, ready } = useAccount();
  const days = daysUntilDue(account, DEMO_TODAY);
  const mom = monthOverMonth(transactions, DEMO_TODAY);
  return {
    account,
    transactions,
    settings,
    pauseSince: activeSince(settings, spendPauseActivity),
    ready,
    days,
    when: days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : `${-days} days ago`,
    mom,
    budget: budgetStatus(transactions, settings, DEMO_TODAY),
    daily: dailySpend(transactions, mom.thisMonth.from, mom.thisMonth.to),
    insights: [
      ...findPossibleDuplicates(transactions).map((d) => ({
        key: d.first.id,
        tone: "attention" as const,
        title: "Possible duplicate",
        text: `${d.first.merchant} charged ${formatPence(d.first.amount)} on ${formatShortDate(d.first.date)} and again on ${formatShortDate(d.second.date)}.`,
        ids: [d.first.id, d.second.id],
      })),
      ...findPriceChanges(transactions).map((c) => ({
        key: c.after.id,
        tone: "info" as const,
        title: "Price change",
        text: `${c.merchant} went ${c.change > 0 ? "up" : "down"} from ${formatPence(c.before.amount)} to ${formatPence(c.after.amount)}.`,
        ids: [c.before.id, c.after.id],
      })),
    ],
  };
}
type HomeData = ReturnType<typeof useHomeData>;

function ProofChip({ ids, label }: { ids: string[]; label?: string }) {
  return (
    <Link
      href={evidenceHref(ids)}
      className="inline-flex min-h-(--target-min) max-w-full items-center gap-1.5 self-start rounded-[1.4em] bg-accent px-[1em] text-sm font-bold text-accent-foreground"
    >
      {label ?? `${ids.length} ${ids.length === 1 ? "transaction" : "transactions"}`}
      <ChevronRight aria-hidden className="size-[1em]" strokeWidth={2.6} />
    </Link>
  );
}

function Bill({ d, simple }: { d: HomeData; simple: boolean }) {
  const { account } = d;
  const paid = account.statementBalance === 0;
  const payLabel = account.currentBalance > 0 ? "Make a payment" : null;
  if (paid && simple)
    return (
      <section aria-labelledby="w-bill" className="flex flex-col gap-(--space)">
        <div>
          <h2 id="w-bill" className="text-lg font-semibold text-muted-foreground">
            Your bill
          </h2>
          <p className="mt-1 text-xl font-bold">Your bill is paid.</p>
          <p className="mt-2 text-muted-foreground">You owe {formatPence(account.currentBalance)} in total.</p>
        </div>
        {payLabel && (
          <Link href="/account/pay" className="elevated flex min-h-(--target-min) items-center justify-center rounded-xl bg-primary px-6 text-lg font-bold text-primary-foreground">
            {payLabel}
          </Link>
        )}
      </section>
    );
  if (paid)
    return (
      <section aria-labelledby="w-bill" className={`${card} flex flex-col gap-3`}>
        <h2 id="w-bill" className="flex items-center gap-2 text-base font-bold text-muted-foreground">
          <CalendarClock aria-hidden className="size-[1.1em]" />
          Your bill
        </h2>
        <p className="text-xl font-bold leading-none tracking-tight">
          <Money pence={0} />
        </p>
        <p className="font-bold">Your bill is paid. Nothing is due.</p>
        {payLabel && (
          <Link href="/account/pay" className="mt-auto flex min-h-(--target-min) items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            {payLabel}
          </Link>
        )}
      </section>
    );
  if (simple)
    return (
      <section aria-labelledby="w-bill" className="flex flex-col gap-(--space)">
        <div>
          <h2 id="w-bill" className="text-lg font-semibold text-muted-foreground">
            Your bill is
          </h2>
          <p className="figure mt-1">
            <Money pence={account.statementBalance} />
          </p>
          <p className="mt-3 text-lg font-bold">Due {formatLongDate(account.paymentDueDate)}</p>
          <p className="text-lg text-muted-foreground">That is {d.when}.</p>
          <p className="mt-2 text-muted-foreground">You owe {formatPence(account.currentBalance)} in total, including spending since this bill.</p>
        </div>
        <Link
          href="/account/pay"
          className="elevated flex min-h-(--target-min) items-center justify-center rounded-xl bg-primary px-6 text-lg font-bold text-primary-foreground"
        >
          Pay my bill
        </Link>
        <p className="text-center text-muted-foreground">The least you can pay is {formatPence(account.minimumPayment)}.</p>
      </section>
    );
  return (
    <section aria-labelledby="w-bill" className={`${card} flex flex-col gap-3`}>
      <h2 id="w-bill" className="flex items-center gap-2 text-base font-bold text-muted-foreground">
        <CalendarClock aria-hidden className="size-[1.1em]" />
        Your bill
      </h2>
      <p className="text-xl font-bold leading-none tracking-tight">
        <Money pence={account.statementBalance} />
      </p>
      <p className="font-bold">
        Due {formatDate(account.paymentDueDate)}, {d.when}
      </p>
      <p className="text-muted-foreground">Minimum {formatPence(account.minimumPayment)}</p>
      <Link
        href="/account/pay"
        className="mt-auto flex min-h-(--target-min) items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground"
      >
        Pay my bill
      </Link>
    </section>
  );
}

function Balance({ d, simple }: { d: HomeData; simple: boolean }) {
  const { account } = d;
  const used = Math.round((account.currentBalance * 100) / account.creditLimit);
  if (simple)
    return (
      <section aria-labelledby="w-balance" className={card}>
        <h2 id="w-balance" className="font-bold">
          Total balance
        </h2>
        <p className="text-xl font-bold">
          <Money pence={account.currentBalance} />
        </p>
        <p className="text-muted-foreground">{formatPence(availableCredit(account))} left to spend</p>
      </section>
    );
  return (
    <section aria-labelledby="w-balance" className="elevated flex flex-col gap-4 rounded-xl bg-hero p-(--space) text-hero-foreground">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="w-balance" className="text-base text-hero-muted">
          Current balance
        </h2>
        <p className="text-sm text-hero-muted">{account.apr}% APR (yearly interest)</p>
      </div>
      <p className="figure">
        <Money pence={account.currentBalance} />
      </p>
      <div>
        <div
          role="meter"
          aria-label="Credit used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
          aria-valuetext={`${formatPence(account.currentBalance)} of ${formatPence(account.creditLimit)} used`}
          className="h-2 overflow-hidden rounded-full bg-white/20"
        >
          <div className="h-full rounded-full bg-[#6cc4e8]" style={{ width: `${used}%` }} />
        </div>
        <p className="mt-2 text-sm text-hero-muted">
          {formatPence(availableCredit(account))} available of {formatPence(account.creditLimit)}
        </p>
      </div>
    </section>
  );
}

function Insights({ d, simple }: { d: HomeData; simple: boolean }) {
  const items = simple ? d.insights.slice(0, 1) : d.insights;
  if (items.length === 0)
    return (
      <section aria-labelledby="w-ins" className={card}>
        <h2 id="w-ins" className="font-bold">
          Dial noticed
        </h2>
        <p className="text-muted-foreground">Nothing unusual in your recent transactions.</p>
      </section>
    );
  return (
    <section aria-labelledby="w-ins" className={`${card} flex flex-col gap-1`}>
      <h2 id="w-ins" className={simple ? "flex items-center gap-2 font-bold text-attention" : "text-lg font-bold"}>
        {simple && <span aria-hidden className="size-2.5 rounded-full bg-signal" />}
        {simple ? "Worth checking" : "Dial noticed"}
      </h2>
      <ul className="flex flex-col">
        {items.map((i) => (
          <li key={i.key} className="flex gap-3 border-b py-3 last:border-0">
            {!simple && (
              <span
                aria-hidden
                className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full ${i.tone === "attention" ? "bg-attention-surface" : "bg-accent"}`}
              >
                {i.tone === "attention" ? <span className="size-2.5 rounded-full bg-signal" /> : <TrendingUp className="size-4 text-accent-foreground" />}
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className={simple ? "text-lg font-semibold leading-snug" : "leading-snug"}>
                {!simple && <strong>{i.title}. </strong>}
                {i.text}
              </p>
              <ProofChip ids={i.ids} label={simple ? `See the ${i.ids.length} charges` : undefined} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Budget({ d }: { d: HomeData }) {
  const { thisMonth, lastMonthSamePeriod } = d.mom;
  const b = d.budget;
  return (
    <section aria-labelledby="w-budget" className={`${card} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="w-budget" className="text-lg font-bold">
          {formatMonth(thisMonth.from)} so far
        </h2>
        <Link href="/account/spending" className={linkBtn}>
          Spending <ArrowRight aria-hidden className="size-[1em]" />
        </Link>
      </div>
      <p className="text-xl font-bold leading-none tracking-tight">
        <Money pence={thisMonth.total} />
        {b && <span className="ml-2 text-base font-normal tracking-normal text-muted-foreground">of {formatPence(b.budget)} budget</span>}
      </p>
      {b && (
        <div
          role="meter"
          aria-label="Monthly budget used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round((b.spent * 100) / b.budget))}
          aria-valuetext={`${formatPence(b.spent)} of ${formatPence(b.budget)}`}
          className="h-2.5 overflow-hidden rounded-full bg-chart-track"
        >
          <div className="h-full rounded-full bg-chart" style={{ width: `${Math.min(100, (b.spent * 100) / b.budget)}%` }} />
        </div>
      )}
      <p className="text-muted-foreground">
        {b ? (b.remaining >= 0 ? `${formatPence(b.remaining)} left. ` : `${formatPence(-b.remaining)} over budget. `) : ""}
        Same days last month: {formatPence(lastMonthSamePeriod.total)}.
      </p>
    </section>
  );
}

function Chart({ d }: { d: HomeData }) {
  const max = Math.max(...d.daily.map((x) => x.total), 1);
  const top = d.daily.reduce((a, x) => (x.total > a.total ? x : a), d.daily[0]);
  return (
    <section aria-labelledby="w-chart" className={`${card} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="w-chart" className="text-lg font-bold">
          Each day
        </h2>
        <p className="text-sm text-muted-foreground">
          Highest {formatDate(top.date)}, {formatPence(top.total)}
        </p>
      </div>
      {/* sr-only can't shrink a <table>, so the wrapper is the hidden box. */}
      <div className="sr-only">
        <table>
          <caption>Spending each day this month</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Spent</th>
            </tr>
          </thead>
          <tbody>
            {d.daily.map((x) => (
              <tr key={x.date}>
                <th scope="row">{formatLongDate(x.date)}</th>
                <td>{formatPence(x.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div aria-hidden className="flex h-32 items-end gap-[6%] shadow-[inset_0_-1px_0_var(--border)]">
        {d.daily.map((x) => (
          <span
            key={x.date}
            className={`block flex-1 rounded-t-md ${x.date === DEMO_TODAY ? "bg-chart-2" : "bg-chart"}`}
            style={{ height: `${Math.max(2, (Math.max(0, x.total) * 100) / max)}%` }}
          />
        ))}
      </div>
      <div aria-hidden className="flex gap-[6%] text-center text-sm text-muted-foreground">
        {d.daily.map((x) => (
          <span key={x.date} className={`flex-1 ${x.date === DEMO_TODAY ? "font-bold text-foreground" : ""}`}>
            {Number(x.date.slice(8))}
          </span>
        ))}
      </div>
    </section>
  );
}

function Recent({ d }: { d: HomeData }) {
  const flags = flagTransactions(d.transactions);
  const recent = [...d.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 5);
  return (
    <section aria-labelledby="w-recent" className={`${card} flex flex-col`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="w-recent" className="text-lg font-bold">
          Recent activity
        </h2>
        <Link href="/account/spending" className={linkBtn}>
          See all
        </Link>
      </div>
      <ul>
        {recent.map((t) => (
          <li key={t.id} className="flex items-center gap-3 border-b py-2.5 last:border-0">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent font-bold text-accent-foreground">
              {t.merchant[0]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold">{t.merchant}</span>
              <span className="text-sm text-muted-foreground">
                {t.category}, {formatShortDate(t.date)}
              </span>
              <FlagBadges flags={flags.get(t.id)!} />
            </span>
            <span className={`font-bold ${t.amount < 0 ? "text-success" : ""}`}>{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Pause({ d }: { d: HomeData }) {
  const s = d.settings;
  const { mode } = useMode();
  return (
    <Link href="/account/spend-pause" className="hairline flex min-h-(--target-min) items-center justify-between gap-3 rounded-xl bg-card px-(--space) py-2">
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <PauseCircle aria-hidden className="size-[1.3em] shrink-0 text-primary" />
        {/* Saved settings load after the first paint, so say nothing about on or off until they have. */}
        <span>
          {!d.ready ? (
            "Spend Pause"
          ) : s.enabled ? (
            <>
              <span className="block font-bold">
                {s.singlePurchaseThreshold !== null ? `Spend Pause is on: we check before anything over ${formatPence(s.singlePurchaseThreshold)}` : "Spend Pause is on"}
              </span>
              {mode === "complex" && (
                <span className="block text-sm text-muted-foreground">
                  {[d.pauseSince && `Since ${d.pauseSince}`, `${describeChecks(s).length} ${describeChecks(s).length === 1 ? "check" : "checks"} in the demo shop`].filter(Boolean).join(". ")}.
                </span>
              )}
            </>
          ) : (
            "Spend Pause is off"
          )}
        </span>
      </span>
      <span className="font-bold text-primary">Change</span>
    </Link>
  );
}

// Desktop pairs: balance+bill, insights+budget, chart+recent (7+5, 7+5, 5+7). Dense flow fills gaps after a reorder.
const SPAN: Partial<Record<WidgetId, string>> = {
  balance: "lg:col-span-7",
  bill: "lg:col-span-5",
  insights: "lg:col-span-7",
  budget: "lg:col-span-5",
  chart: "lg:col-span-5",
  recent: "lg:col-span-7",
  pause: "lg:col-span-12",
};

/** Home for both views. Which widgets appear, their order and emphasis come from the person's layout preference. */
export function HomeScreen() {
  const { mode } = useMode();
  const { prefs, apply } = usePreferences();
  const { openVoice } = useAskDial();
  const d = useHomeData();
  const simple = mode === "simple";
  const widgets = visibleWidgets(mode, prefs.layout);
  const personalised = JSON.stringify(prefs.layout) !== JSON.stringify(DEFAULT_PREFS.layout);

  const render = (w: WidgetId) => {
    switch (w) {
      case "bill":
        return <Bill d={d} simple={simple} />;
      case "balance":
        return <Balance d={d} simple={simple} />;
      case "insights":
        return <Insights d={d} simple={simple} />;
      case "budget":
        return <Budget d={d} />;
      case "chart":
        return <Chart d={d} />;
      case "recent":
        return <Recent d={d} />;
      case "pause":
        return <Pause d={d} />;
    }
  };

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="sr-only">{simple ? "Your bill" : "Account overview"}</h1>
      {simple && <p className="text-sm text-muted-foreground lg:hidden">Credit card ending {d.account.cardLast4}</p>}
      {prefs.voiceFirst && (
        <button type="button" onClick={openVoice} className="elevated flex min-h-(--target-min) items-center justify-center gap-3 rounded-xl bg-primary px-5 text-lg font-bold text-primary-foreground">
          <Mic aria-hidden className="size-[1.2em]" />
          Talk to Dial
        </button>
      )}
      {prefs.onboarding === "unset" && (
        <section aria-labelledby="invite-h" className="hairline flex flex-col gap-2 rounded-xl bg-card p-(--space)">
          <h2 id="invite-h" className="flex items-center gap-2 font-bold">
            <Sparkles aria-hidden className="size-[1.1em] text-primary" />
            Make it yours
          </h2>
          <p className="text-muted-foreground">Optional: tell us what you&apos;d like, and we&apos;ll suggest a style you can preview first.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/account/personalise" className="inline-flex min-h-(--target-min) items-center rounded-full bg-primary px-5 font-bold text-primary-foreground">
              Personalise
            </Link>
            <button type="button" onClick={() => apply([{ type: "onboarding", value: "skipped" }], { save: true })} className="hairline inline-flex min-h-(--target-min) items-center rounded-full px-5 font-bold">
              Not now
            </button>
          </div>
        </section>
      )}
      {personalised && (
        <p className="rounded-lg bg-accent px-(--space) py-2 text-sm text-accent-foreground">
          This home screen uses your layout.{" "}
          <Link href="/account/settings" className="font-bold underline underline-offset-4">
            Change it
          </Link>
        </p>
      )}
      <div className={simple ? "flex flex-col gap-(--space)" : "grid grid-cols-1 gap-(--space) lg:grid-flow-dense lg:grid-cols-12"}>
        {widgets.map((w) => (
          <div
            key={w}
            data-widget={w}
            className={`${simple ? "" : (SPAN[w] ?? "lg:col-span-6")} ${prefs.layout.emphasis === w ? "widget-emphasis rounded-xl" : ""} [&>*]:h-full`}
            aria-label={prefs.layout.emphasis === w ? `${WIDGET_LABELS[w]}, highlighted by you` : undefined}
            role={prefs.layout.emphasis === w ? "group" : undefined}
          >
            {render(w)}
          </div>
        ))}
      </div>
    </div>
  );
}
