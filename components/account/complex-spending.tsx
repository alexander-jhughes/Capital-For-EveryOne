"use client";

import Link from "next/link";
import { spendingSummary } from "@/lib/finance";
import { formatPence, formatShortDate } from "@/lib/format";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { useAccount } from "@/lib/state/account-context";
import { TransactionTable } from "./transaction-table";

/** `highlightIds` come from ?highlight= (Stage 5 fills it from AskResponse.evidenceIds), so they survive a Dial switch. */
export function ComplexSpending({ highlightIds }: { highlightIds: string[] }) {
  const { transactions } = useAccount();
  const known = highlightIds.filter((id) => transactions.some((t) => t.id === id));
  const month = spendingSummary(transactions, `${DEMO_TODAY.slice(0, 8)}01`, DEMO_TODAY);

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold">Spending</h1>
      <p>
        This month ({formatShortDate(month.from)} to {formatShortDate(month.to)}):{" "}
        <strong className="tabular-nums">{formatPence(month.total)}</strong> across {month.count} purchases.
      </p>
      {known.length > 0 && (
        <p className="flex flex-wrap items-center justify-between gap-(--space) rounded-lg border-2 border-warning bg-warning-surface px-(--space) py-2 text-warning">
          <span className="font-bold">
            Showing {known.length} {known.length === 1 ? "transaction" : "transactions"} from your question.
          </span>
          <Link href="/account/spending" className="inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4">
            Clear highlight
          </Link>
        </p>
      )}
      <TransactionTable transactions={transactions} highlightIds={known} />
    </div>
  );
}
