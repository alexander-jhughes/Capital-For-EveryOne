// Stage 3's view of the Stage 2 facts. buildFacts stays as it is; this adapts its output for answering.
// The current balance and evidence changes are waiting on the facts.ts owner (PR #4).
import { monthOverMonth } from "../finance";
import { formatLongDate, formatPence } from "../format";
import type { Fact, FactSet, Intent } from "../types";
import { buildFacts, type FactContext } from "./facts";
import { categoryRank, merchantPeriod, namedCategories, pauseQuestion, transactionRefs, type AnswerIntent } from "./intent";
import { categoryFacts, merchantFacts, paymentFacts, refundFacts, SPEND_PAUSE_HOW, subscriptionFacts, topItemFacts, transactionFacts } from "./merchant-facts";

/** A FactSet that can also be about one shop. Same shape as Stage 2's, so everything downstream reads it the same way. */
export type AnswerFactSet = Omit<FactSet, "intent"> & { intent: AnswerIntent; merchant?: string };

/** Background for a comparison. The figure can be quoted, but its transactions don't prove the answer. */
const CONTEXT_ONLY_FACTS = new Set(["same_days_last_month_total"]);
const BILL_INTENTS = new Set<Intent>(["days_until_due", "minimum_payment"]);

/** Evidence is always the union of the facts, in fact order, and rows come from the transactions themselves. */
function withEvidence(base: Pick<AnswerFactSet, "intent" | "asOf" | "merchant">, facts: Fact[], ctx: FactContext): AnswerFactSet {
  const evidenceIds = [...new Set(facts.flatMap((f) => f.evidenceIds))];
  const byId = new Map(ctx.txns.map((t) => [t.id, t]));
  const evidence = evidenceIds.map((id) => {
    const t = byId.get(id)!;
    return { id, date: formatLongDate(t.date), merchant: t.merchant, amount: formatPence(t.amount), status: t.status };
  });
  return { ...base, facts, evidenceIds, evidence };
}

const OVERVIEW_KEYS = ["statement_balance", "due_date", "days_until_due", "minimum_payment", "current_balance", "month_to_date_total", "month_top_category"];

/**
 * The whole account in a few verified facts, for open questions like "tell me about my account". Every figure comes
 * from the same builders as the specific intents. No evidence rows: it's a summary, and each figure links elsewhere.
 */
export function overviewFacts(ctx: FactContext): AnswerFactSet {
  const pick = (set: AnswerFactSet) => set.facts.filter((f) => OVERVIEW_KEYS.includes(f.key));
  const flagged = [...answerFacts("duplicates", ctx).facts, ...answerFacts("price_changes", ctx).facts].filter((f) => f.key.startsWith("duplicate_") || f.key.startsWith("price_change_"));
  const facts: Fact[] = [
    ...pick(answerFacts("days_until_due", ctx, "how much do I owe")),
    { key: "available_credit", label: "Credit still available to spend", value: formatPence(Math.max(0, ctx.account.creditLimit - ctx.account.currentBalance)), evidenceIds: [] },
    { key: "credit_limit", label: "Credit limit", value: formatPence(ctx.account.creditLimit), evidenceIds: [] },
    ...pick(answerFacts("spend_this_month", ctx)),
    ...answerFacts("subscription_list", ctx).facts.filter((f) => f.key.startsWith("subscription_")),
    ...flagged,
  ].map((f) => ({ ...f, evidenceIds: [] }));
  const seen = new Set<string>();
  const unique = facts.filter((f) => !seen.has(f.key) && seen.add(f.key));
  return { intent: "account_overview", asOf: ctx.today, facts: unique, evidenceIds: [], evidence: [] };
}

/** The facts for one question, with evidence limited to what supports the answer and both balances available. */
export function answerFacts(intent: AnswerIntent, ctx: FactContext, question = "", merchant?: string, reference?: string): AnswerFactSet {
  if (intent === "account_overview") return overviewFacts(ctx);
  if (intent === "category_spending") {
    const categories = [...new Set(ctx.txns.filter((t) => t.category !== "Payments").map((t) => t.category))];
    const facts = categoryFacts(ctx, merchantPeriod(question) === "last_month" ? "last_month" : "this_month", categoryRank(question, categories), namedCategories(question, categories));
    return withEvidence({ intent, asOf: ctx.today }, facts, ctx);
  }
  if (intent === "payment_history") return withEvidence({ intent, asOf: ctx.today }, paymentFacts(ctx), ctx);
  if (intent === "subscription_list") return withEvidence({ intent, asOf: ctx.today }, subscriptionFacts(ctx), ctx);
  if (intent === "transaction_lookup") return withEvidence({ intent, asOf: ctx.today }, transactionFacts(ctx, reference ?? transactionRefs(question)[0]), ctx);
  if (intent === "merchant_refunds") return withEvidence({ intent, asOf: ctx.today, merchant }, refundFacts(ctx, merchant), ctx);
  if (intent === "merchant_transactions") {
    return withEvidence({ intent, asOf: ctx.today, merchant }, merchantFacts(ctx, merchant ?? "", merchantPeriod(question)), ctx);
  }

  const period = merchantPeriod(question);
  if (intent === "top_items" && period === "last_month") return withEvidence({ intent, asOf: ctx.today }, topItemFacts(ctx), ctx);

  // Stage 2 looks for duplicates across everything, so a question about one month only sees that month's rows.
  const range = period === "all" ? null : monthOverMonth(ctx.txns, ctx.today)[period === "this_month" ? "thisMonth" : "lastMonth"];
  const scoped = intent === "duplicates" && range ? { ...ctx, txns: ctx.txns.filter((t) => t.date >= range.from && t.date <= range.to) } : ctx;
  const set = buildFacts(intent, scoped);
  const currentBalance: Fact = {
    key: "current_balance",
    label: "Current balance (everything on the card right now, not all due yet)",
    value: formatPence(ctx.account.currentBalance),
    evidenceIds: [],
  };
  const lastPayment: Fact = {
    key: "last_payment",
    label: "Last payment made",
    value: `${formatPence(ctx.account.lastPayment.amount)}, on ${formatLongDate(ctx.account.lastPayment.date)}`,
    evidenceIds: [],
  };
  // Spend Pause answers are about settings, not transactions, so its budget figures carry no rows of evidence.
  // Stage 2 nets every refund off the total, pending ones too. Say so, so a pending refund is never read as arrived.
  const pendingRefund = (f: Fact) => f.key === "month_refunds" && f.evidenceIds.some((id) => ctx.txns.find((t) => t.id === id)?.status === "pending");
  const relabel = (f: Fact): Fact => (pendingRefund(f) ? { ...f, label: "Refunds this month, taken off the total, including a pending refund that has not arrived yet" } : f);
  const contextOnly = (key: string) => CONTEXT_ONLY_FACTS.has(key) || intent === "spend_pause";
  const howItWorks = intent === "spend_pause" && pauseQuestion(question) === "explain" ? SPEND_PAUSE_HOW.map((text, i): Fact => ({ key: `how_${i + 1}`, label: "How Spend Pause works", value: text, evidenceIds: [] })) : [];
  const facts = [
    ...set.facts.map(relabel).map((f) => (contextOnly(f.key) ? { ...f, evidenceIds: [] } : f)),
    ...howItWorks,
    ...(BILL_INTENTS.has(intent) ? [currentBalance, lastPayment] : []),
    // Said outright, because "your bill is due on Friday" is the natural sentence and it is wrong here.
    ...(BILL_INTENTS.has(intent) && ctx.account.statementBalance === 0
      ? [{ key: "nothing_due", label: "Due on this statement", value: "Nothing: the statement balance is £0.00, so there is no payment due", evidenceIds: [] }]
      : []),
  ];
  const evidenceIds = [...new Set(facts.flatMap((f) => f.evidenceIds))];
  const kept = new Set(evidenceIds);
  return { ...set, facts, evidenceIds, evidence: set.evidence.filter((row) => kept.has(row.id)) };
}
