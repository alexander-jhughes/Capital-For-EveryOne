"use client";

import Link from "next/link";
import { evidenceHref, knownEvidence } from "@/lib/assistant/client";
import { flagTransactions } from "@/lib/finance";
import { formatPence, formatShortDate } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";
import { FlagBadges } from "../account/flag-badges";

const SHOWN = 3;

/** The transactions behind an answer. Each row and the "show all" link open them highlighted in Spending. */
export function EvidenceList({ ids, onNavigate }: { ids: string[]; onNavigate?: () => void }) {
  const { transactions } = useAccount();
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const evidence = knownEvidence(ids, new Set(byId.keys()));
  if (evidence.length === 0) return null;
  const flags = flagTransactions(transactions);

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-bold">Based on {evidence.length === 1 ? "this transaction" : `${evidence.length} transactions`}</h3>
      <ul className="flex flex-col gap-1">
        {evidence.slice(0, SHOWN).map((id) => {
          const t = byId.get(id)!;
          return (
            <li key={id}>
              <Link
                href={evidenceHref([id])}
                onClick={onNavigate}
                className="flex min-h-(--target-min) items-start justify-between gap-3 rounded-xl bg-background px-3 py-2 hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">{t.merchant}</span>
                  <span className="text-sm text-muted-foreground">{formatShortDate(t.date)}</span>
                  <FlagBadges flags={flags.get(id)!} />
                </span>
                <span className="shrink-0 font-bold">{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <Link
        href={evidenceHref(evidence)}
        onClick={onNavigate}
        className="inline-flex min-h-(--target-min) items-center self-start rounded-full bg-accent px-5 font-bold text-accent-foreground"
      >
        {evidence.length === 1 ? "Show it in Spending" : evidence.length <= SHOWN ? "Show these in Spending" : `Show all ${evidence.length} in Spending`}
      </Link>
    </div>
  );
}
