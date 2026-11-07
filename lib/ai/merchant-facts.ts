// Facts about one shop: its transactions and its refunds. Stage 3 only, built on the finance layer.
// flagTransactions decides what is a refund or pending, and totalByMerchant and monthOverMonth do the sums and dates.
import { biggestItems, flagTransactions, monthOverMonth, totalByMerchant } from "../finance";
import { daysBetween, formatLongDate, formatPence } from "../format";
import type { Fact, Transaction } from "../types";
import type { FactContext } from "./facts";
import type { CategoryRank, MerchantPeriod } from "./intent";

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

/** A monthly charge more than this many days old hasn't come round again, so it may have stopped. */
const STILL_ACTIVE_DAYS = 35;

/**
 * What's being paid for regularly. The data has no "cancelled" status, so a subscription with no recent charge is
 * reported as exactly that, and never as an ongoing payment.
 */
export function subscriptionFacts(ctx: FactContext): Fact[] {
  const charges = ctx.txns.filter((t) => t.category === "Subscriptions" && t.amount > 0).sort(newestFirst);
  const latest = [...new Map(charges.reverse().map((t) => [t.merchant, t])).values()].sort(newestFirst);
  if (latest.length === 0) return [fact("no_subscriptions", "Subscriptions", "None found")];
  const isActive = (t: Transaction) => daysBetween(t.date, ctx.today) <= STILL_ACTIVE_DAYS;
  return [
    ...latest.filter(isActive).map((t, i) => fact(`subscription_${i + 1}`, "Subscription", `${t.merchant}, ${formatPence(t.amount)}, last charged on ${formatLongDate(t.date)}`, [t.id])),
    ...latest
      .filter((t) => !isActive(t))
      .map((t, i) => fact(`lapsed_subscription_${i + 1}`, "Subscription with no recent charge", `${t.merchant}, ${formatPence(t.amount)}, no charge since ${formatLongDate(t.date)}`, [t.id])),
  ];
}

/** One transaction by its reference, with its true status. */
export function transactionFacts(ctx: FactContext, id: string | undefined): Fact[] {
  const t = ctx.txns.find((row) => row.id === id);
  if (!t) return [fact("no_transaction", "Transaction", "None found")];
  const flags = flagTransactions(ctx.txns).get(t.id);
  const kind = flags?.payment ? "payment" : flags?.refund ? "refund" : "purchase";
  return [fact("transaction", "Transaction", `${formatPence(Math.abs(t.amount))} at ${t.merchant} on ${formatLongDate(t.date)} (${flags?.pending ? "pending" : "completed"} ${kind})`, [t.id])];
}

/** Spending per category for one month, from the finance layer's own totals. Card payments are never spending. */
export function categoryFacts(ctx: FactContext, period: MerchantPeriod, rank: CategoryRank, named: string[]): Fact[] {
  const { thisMonth, lastMonth } = monthOverMonth(ctx.txns, ctx.today);
  const month = period === "last_month" ? lastMonth : thisMonth;
  const when = period === "last_month" ? "last month" : "this month";
  const all = month.byCategory;
  if (all.length === 0) return [fact("no_categories", `Spending by category ${when}`, "None found")];

  const entry = (category: string) => all.find((c) => c.category === category) ?? { category, total: 0, ids: [] as string[] };
  const row = (key: string, label: string, c: { category: string; total: number; ids: string[] }) => fact(key, label, `${c.category}, ${formatPence(c.total)}`, c.ids);

  if (rank === "biggest") return [row("category_biggest", `Biggest spending category ${when}`, all[0])];
  if (rank === "smallest") return [row("category_smallest", `Smallest spending category ${when}`, all[all.length - 1])];
  if (rank === "named") {
    const rows = named.map((c, i) => row(`category_${i + 1}`, `Spent on this category ${when}`, entry(c)));
    if (named.length !== 2) return rows;
    const [a, b] = named.map(entry);
    const difference = a.total - b.total;
    const comparison =
      difference === 0
        ? `${a.category} and ${b.category} are the same`
        : `${formatPence(Math.abs(difference))} more on ${difference > 0 ? a.category : b.category} than on ${difference > 0 ? b.category : a.category}`;
    return [...rows, fact("category_difference", `Difference between the two ${when}`, comparison)];
  }
  return all.map((c, i) => row(`category_${i + 1}`, `Spent on this category ${when}`, c));
}

/** Payments made to the card, newest first, with their real status. Nothing here can claim a payment that isn't there. */
export function paymentFacts(ctx: FactContext): Fact[] {
  const flags = flagTransactions(ctx.txns);
  const payments = ctx.txns.filter((t) => flags.get(t.id)?.payment).sort(newestFirst);
  const statement = fact("statement_remaining", "Statement balance still to pay", formatPence(ctx.account.statementBalance));
  if (payments.length === 0) return [fact("no_payments", "Payments made", "None found"), statement];
  return [
    ...payments.map((t, i) =>
      fact(`payment_${i + 1}`, i === 0 ? "Latest payment" : "Earlier payment", `${formatPence(-t.amount)}, on ${formatLongDate(t.date)} (${flags.get(t.id)?.pending ? "pending" : "completed"})`, [t.id]),
    ),
    statement,
  ];
}

/** What Spend Pause does, in plain words. Static, so no reply can claim more than this. */
export const SPEND_PAUSE_HOW = [
  "It checks a purchase in the Dial demo shop before it goes through, if the purchase is over your limit, would go over your monthly budget, or is in your quiet hours",
  "You then choose Go ahead or Cancel it, and nothing is bought until you choose",
  "It does not change your balance or any past purchase",
  "It is not connected to a real card, so it cannot stop purchases anywhere else",
];
