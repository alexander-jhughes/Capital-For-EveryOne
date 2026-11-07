"use client";

import { Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { askDial, evidenceHref, knownEvidence, offlineFacts } from "@/lib/assistant/client";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { biggestItems, findPossibleDuplicates, flagTransactions, spendingSummary, type TransactionFlags } from "@/lib/finance";
import { formatLongDate, formatPence, formatShortDate } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";
import type { Transaction } from "@/lib/types";
import { FlagBadges } from "./flag-badges";

const SUMMARY_QUESTION = "What did I spend this month?";

function TxCard({ t, flags, highlighted = false }: { t: Transaction; flags: TransactionFlags; highlighted?: boolean }) {
  return (
    <li
      className={`flex items-start justify-between gap-(--space) rounded-lg border-2 p-(--space) ${highlighted ? "border-warning bg-warning-surface" : "border-border bg-card"}`}
    >
      <span>
        <span className="block font-bold">{t.merchant}</span>
        <span className="text-sm text-muted-foreground">{formatLongDate(t.date)}</span>
        <FlagBadges flags={flags} highlighted={highlighted} />
      </span>
      <span className="font-bold tabular-nums">{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
    </li>
  );
}

/** Simple Spending: one sentence from the assistant, the three biggest purchases, and anything worth checking. */
export function SimpleSpending({ highlightIds }: { highlightIds: string[] }) {
  const { account, transactions, settings } = useAccount();
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const highlighted = knownEvidence(highlightIds, new Set(byId.keys())).map((id) => byId.get(id)!);
  const month = spendingSummary(transactions, `${DEMO_TODAY.slice(0, 8)}01`, DEMO_TODAY);
  const inMonth = new Set(month.ids);
  const biggest = biggestItems(transactions.filter((t) => inMonth.has(t.id)), 3);
  const duplicates = findPossibleDuplicates(transactions);
  const flags = flagTransactions(transactions);

  const [summary, setSummary] = useState<{ text: string } | { offline: string } | null>(null);
  useEffect(() => {
    let live = true;
    void askDial(SUMMARY_QUESTION).then((outcome) => {
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
  }, [account, transactions, settings]);

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold">Your spending</h1>

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
          <Link href="/account/spending" className="inline-flex min-h-(--target-min) items-center self-start font-bold underline underline-offset-4">
            Clear these
          </Link>
        </section>
      )}

      <div aria-busy={summary === null} className="rounded-lg border-2 border-border bg-card p-(--space)">
        <h2 className="text-sm font-bold text-muted-foreground">This month so far</h2>
        {summary === null ? (
          <p>
            Checking your spending...
            <span aria-hidden className="mt-2 block h-4 w-3/4 animate-pulse rounded bg-muted" />
          </p>
        ) : "text" in summary ? (
          <p className="text-lg font-bold">{summary.text}</p>
        ) : (
          <p className="text-lg font-bold">{summary.offline}</p>
        )}
      </div>

      {duplicates.map((d) => (
        <section
          key={d.first.id}
          aria-label="Something to check"
          className="flex flex-col gap-1 rounded-lg border-2 border-warning bg-warning-surface p-(--space) text-warning"
        >
          <h2 className="flex items-center gap-2 font-bold">
            <Copy aria-hidden className="size-[1em]" />
            Something to check
          </h2>
          <p>
            {d.first.merchant} charged {formatPence(d.first.amount)} on {formatShortDate(d.first.date)} and again on {formatShortDate(d.second.date)}.
          </p>
          <Link
            href={evidenceHref([d.first.id, d.second.id])}
            className="inline-flex min-h-(--target-min) items-center self-start font-bold underline underline-offset-4"
          >
            Show these charges
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
    </div>
  );
}
