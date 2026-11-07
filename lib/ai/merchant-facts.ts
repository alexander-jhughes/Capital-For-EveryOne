// Facts about one shop: its transactions and its refunds. Stage 3 only, built on the finance layer.
// flagTransactions decides what is a refund or pending, and totalByMerchant and monthOverMonth do the sums and dates.
import { biggestItems, flagTransactions, monthOverMonth, totalByMerchant } from "../finance";
import { formatLongDate, formatPence } from "../format";
import type { Fact, Transaction } from "../types";
import type { FactContext } from "./facts";
import type { MerchantPeriod } from "./intent";

/** How many individual transactions to spell out. Evidence still lists every one. */
const MAX_LISTED = 5;

const fact = (key: string, label: string, value: string, evidenceIds: string[] = []): Fact => ({ key, label, value, evidenceIds });
const newestFirst = (a: Transaction, b: Transaction) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
const sameShop = (t: Transaction, merchant: string) => t.merchant.toLowerCase() === merchant.toLowerCase();

/** The purchase a refund reverses: the latest earlier charge at the same shop for the same amount, if there is one. */
function originalPurchase(refund: Transaction, txns: Transaction[]): Transaction | undefined {
  return txns
    .filter((t) => sameShop(t, refund.merchant) && t.amount === -refund.amount && t.date <= refund.date)
    .sort(newestFirst)[0];
}

/** One fact per refund, pending ones first, each carrying the refund and the purchase it reverses. */
export function refundFacts(ctx: FactContext, merchant?: string): Fact[] {
  const flags = flagTransactions(ctx.txns);
  const refunds = ctx.txns.filter((t) => flags.get(t.id)?.refund && (!merchant || sameShop(t, merchant))).sort(newestFirst);
  if (refunds.length === 0) return [fact("no_refunds", `Refunds${merchant ? ` from ${merchant}` : ""}`, "None found")];

  const describe = (refund: Transaction, pending: boolean, index: number) => {
    const original = originalPurchase(refund, ctx.txns);
    const forPurchase = original ? `, for your ${formatPence(original.amount)} purchase on ${formatLongDate(original.date)}` : "";
    return fact(
      `refund_${pending ? "pending" : "completed"}_${index + 1}`,
      pending ? `Pending ${refund.merchant} refund, which has not arrived yet` : `Completed ${refund.merchant} refund, which has arrived`,
      `${formatPence(-refund.amount)}, on ${formatLongDate(refund.date)}${forPurchase}`,
      original ? [refund.id, original.id] : [refund.id],
    );
  };
  const pending = refunds.filter((t) => flags.get(t.id)?.pending);
  const completed = refunds.filter((t) => !flags.get(t.id)?.pending);
  return [...pending.map((t, i) => describe(t, true, i)), ...completed.map((t, i) => describe(t, false, i))];
}

/** The month's biggest purchases, for months other than the current one that Stage 2's facts cover. */
export function topItemFacts(ctx: FactContext): Fact[] {
  const { lastMonth } = monthOverMonth(ctx.txns, ctx.today);
  const inMonth = ctx.txns.filter((t) => t.date >= lastMonth.from && t.date <= lastMonth.to);
  const ordinal = ["Biggest", "Second biggest", "Third biggest"];
  return biggestItems(inMonth, 3).map((t, i) => fact(`top_item_${i + 1}`, `${ordinal[i]} purchase last month`, `${t.merchant}, ${formatPence(t.amount)}, on ${formatLongDate(t.date)}`, [t.id]));
}

/** One shop's total and transactions, for all the data or a single month. */
export function merchantFacts(ctx: FactContext, merchant: string, period: MerchantPeriod): Fact[] {
  const { thisMonth, lastMonth } = monthOverMonth(ctx.txns, ctx.today);
  const range = period === "this_month" ? thisMonth : period === "last_month" ? lastMonth : null;
  const when = period === "this_month" ? " this month" : period === "last_month" ? " last month" : "";
  const txns = ctx.txns.filter((t) => sameShop(t, merchant) && (!range || (t.date >= range.from && t.date <= range.to))).sort(newestFirst);
  if (txns.length === 0) return [fact("no_transactions", `${merchant} transactions${when}`, "None found")];

  const flags = flagTransactions(ctx.txns);
  const { total, count } = totalByMerchant(txns, merchant);
  const ids = txns.map((t) => t.id);
  const hasRefunds = txns.some((t) => flags.get(t.id)?.refund);
  const hasPending = txns.some((t) => flags.get(t.id)?.pending);
  const status = (t: Transaction) => {
    const kind = flags.get(t.id)?.refund ? "refund" : "purchase";
    return flags.get(t.id)?.pending ? `pending ${kind}` : kind;
  };
  return [
    fact("merchant_total", `Total at ${merchant}${when}${hasRefunds ? ", after refunds" : ""}${hasPending ? ", counting pending items" : ""}`, formatPence(total), ids),
    fact("merchant_purchases", `Number of purchases at ${merchant}${when}`, String(count), ids),
    fact("merchant_transactions", `Number of ${merchant} transactions${when}`, String(txns.length), ids),
    ...txns.slice(0, MAX_LISTED).map((t, i) =>
      fact(`transaction_${i + 1}`, `${merchant} transaction`, `${formatPence(Math.abs(t.amount))} on ${formatLongDate(t.date)} (${status(t)})`, [t.id]),
    ),
  ];
}
