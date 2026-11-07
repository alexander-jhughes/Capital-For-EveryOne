import { Clock, Copy, Search, TrendingUp, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { TransactionFlags } from "@/lib/finance";
import { formatPence } from "@/lib/format";

const base = "h-auto gap-1 whitespace-nowrap py-0.5 text-sm leading-tight [&>svg]:size-[1em]!";
const quiet = `${base} border-input text-foreground`;
// Warning tokens are 7:1+ in both themes; text and icon carry the meaning, not colour.
const warn = `${base} border-warning bg-warning-surface text-warning`;

/** Text + icon flags for one transaction. Shared by the table and the recent list so they always agree. */
export function FlagBadges({ flags, highlighted = false }: { flags: TransactionFlags; highlighted?: boolean }) {
  const { pending, refund, payment, possibleDuplicate, priceChange } = flags;
  if (!pending && !refund && !payment && !possibleDuplicate && priceChange === null && !highlighted) return null;
  return (
    <span className="flex flex-wrap gap-1 pt-1">
      {highlighted && (
        <Badge className={base}>
          <Search aria-hidden />
          Matches your question
        </Badge>
      )}
      {possibleDuplicate && (
        <Badge variant="outline" className={warn}>
          <Copy aria-hidden />
          Possible duplicate
        </Badge>
      )}
      {priceChange !== null && (
        <Badge variant="outline" className={warn}>
          <TrendingUp aria-hidden />
          Price {priceChange > 0 ? "up" : "down"} {formatPence(Math.abs(priceChange))}
        </Badge>
      )}
      {pending && (
        <Badge variant="outline" className={quiet}>
          <Clock aria-hidden />
          Pending
        </Badge>
      )}
      {refund && (
        <Badge variant="outline" className={quiet}>
          <Undo2 aria-hidden />
          Refund
        </Badge>
      )}
      {payment && (
        <Badge variant="outline" className={quiet}>
          Payment
        </Badge>
      )}
    </span>
  );
}
