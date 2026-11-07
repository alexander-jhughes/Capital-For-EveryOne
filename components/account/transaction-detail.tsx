"use client";

import { Clock, Search, TrendingUp, Undo2, X } from "lucide-react";
import Link from "next/link";
import { forwardRef, useId } from "react";
import { spendingHref } from "@/lib/dial/spending-filters";
import { findPossibleDuplicates, findPriceChanges, type TransactionFlags } from "@/lib/finance";
import { formatLongDate, formatPence, formatShortDate } from "@/lib/format";
import type { Transaction } from "@/lib/types";

const closeLink = "inline-flex min-h-(--target-min) shrink-0 items-center gap-1 font-bold text-primary underline underline-offset-4";

const amountText = (t: Transaction) => (t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount));

interface Props {
  transaction: Transaction;
  flags: TransactionFlags;
  /** Every transaction on the account, to name the other charge behind a flag. */
  transactions: Transaction[];
  /** The same Spending URL without ?txn. */
  closeHref: string;
  /** Heading level for where the panel sits on the page. */
  level?: 2 | 3 | 4;
  /** Extra context, e.g. why it's shown on its own. */
  note?: string;
}

/** One transaction, opened from ?txn= (Dial or a link). Focusable so a screen reader lands on it. */
export const TransactionDetail = forwardRef<HTMLElement, Props>(function TransactionDetail({ transaction: t, flags, transactions, closeHref, level = 3, note }, ref) {
  const id = useId();
  const H = (["h2", "h3", "h4"] as const)[level - 2];
  const dup = flags.possibleDuplicate ? findPossibleDuplicates(transactions).find((d) => d.first.id === t.id || d.second.id === t.id) : undefined;
  const other = dup && (dup.first.id === t.id ? dup.second : dup.first);
  const price = flags.priceChange !== null ? findPriceChanges(transactions).find((c) => c.after.id === t.id) : undefined;
  const rows: [string, string][] = [
    [t.amount < 0 ? (flags.payment ? "Payment" : "Money back") : "Amount", amountText(t)],
    ["Date", formatLongDate(t.date)],
    ["Category", t.category],
    ["Status", t.status === "pending" ? "Pending" : "Posted"],
  ];

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={id}
      data-txn-detail={t.id}
      className="flex scroll-my-24 flex-col gap-3 rounded-xl bg-card p-(--space) shadow-[0_0_0_2px_var(--primary)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-bold text-muted-foreground">Transaction</p>
          <H id={id} className="text-lg font-bold leading-snug">
            {t.merchant}, {amountText(t)}
          </H>
        </div>
        <Link href={closeHref} scroll={false} className={closeLink}>
          <X aria-hidden className="size-[1em]" />
          Close<span className="sr-only"> transaction details</span>
        </Link>
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 min-[24rem]:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-sm font-bold text-muted-foreground min-[24rem]:pt-0.5">{k}</dt>
            <dd className="-mt-1.5 font-bold min-[24rem]:mt-0">{v}</dd>
          </div>
        ))}
      </dl>
      {(dup || price || flags.refund || flags.payment || flags.pending) && (
        <ul className="flex flex-col gap-2" aria-label="Notes">
          {other && (
            <li className="flex flex-col gap-2 rounded-lg bg-attention-surface p-3 text-attention-strong">
              <span className="flex items-start gap-2 font-bold">
                <span aria-hidden className="mt-[0.45em] size-2 shrink-0 rounded-full bg-signal" />
                Possible duplicate
              </span>
              <span>
                {t.merchant} charged the same amount, {formatPence(t.amount)}, on {formatShortDate(other.date)}. If you only shopped once, one may be a mistake.
              </span>
              <Link href={spendingHref({ highlight: [dup!.first.id, dup!.second.id] })} className="inline-flex min-h-(--target-min) items-center gap-1.5 self-start font-bold underline underline-offset-4">
                <Search aria-hidden className="size-[1em]" />
                Show both charges
              </Link>
            </li>
          )}
          {price && (
            <li className="flex items-start gap-2 rounded-lg bg-accent p-3 text-accent-foreground">
              <TrendingUp aria-hidden className="mt-[0.2em] size-[1em] shrink-0" />
              <span>
                <strong>Price {price.change > 0 ? "up" : "down"} {formatPence(Math.abs(price.change))}.</strong> The last charge was {formatPence(price.before.amount)} on {formatShortDate(price.before.date)}.
              </span>
            </li>
          )}
          {flags.refund && (
            <li className="hairline flex items-start gap-2 rounded-lg p-3">
              <Undo2 aria-hidden className="mt-[0.2em] size-[1em] shrink-0" />
              <span>Money back from {t.merchant}. It reduces your spending total.</span>
            </li>
          )}
          {flags.payment && (
            <li className="hairline rounded-lg p-3">A payment you made to your card. Payments aren&apos;t counted as spending.</li>
          )}
          {flags.pending && (
            <li className="hairline flex items-start gap-2 rounded-lg p-3">
              <Clock aria-hidden className="mt-[0.2em] size-[1em] shrink-0" />
              <span>Pending. The shop hasn&apos;t finalised it, so the amount or date can still change.</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
});

/** ?txn= named a transaction that isn't on this account. Said plainly, never a crash. */
export const UnknownTransaction = forwardRef<HTMLDivElement, { closeHref: string }>(function UnknownTransaction({ closeHref }, ref) {
  return (
    <div ref={ref} tabIndex={-1} role="status" className="hairline flex flex-col items-start gap-2 rounded-xl bg-card p-(--space)">
      <p className="font-bold">That transaction isn&apos;t on this account.</p>
      <p className="text-muted-foreground">It may have been mistyped, or it belongs to a different card.</p>
      <Link href={closeHref} scroll={false} className={closeLink}>
        <X aria-hidden className="size-[1em]" />
        Close this message
      </Link>
    </div>
  );
});
