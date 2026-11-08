// Turns the Stage 2 facts into the sentences people see and hear. The facts layer holds every figure.
import { buildFacts, type FactContext } from "../ai/facts";
import type { PendingPurchase } from "../types";

export interface PauseExplanation {
  /** "This £120.00 purchase is over the £100.00 you asked us to check, and would take you £22.35 over your £500.00 monthly budget." */
  sentence: string;
  reasons: string[];
  balanceAfter?: string;
  availableCreditAfter?: string;
  budget?: { label: string; value: string };
}

export function explainPause(ctx: FactContext, purchase: PendingPurchase): PauseExplanation {
  const facts = buildFacts("spend_pause", { ...ctx, purchase }).facts;
  const value = (key: string) => facts.find((f) => f.key === key)?.value;
  const reasons = facts.filter((f) => f.key.startsWith("reason_")).map((f) => f.value);

  const phrases = reasons.map((reason, i) => {
    const purchaseFirst = reason.replace(/^(£[\d,.]*\d) is over/, "This $1 purchase is over");
    if (i === 0) return purchaseFirst.replace(/^It would/, "This purchase would").replace(/^It is/, "This purchase is");
    return purchaseFirst.replace(/^It would/, "would").replace(/^It is/, "is");
  });
  const budget = facts.find((f) => f.key === "budget_left_after" || f.key === "budget_over_after");
  return {
    sentence: phrases.length > 0 ? `${phrases.join(", and ")}.` : "This purchase is ready for you to check.",
    reasons,
    balanceAfter: value("balance_after"),
    availableCreditAfter: value("available_credit_after"),
    budget: budget ? { label: budget.label, value: budget.value } : undefined,
  };
}
