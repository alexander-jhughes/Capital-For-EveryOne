// Stage 3's view of the Stage 2 facts. buildFacts stays as it is; this adapts its output for answering.
// Both changes below are waiting on the facts.ts owner (PR #4). If they land there, delete this file and call buildFacts.
import { formatPence } from "../format";
import type { Fact, FactSet, Intent } from "../types";
import { buildFacts, type FactContext } from "./facts";

/** Background for a comparison. The figure can be quoted, but its transactions don't prove the answer. */
const CONTEXT_ONLY_FACTS = new Set(["same_days_last_month_total"]);
const BILL_INTENTS = new Set<Intent>(["days_until_due", "minimum_payment"]);

/** The facts for one intent, with evidence limited to what supports the answer and both balances available. */
export function answerFacts(intent: Intent, ctx: FactContext): FactSet {
  const set = buildFacts(intent, ctx);
  const currentBalance: Fact = {
    key: "current_balance",
    label: "Current balance (everything owed right now)",
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
