"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { askDial, evidenceHref, knownEvidence, offlineFacts } from "@/lib/assistant/client";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { spendingHref } from "@/lib/dial/spending-filters";
import { describeEmpty, narrowsList, sortTransactions, spendingView } from "@/lib/dial/spending-view";
import type { SpendingFilters } from "@/lib/dial/types";
import { biggestItems, findPossibleDuplicates, flagTransactions, spendingSummary, type TransactionFlags } from "@/lib/finance";
import { formatLongDate, formatPence, formatShortDate } from "@/lib/format";
import { liveState } from "@/lib/assistant/live-state";
import { useAccount } from "@/lib/state/account-context";
import type { Transaction } from "@/lib/types";
import { FlagBadges } from "./flag-badges";
import { SpendingFilterBar, useCatchFocus } from "./spending-filter-bar";
import { TransactionDetail, UnknownTransaction } from "./transaction-detail";

const SUMMARY_QUESTION = "What did I spend this month?";

function TxCard({ t, flags, highlighted = false, open = false }: { t: Transaction; flags: TransactionFlags; highlighted?: boolean; open?: boolean }) {
  return (
    <li
      data-txn={t.id}
      data-open={open ? "" : undefined}
      className={`flex items-start justify-between gap-3 rounded-xl p-(--space) ${highlighted || open ? "bg-accent" : "elevated bg-card"} ${open ? "shadow-[0_0_0_2px_var(--primary)]" : ""}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-bold">{t.merchant}</span>
        <span className="text-sm text-muted-foreground">{formatLongDate(t.date)}</span>
        <FlagBadges flags={flags} highlighted={highlighted} />
      </span>
      <span className="shrink-0 font-bold">{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
    </li>
  );
}

/**
 * Simple Spending: one sentence from the assistant, the three biggest purchases, and anything worth checking.
 * With filters in the URL (from Dial or a link) it shows just those purchases instead, with the same filter bar as
 * Detailed. ?txn= opens one transaction at the top.
 */
export function SimpleSpending({ filters }: { filters: SpendingFilters }) {
  const { account, transactions, settings } = useAccount();
  const view = useMemo(() => spendingView(transactions, filters, DEMO_TODAY), [transactions, filters]);
  const f = view.filters;
  const active = narrowsList(f);
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const highlighted = knownEvidence(f.highlight ?? [], new Set(byId.keys())).map((id) => byId.get(id)!);
  const month = spendingSummary(transactions, `${DEMO_TODAY.slice(0, 8)}01`, DEMO_TODAY);
  const inMonth = new Set(month.ids);
  const biggest = biggestItems(transactions.filter((t) => inMonth.has(t.id)), 3);
  const duplicates = findPossibleDuplicates(transactions);
  const flags = flagTransactions(transactions);
  const opened = f.txn ? byId.get(f.txn) : undefined;
  const closeHref = spendingHref({ ...f, txn: undefined });

  const heading = useRef<HTMLHeadingElement>(null);
  const detail = useRef<HTMLElement>(null);
  const unknown = useRef<HTMLDivElement>(null);
  useCatchFocus(spendingHref(f), heading);
  useEffect(() => {
    if (!f.txn) return;
    const target = detail.current ?? unknown.current;
    target?.scrollIntoView({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }, [f.txn]);

  const [summary, setSummary] = useState<{ text: string } | { offline: string } | null>(null);
  useEffect(() => {
    // A filtered view doesn't show the month summary, so don't ask for one.
    if (active) return;
    let live = true;
    void askDial(SUMMARY_QUESTION, { state: liveState(transactions, settings) }).then((outcome) => {
      if (!live) return;
      if (outcome.kind === "answer") setSummary({ text: outcome.response.answer });
      else {
        const first = offlineFacts("spend_this_month", { account, txns: transactions, settings, today: DEMO_TODAY, now: DEMO_NOW }).facts[0];
        setSummary({ offline: `${first.label}: ${first.value}.` });
      }
    });
    return () => {
      live = false;
    };
  }, [account, transactions, settings, active]);

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight focus:outline-none">
        Your spending
      </h1>

      {active && <SpendingFilterBar view={view} today={DEMO_TODAY} />}

      {f.txn && !opened && <UnknownTransaction ref={unknown} closeHref={closeHref} />}
      {opened && <TransactionDetail ref={detail} transaction={opened} flags={flags.get(opened.id)!} transactions={transactions} closeHref={closeHref} level={2} />}

      {highlighted.length > 0 && (
        <section aria-labelledby="from-question-h" className="flex flex-col gap-2">
          <h2 id="from-question-h" className="text-lg font-bold">
            From your question
          </h2>
          <ul className="flex flex-col gap-2">
            {highlighted.map((t) => (
              <TxCard key={t.id} t={t} flags={flags.get(t.id)!} highlighted />
            ))}
          </ul>
          <Link href={spendingHref({ ...f, highlight: undefined })} className="inline-flex min-h-(--target-min) items-center self-start font-bold text-primary underline underline-offset-4">
            Stop showing these
          </Link>
        </section>
      )}

      {active ? (
        <section aria-labelledby="filtered-h" className="flex flex-col gap-2">
          <h2 id="filtered-h" className="text-lg font-bold">
            {view.description}
          </h2>
          {view.rows.length === 0 ? (
            <div className="elevated flex flex-col items-start gap-3 rounded-xl bg-card p-(--space)">
              <p className="text-lg font-bold">{describeEmpty(f, DEMO_TODAY)}</p>
              <Link href={spendingHref({ highlight: f.highlight })} scroll={false} className="hairline inline-flex min-h-(--target-min) items-center rounded-full px-5 font-bold">
                Show all spending
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortTransactions(view.rows, f.sort ?? "newest").map((t) => (
                <TxCard key={t.id} t={t} flags={flags.get(t.id)!} highlighted={highlighted.some((h) => h.id === t.id)} open={t.id === opened?.id} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          <div aria-busy={summary === null} className="elevated rounded-xl bg-card p-(--space)">
            <h2 className="text-sm font-bold text-muted-foreground">This month so far</h2>
            {summary === null ? (
              <p>
                Checking your spending...
                <span aria-hidden className="mt-2 block h-4 w-3/4 animate-pulse rounded bg-muted" />
              </p>
            ) : "text" in summary ? (
              <p className="text-xl font-bold leading-snug tracking-tight">{summary.text}</p>
            ) : (
              <p className="text-xl font-bold leading-snug tracking-tight">{summary.offline}</p>
            )}
          </div>

          {highlighted.length === 0 &&
            !f.txn &&
            duplicates.map((d) => (
              <section key={d.first.id} aria-label="Worth checking" className="elevated flex flex-col gap-2 rounded-xl bg-card p-(--space)">
                <h2 className="flex items-center gap-2 font-bold text-attention">
                  <span aria-hidden className="size-2.5 rounded-full bg-signal" />
                  Worth checking
                </h2>
                <p>
                  {d.first.merchant} charged {formatPence(d.first.amount)} on {formatShortDate(d.first.date)} and again on {formatShortDate(d.second.date)}.
                </p>
                <Link
                  href={evidenceHref([d.first.id, d.second.id])}
                  className="inline-flex min-h-(--target-min) items-center self-start rounded-full bg-accent px-5 font-bold text-accent-foreground"
                >
                  See the 2 charges
                </Link>
              </section>
            ))}

          <section aria-labelledby="biggest-h" className="flex flex-col gap-2">
            <h2 id="biggest-h" className="text-lg font-bold">
              Your biggest purchases this month
            </h2>
            <ul className="flex flex-col gap-2">
              {biggest.map((t) => (
                <TxCard key={t.id} t={t} flags={flags.get(t.id)!} />
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
