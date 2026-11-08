// Agent 3: the deterministic check on every response, whichever path produced it. The finance layer and seed are
// the only authority. A model reply, a cached sentence and a template all pass through here before they are sent.
import type { AnswerFactSet } from "./answer-facts";
import type { FactContext } from "./facts";
import { checkAnswer, isCantTell } from "./guard";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const pass: ValidationResult = { ok: true };
const fail = (reason: string): ValidationResult => ({ ok: false, reason });

/** A fact saying nothing was found has no transactions behind it, and that's correct. */
export const foundNothing = (facts: AnswerFactSet) =>
  facts.facts.length === 0 || facts.facts.some((f) => f.key.startsWith("no_") || ((f.key === "month_to_date_total" || f.key === "last_month_total") && f.value === "£0.00")) ||
  (facts.intent === "category_spending" && facts.facts.every((f) => f.evidenceIds.length === 0 && (/, £0\.00$/.test(f.value) || f.key === "category_difference")));
const ACCOUNT_LEVEL = new Set<AnswerFactSet["intent"]>(["days_until_due", "minimum_payment", "spend_pause", "payment_history", "account_overview"]);

/** Evidence must be real transactions, and exactly the ones behind the facts. */
export function checkEvidence(evidenceIds: string[], facts: AnswerFactSet, ctx: FactContext): ValidationResult {
  const known = new Set(ctx.txns.map((t) => t.id));
  if (evidenceIds.some((id) => !known.has(id))) return fail("unknown evidence id");
  if (evidenceIds.length !== new Set(evidenceIds).size) return fail("repeated evidence id");
  const expected = new Set(facts.evidenceIds);
  if (evidenceIds.length !== expected.size || evidenceIds.some((id) => !expected.has(id))) return fail("evidence doesn't match the facts");
  if (evidenceIds.length === 0 && !ACCOUNT_LEVEL.has(facts.intent) && !foundNothing(facts)) return fail("missing evidence");
  return pass;
}

/** The final gate. "I can't tell" is always safe, and it carries no evidence. */
export function validateResponse(answer: string, evidenceIds: string[], facts: AnswerFactSet, ctx: FactContext, question: string): ValidationResult {
  if (isCantTell(answer)) return evidenceIds.length === 0 ? pass : fail("a non-answer can't carry evidence");
  const claims = checkAnswer(answer, facts, question);
  return claims.ok ? checkEvidence(evidenceIds, facts, ctx) : claims;
}
