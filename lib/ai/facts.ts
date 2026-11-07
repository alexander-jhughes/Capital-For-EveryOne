// Facts layer: turns lib/finance results into pre-formatted, evidence-carrying facts for the assistant.
// Every figure and every evidence ID comes from lib/finance. This file only selects and formats; the model only phrases.
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { RESET_SPEND_PAUSE } from "../demo-config";
import {
  biggestItems,
  budgetStatus,
  daysUntilDue,
  evaluatePurchase,
  findPossibleDuplicates,
  findPriceChanges,
  monthOverMonth,
} from "../finance";
import { formatLongDate, formatPence } from "../format";
import type {
  Account,
  EvidenceRow,
  Fact,
  FactSet,
  Intent,
  ISODate,
  PendingPurchase,
  SpendPauseSettings,
  Transaction,
} from "../types";

export const INTENTS: Intent[] = [
  "spend_this_month",
  "spend_last_month",
  "top_items",
  "duplicates",
  "price_changes",
  "days_until_due",
  "minimum_payment",
  "spend_pause",
];

/** Everything the facts depend on. The API route passes the client's session state here; tests use seedContext(). */
export interface FactContext {
  account: Account;
  txns: Transaction[];
  settings: SpendPauseSettings;
  today: ISODate;
  now: Date;
  /** Only for spend_pause: the purchase being checked. */
  purchase?: PendingPurchase;
}

export const seedContext = (): FactContext => ({
  account: SEED_ACCOUNT,
  txns: SEED_TRANSACTIONS,
  settings: RESET_SPEND_PAUSE,
  today: DEMO_TODAY,
  now: DEMO_NOW,
});

const gbp = formatPence;
const dayMonth = (d: ISODate) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
const monthName = (d: ISODate) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
/** "1 to 8 November" */
const period = (from: ISODate, to: ISODate) => `${Number(from.slice(8))} to ${dayMonth(to)}`;
const ordinal = ["Biggest", "Second biggest", "Third biggest"];
const fact = (key: string, label: string, value: string, evidenceIds: string[] = []): Fact => ({ key, label, value, evidenceIds });

function spendingFacts(intent: "spend_this_month" | "spend_last_month", ctx: FactContext): Fact[] {
  const mom = monthOverMonth(ctx.txns, ctx.today);
  if (intent === "spend_last_month") {
    const last = mom.lastMonth;
    const top = last.byCategory[0];
    return [
      fact("last_month_total", `Spent in ${monthName(last.from)}`, gbp(last.total), last.ids),
      fact("last_month_purchases", `Number of purchases in ${monthName(last.from)}`, String(last.count), last.ids),
      ...(top ? [fact("last_month_top_category", `Biggest category in ${monthName(last.from)}`, `${top.category}, ${gbp(top.total)}`, top.ids)] : []),
    ];
  }
  const now = mom.thisMonth;
  const prev = mom.lastMonthSamePeriod;
  const top = now.byCategory[0];
  const change =
    mom.difference === 0 ? "The same" : `${gbp(Math.abs(mom.difference))} ${mom.difference > 0 ? "more" : "less"}`;
  return [
    fact("month_to_date_total", `Spent this month (${period(now.from, now.to)})`, gbp(now.total), now.ids),
    ...(top ? [fact("month_top_category", "Biggest category this month", `${top.category}, ${gbp(top.total)}`, top.ids)] : []),
    ...(now.refunds > 0 ? [fact("month_refunds", "Refunds this month, already taken off the total", gbp(now.refunds), now.refundIds)] : []),
    fact("same_days_last_month_total", `Spent in the same days last month (${period(prev.from, prev.to)})`, gbp(prev.total), prev.ids),
    fact("change_vs_same_days_last_month", "This month compared with the same days last month", change),
  ];
}

function topItemFacts(ctx: FactContext): Fact[] {
  const { thisMonth } = monthOverMonth(ctx.txns, ctx.today);
  const inMonth = new Set(thisMonth.ids);
  return biggestItems(ctx.txns.filter((t) => inMonth.has(t.id)), 3).map((t, i) =>
    fact(`top_item_${i + 1}`, `${ordinal[i]} purchase this month`, `${t.merchant}, ${gbp(t.amount)}, on ${formatLongDate(t.date)}`, [t.id]),
  );
}

function duplicateFacts(ctx: FactContext): Fact[] {
  const dups = findPossibleDuplicates(ctx.txns);
  if (dups.length === 0) return [fact("no_duplicates", "Possible duplicate charges", "None found")];
  return dups.map((d, i) =>
    fact(
      `duplicate_${i + 1}`,
      "Possible duplicate charge (same shop, same amount, within 3 days)",
      `${d.first.merchant}, ${gbp(d.first.amount)}, on ${formatLongDate(d.first.date)} and ${formatLongDate(d.second.date)}`,
      [d.first.id, d.second.id],
    ),
  );
}

function priceChangeFacts(ctx: FactContext): Fact[] {
  const changes = findPriceChanges(ctx.txns);
  if (changes.length === 0) return [fact("no_price_changes", "Subscription price changes", "None found")];
  return changes.map((c, i) =>
    fact(
      `price_change_${i + 1}`,
      "Subscription price change",
      `${c.merchant} went ${c.change > 0 ? "up" : "down"} from ${gbp(c.before.amount)} to ${gbp(c.after.amount)} (${gbp(Math.abs(c.change))} ${c.change > 0 ? "more" : "less"}), charged on ${formatLongDate(c.after.date)}`,
      [c.before.id, c.after.id],
    ),
  );
}

function billFacts(intent: "days_until_due" | "minimum_payment", ctx: FactContext): Fact[] {
  const days = daysUntilDue(ctx.account, ctx.today);
  const when = days === 0 ? "Today" : days === 1 ? "1 day" : days > 0 ? `${days} days` : `Overdue by ${-days} days`;
  const due = fact("due_date", "Payment due date", formatLongDate(ctx.account.paymentDueDate));
  const left = fact("days_until_due", "Time until the payment is due", when);
  const bill = fact("statement_balance", "Full bill (statement balance)", gbp(ctx.account.statementBalance));
  const min = fact("minimum_payment", "Minimum payment", gbp(ctx.account.minimumPayment));
  return intent === "days_until_due" ? [due, left, bill, min] : [min, due, left, bill];
}

function spendPauseFacts(ctx: FactContext): Fact[] {
  const s = ctx.settings;
  const budget = budgetStatus(ctx.txns, s, ctx.today);
  const { thisMonth } = monthOverMonth(ctx.txns, ctx.today);
  const out: Fact[] = [fact("spend_pause_status", "Spend Pause", s.enabled ? "On" : "Off")];
  if (s.singlePurchaseThreshold !== null) out.push(fact("check_over", "Checks any single purchase over", gbp(s.singlePurchaseThreshold)));
  if (budget) {
    out.push(fact("monthly_budget", "Monthly budget", gbp(budget.budget)));
    out.push(fact("budget_spent", "Spent towards the budget this month", gbp(budget.spent), thisMonth.ids));
    out.push(
      budget.remaining >= 0
        ? fact("budget_left", "Left in the budget this month", gbp(budget.remaining), thisMonth.ids)
        : fact("budget_over", "Over the budget this month by", gbp(-budget.remaining), thisMonth.ids),
    );
  }
  if (s.quietHours) out.push(fact("quiet_hours", "Quiet hours", `${s.quietHours.start} to ${s.quietHours.end}`));

  const p = ctx.purchase;
  if (!p) return out;
  const d = evaluatePurchase(ctx.account, ctx.txns, s, p, ctx.now);
  out.push(fact("purchase", "Purchase being checked", `${gbp(p.amount)} at ${p.merchant} (${p.item})`));
  out.push(fact("pause_decision", "Dial's decision", d.shouldPause ? "Check with you first" : "Let it go through"));
  for (const r of d.reasons) {
    if (r === "over_threshold" && s.singlePurchaseThreshold !== null)
      out.push(fact("reason_over_threshold", "Reason", `${gbp(p.amount)} is over the ${gbp(s.singlePurchaseThreshold)} you asked us to check`));
    if (r === "over_budget" && d.budgetRemainingAfter !== null && s.monthlyBudget !== null)
      out.push(
        fact("reason_over_budget", "Reason", `It would take you ${gbp(-d.budgetRemainingAfter)} over your ${gbp(s.monthlyBudget)} monthly budget`, thisMonth.ids),
      );
    if (r === "quiet_hours" && s.quietHours)
      out.push(fact("reason_quiet_hours", "Reason", `It is during your quiet hours, ${s.quietHours.start} to ${s.quietHours.end}`));
  }
  out.push(fact("balance_after", "Balance after this purchase", gbp(d.balanceAfter)));
  out.push(fact("available_credit_after", "Available credit after this purchase", gbp(d.availableCreditAfter)));
  if (d.budgetRemainingAfter !== null)
    out.push(
      d.budgetRemainingAfter >= 0
        ? fact("budget_left_after", "Left in the budget after this purchase", gbp(d.budgetRemainingAfter), thisMonth.ids)
        : fact("budget_over_after", "Over the budget after this purchase by", gbp(-d.budgetRemainingAfter), thisMonth.ids),
    );
  return out;
}

const toRow = (t: Transaction): EvidenceRow => ({
  id: t.id,
  date: formatLongDate(t.date),
  merchant: t.merchant,
  amount: gbp(t.amount),
  status: t.status,
});

/** Facts for one intent, plus the evidence behind them. Deterministic: same context in, same facts out. */
export function buildFacts(intent: Intent, ctx: FactContext = seedContext()): FactSet {
  const facts =
    intent === "spend_this_month" || intent === "spend_last_month"
      ? spendingFacts(intent, ctx)
      : intent === "top_items"
        ? topItemFacts(ctx)
        : intent === "duplicates"
          ? duplicateFacts(ctx)
          : intent === "price_changes"
            ? priceChangeFacts(ctx)
            : intent === "days_until_due" || intent === "minimum_payment"
              ? billFacts(intent, ctx)
              : spendPauseFacts(ctx);

  const evidenceIds = [...new Set(facts.flatMap((f) => f.evidenceIds))];
  const byId = new Map(ctx.txns.map((t) => [t.id, t]));
  return { intent, asOf: ctx.today, facts, evidenceIds, evidence: evidenceIds.map((id) => toRow(byId.get(id)!)) };
}
