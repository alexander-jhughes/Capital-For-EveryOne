import { Clock, Search, TrendingUp, Undo2 } from "lucide-react";
import type { TransactionFlags } from "@/lib/finance";
import { formatPence } from "@/lib/format";

const base = "inline-flex max-w-full items-center gap-1 rounded-[1em] px-2.5 py-0.5 text-sm font-bold leading-tight [&>svg]:size-[0.95em] [&>svg]:shrink-0";

/** Text + shape flags for one transaction (never colour alone). Shared by every list so they always agree. */
export function FlagBadges({ flags, highlighted = false }: { flags: TransactionFlags; highlighted?: boolean }) {
  const { pending, refund, payment, possibleDuplicate, priceChange } = flags;
  if (!pending && !refund && !payment && !possibleDuplicate && priceChange === null && !highlighted) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {highlighted && (
        <span className={`${base} bg-primary text-primary-foreground`}>
          <Search aria-hidden />
          From your question
        </span>
      )}
      {possibleDuplicate && (
        <span className={`${base} bg-attention-surface text-attention-strong`}>
          <span aria-hidden className="size-1.5 rounded-full bg-signal" />
          Possible duplicate
        </span>
      )}
      {priceChange !== null && (
        <span className={`${base} bg-accent text-accent-foreground`}>
          <TrendingUp aria-hidden />
          Price {priceChange > 0 ? "up" : "down"} {formatPence(Math.abs(priceChange))}
        </span>
      )}
      {pending && (
        <span className={`${base} hairline`}>
          <Clock aria-hidden />
          Pending
        </span>
      )}
      {refund && (
        <span className={`${base} hairline`}>
          <Undo2 aria-hidden />
          Refund
        </span>
      )}
      {payment && <span className={`${base} hairline`}>Payment</span>}
    </span>
  );
}
