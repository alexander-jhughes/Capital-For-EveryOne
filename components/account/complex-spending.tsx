"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { evidenceHref } from "@/lib/assistant/client";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { spendingHref } from "@/lib/dial/spending-filters";
import { describeEmpty, filterTransactions, monthComparison, monthLabel, narrowsList, spendingView } from "@/lib/dial/spending-view";
import type { SpendingFilters } from "@/lib/dial/types";
import { findPossibleDuplicates, flagTransactions } from "@/lib/finance";
import { formatPence, formatShortDate } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";
import { Money } from "../ui/money";
import { SpendingFilterBar, useCatchFocus } from "./spending-filter-bar";
import { TransactionDetail, UnknownTransaction } from "./transaction-detail";
import { TransactionList } from "./transaction-list";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Detailed Spending. Everything it shows comes from the URL (SpendingFilters), so it survives a reload, back and
 * forward, and a Dial switch: ?highlight= (Dial's evidence), ?category= ?month= ?merchant= ?sort= and ?txn=.
 */
export function ComplexSpending({ filters }: { filters: SpendingFilters }) {
  const { transactions } = useAccount();
  const today = DEMO_TODAY;
  const view = useMemo(() => spendingView(transactions, filters, today), [transactions, filters, today]);
  const f = view.filters;
  const active = narrowsList(f);
  const highlightIds = useMemo(() => f.highlight ?? [], [f.highlight]);
  const known = highlightIds.filter((id) => transactions.some((t) => t.id === id));
  const flags = useMemo(() => flagTransactions(transactions), [transactions]);
  const scope = useMemo(
    () => (active ? filterTransactions(transactions, { month: f.month, merchant: f.merchant }, today) : transactions),
    [active, transactions, f.month, f.merchant, today],
  );

  const month = f.month ?? today.slice(0, 7);
  const cmp = monthComparison(transactions, month, today);
  const { range, current, previous, previousFull } = cmp;
  const byCategory =
    f.category && !current.byCategory.some((c) => c.category === f.category) ? [...current.byCategory, { category: f.category, total: 0, ids: [] }] : current.byCategory;
  const biggest = Math.max(...byCategory.map((c) => c.total), 1);
  const compareMax = Math.max(current.total, previous.total, 1);
  const dup = findPossibleDuplicates(transactions)[0];
  const thisName = monthLabel(month, today);
  const prevName = monthLabel(cmp.previousMonth, today);

  const opened = f.txn ? transactions.find((t) => t.id === f.txn) : undefined;
  const openInList = !!opened && (active ? view.rows.some((t) => t.id === opened.id) : true);
  const closeHref = spendingHref({ ...f, txn: undefined });

  const heading = useRef<HTMLHeadingElement>(null);
  const standalone = useRef<HTMLElement>(null);
  const unknown = useRef<HTMLDivElement>(null);
  useCatchFocus(spendingHref(f), heading);
  // An opened transaction that isn't in the list (or isn't on the account) is focused here; the list focuses its own.
  useEffect(() => {
    if (!f.txn || openInList) return;
    const target = standalone.current ?? unknown.current;
    target?.scrollIntoView({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }, [f.txn, openInList]);

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight focus:outline-none">
        Spending
      </h1>

      {active && <SpendingFilterBar view={view} today={today} />}

      {known.length > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-primary px-(--space) py-2 text-primary-foreground">
          <span className="font-bold">
            Showing {known.length} {known.length === 1 ? "transaction" : "transactions"} from your question
          </span>
          <Link href={spendingHref({ ...f, highlight: undefined })} className="inline-flex min-h-(--target-min) items-center gap-1 font-bold underline underline-offset-4">
            <X aria-hidden className="size-[1em]" />
            Clear highlight
          </Link>
        </div>
      )}

      {f.txn && !opened && <UnknownTransaction ref={unknown} closeHref={closeHref} />}
      {opened && !openInList && (
        <TransactionDetail
          ref={standalone}
          transaction={opened}
          flags={flags.get(opened.id)!}
          transactions={transactions}
          closeHref={closeHref}
          level={2}
          note={`It isn't part of ${view.description}, so it's shown here on its own.`}
        />
      )}

      <div className="grid grid-cols-1 gap-(--space) @3xl:grid-cols-2">
        <section aria-labelledby="sp-total" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
          <h2 id="sp-total" className="text-base font-bold text-muted-foreground">
            {range.future
              ? `${thisName} hasn't started yet`
              : range.partial
                ? `${thisName} so far, ${formatShortDate(range.from)} to ${formatShortDate(range.to)} (${plural(range.days, "day")})`
                : `${thisName}, ${formatShortDate(range.from)} to ${formatShortDate(range.to)}`}
          </h2>
          <p className="figure">
            <Money pence={current.total} />
          </p>
          <p className="text-muted-foreground">
            {plural(current.count, "purchase")}
            {current.refunds > 0 ? `, ${formatPence(current.refunds)} back in refunds` : ""}
          </p>
          <dl className="mt-1 flex flex-col gap-2">
            {[
              { label: thisName, value: current.total, bar: "bg-chart" },
              { label: prevName, value: previous.total, bar: "bg-chart-2" },
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
            {range.partial ? `Same days of each month. ${prevName} in full was ${formatPence(previousFull.total)}.` : "Whole months."}
            {cmp.previousIncomplete && cmp.firstRecord
              ? ` Your records start on ${formatShortDate(cmp.firstRecord)}, so ${cmp.previousBeforeRecords ? `there's nothing from ${prevName}` : `${prevName} is only partly here`}.`
              : ""}
          </p>
        </section>

        <section aria-labelledby="sp-cat" className="elevated rounded-xl bg-card p-(--space)">
          <table className="w-full table-fixed [overflow-wrap:anywhere]">
            <caption id="sp-cat" className="pb-2 text-left text-lg font-bold">
              {f.month ? `Where it went in ${thisName}` : "Where it went"}
            </caption>
            <colgroup>
              <col />
              <col className="w-[6rem]" />
            </colgroup>
            <thead className="sr-only">
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-1.5 text-muted-foreground">
                    No spending {range.future ? "yet" : `in ${thisName}`}.
                  </td>
                </tr>
              )}
              {byCategory.map((c) => {
                const mine = c.category === f.category;
                return (
                  <tr key={c.category} data-filtered={mine ? "" : undefined} className={mine ? "bg-accent shadow-[inset_4px_0_0_var(--primary)]" : ""}>
                    <th scope="row" className={`py-1.5 pr-3 text-left font-semibold ${mine ? "pl-3" : ""}`}>
                      {c.category}
                      {mine && <span className="ml-2 inline-block rounded-[1em] bg-primary px-2 text-sm font-bold text-primary-foreground">Your filter</span>}
                      <span aria-hidden className="mt-1.5 block h-2 rounded-full bg-chart-track">
                        <span className="block h-full rounded-full bg-chart" style={{ width: `${(Math.max(0, c.total) * 100) / biggest}%` }} />
                      </span>
                    </th>
                    <td className={`py-1.5 text-right align-top font-bold ${mine ? "pr-3" : ""}`}>{formatPence(c.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      {dup && known.length === 0 && !active && !f.txn && (
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
          {active ? view.description : "Transactions"}
        </h2>
        <TransactionList
          key={[f.category, f.month, f.merchant, f.sort].join("|")}
          transactions={scope}
          allTransactions={transactions}
          flags={flags}
          highlightIds={known}
          initialCategory={f.category}
          initialSort={f.sort}
          openId={opened && openInList ? opened.id : undefined}
          closeHref={closeHref}
          emptyMessage={active ? describeEmpty(f, today) : undefined}
          clearHref={spendingHref({ highlight: f.highlight })}
        />
      </section>
    </div>
  );
}
