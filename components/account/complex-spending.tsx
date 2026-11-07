"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { evidenceHref } from "@/lib/assistant/client";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { findPossibleDuplicates, monthOverMonth } from "@/lib/finance";
import { formatMonth, formatPence, formatShortDate } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";
import { Money } from "../ui/money";
import { TransactionList } from "./transaction-list";

/** Detailed Spending. `highlightIds` come from ?highlight= (Dial's evidence), so they survive a view switch. */
export function ComplexSpending({ highlightIds }: { highlightIds: string[] }) {
  const { transactions } = useAccount();
  const known = highlightIds.filter((id) => transactions.some((t) => t.id === id));
  const { thisMonth, lastMonthSamePeriod, lastMonth } = monthOverMonth(transactions, DEMO_TODAY);
  const biggest = Math.max(...thisMonth.byCategory.map((c) => c.total), 1);
  const compareMax = Math.max(thisMonth.total, lastMonthSamePeriod.total, 1);
  const dup = findPossibleDuplicates(transactions)[0];

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold tracking-tight">Spending</h1>

      {known.length > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-primary px-(--space) py-2 text-primary-foreground">
          <span className="font-bold">
            Showing {known.length} {known.length === 1 ? "transaction" : "transactions"} from your question
          </span>
          <Link href="/account/spending" className="inline-flex min-h-(--target-min) items-center gap-1 font-bold underline underline-offset-4">
            <X aria-hidden className="size-[1em]" />
            Clear highlight
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-(--space) lg:grid-cols-2">
        <section aria-labelledby="sp-total" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
          <h2 id="sp-total" className="text-base font-bold text-muted-foreground">
            {formatMonth(thisMonth.from)} so far, {formatShortDate(thisMonth.from)} to {formatShortDate(thisMonth.to)}
          </h2>
          <p className="figure">
            <Money pence={thisMonth.total} />
          </p>
          <p className="text-muted-foreground">{thisMonth.count} purchases</p>
          <dl className="mt-1 flex flex-col gap-2">
            {[
              { label: formatMonth(thisMonth.from), value: thisMonth.total, bar: "bg-chart" },
              { label: formatMonth(lastMonthSamePeriod.from), value: lastMonthSamePeriod.total, bar: "bg-chart-2" },
            ].map((r) => (
              <div key={r.label} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <dt className="w-[6.5em] max-w-full text-sm font-bold">{r.label}</dt>
                <dd className="flex min-w-[min(100%,12rem)] flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span aria-hidden className="h-3 min-w-[3rem] flex-1 rounded-full bg-chart-track">
                    <span className={`block h-full rounded-full ${r.bar}`} style={{ width: `${(Math.max(0, r.value) * 100) / compareMax}%` }} />
                  </span>
                  <span className="shrink-0 text-right text-sm font-bold">{formatPence(r.value)}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">
            Same days of each month. {formatMonth(lastMonth.from)} in full was {formatPence(lastMonth.total)}.
          </p>
        </section>

        <section aria-labelledby="sp-cat" className="elevated rounded-xl bg-card p-(--space)">
          <table className="w-full table-fixed [overflow-wrap:anywhere]">
            <caption id="sp-cat" className="pb-2 text-left text-lg font-bold">
              Where it went
            </caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {thisMonth.byCategory.map((c) => (
                <tr key={c.category}>
                  <th scope="row" className="py-1.5 pr-3 text-left font-semibold">
                    {c.category}
                    <span aria-hidden className="mt-1.5 block h-2 rounded-full bg-chart-track">
                      <span className="block h-full rounded-full bg-chart" style={{ width: `${(Math.max(0, c.total) * 100) / biggest}%` }} />
                    </span>
                  </th>
                  <td className="w-[42%] py-1.5 text-right align-top font-bold">{formatPence(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {dup && known.length === 0 && (
        <section aria-labelledby="sp-chk" className="elevated flex flex-col gap-2 rounded-xl bg-card p-(--space)">
          <h2 id="sp-chk" className="flex items-center gap-2 font-bold text-attention">
            <span aria-hidden className="size-2.5 rounded-full bg-signal" />
            Worth checking
          </h2>
          <p>
            {dup.first.merchant} charged <strong>{formatPence(dup.first.amount)}</strong> on {formatShortDate(dup.first.date)} and again on {formatShortDate(dup.second.date)}. If you only
            shopped once, one may be a mistake.
          </p>
          <Link href={evidenceHref([dup.first.id, dup.second.id])} className="inline-flex min-h-(--target-min) items-center self-start rounded-full bg-primary px-5 font-bold text-primary-foreground">
            Show the 2 charges
          </Link>
        </section>
      )}

      <section aria-labelledby="sp-tx" className="flex flex-col gap-2">
        <h2 id="sp-tx" className="text-lg font-bold">
          Transactions
        </h2>
        <TransactionList transactions={transactions} highlightIds={known} />
      </section>
    </div>
  );
}
