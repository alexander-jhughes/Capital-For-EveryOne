// Stage 3's view of the Stage 2 facts. buildFacts stays as it is; this adapts its output for answering.
// The current balance and evidence changes are waiting on the facts.ts owner (PR #4).
import { formatLongDate, formatPence } from "../format";
import type { Fact, FactSet, Intent } from "../types";
import { buildFacts, type FactContext } from "./facts";
import { merchantPeriod, type AnswerIntent } from "./intent";
import { merchantFacts, refundFacts } from "./merchant-facts";

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

/** The facts for one question, with evidence limited to what supports the answer and both balances available. */
export function answerFacts(intent: AnswerIntent, ctx: FactContext, question = "", merchant?: string): AnswerFactSet {
  if (intent === "merchant_refunds") return withEvidence({ intent, asOf: ctx.today, merchant }, refundFacts(ctx, merchant), ctx);
  if (intent === "merchant_transactions") {
    return withEvidence({ intent, asOf: ctx.today, merchant }, merchantFacts(ctx, merchant ?? "", merchantPeriod(question)), ctx);
  }

  const set = buildFacts(intent, ctx);
  const currentBalance: Fact = {
    key: "current_balance",
    label: "Current balance (everything on the card right now, not all due yet)",
    value: formatPence(ctx.account.currentBalance),
    evidenceIds: [],
  };
  const facts = [
    ...set.facts.map((f) => (CONTEXT_ONLY_FACTS.has(f.key) ? { ...f, evidenceIds: [] } : f)),
    ...(BILL_INTENTS.has(intent) ? [currentBalance] : []),
  ];
  const evidenceIds = [...new Set(facts.flatMap((f) => f.evidenceIds))];
  const kept = new Set(evidenceIds);
  return { ...set, facts, evidenceIds, evidence: set.evidence.filter((row) => kept.has(row.id)) };
}
