// The structured result the UI can act on. See docs/AI-UI-CONTRACT.md.
// lib/types.ts is frozen, so these sit beside AskResponse. A client that ignores `experience` keeps working.
import type { AskResponse } from "../types";

export const ASK_INTENTS = ["statement_balance", "spending_insights", "subscription_query", "transaction_investigation", "payment_planning", "general"] as const;
export const TEMPLATES = ["statement", "spending", "subscriptions", "transaction", "payment", "general"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export type AskIntent = (typeof ASK_INTENTS)[number];
export type UiTemplate = (typeof TEMPLATES)[number];
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export interface Experience {
  template: UiTemplate;
  intent: AskIntent;
  confidence: Confidence;
  /** The period the answer covers, such as "November 2026". */
  periodLabel?: string;
}

export type OrchestratedResponse = AskResponse & { experience?: Experience };

/**
 * Agent 2. A fixed table, not a model decision: each intent has exactly one template, so nothing a model says can
 * choose a screen or put anything else on one.
 */
export const TEMPLATE_FOR_INTENT: Record<AskIntent, UiTemplate> = {
  statement_balance: "statement",
  spending_insights: "spending",
  subscription_query: "subscriptions",
  transaction_investigation: "transaction",
  payment_planning: "payment",
  general: "general",
};

const isOneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T => allowed.includes(value as T);

/** Accepts only a well-formed experience whose template matches its intent. Anything else is null. */
export function parseExperience(value: unknown): Experience | null {
  if (typeof value !== "object" || value === null) return null;
  const { template, intent, confidence, periodLabel } = value as Record<string, unknown>;
  if (!isOneOf(ASK_INTENTS, intent) || !isOneOf(TEMPLATES, template) || !isOneOf(CONFIDENCE_LEVELS, confidence)) return null;
  if (TEMPLATE_FOR_INTENT[intent] !== template) return null;
  if (periodLabel !== undefined && (typeof periodLabel !== "string" || periodLabel.trim() === "")) return null;
  return periodLabel === undefined ? { template, intent, confidence } : { template, intent, confidence, periodLabel };
}

/** The experience for an intent. If it can't be validated, the general template is the safe answer. */
export function selectExperience(intent: AskIntent, confidence: Confidence, periodLabel?: string): Experience {
  const candidate = { template: TEMPLATE_FOR_INTENT[intent], intent, confidence, ...(periodLabel ? { periodLabel } : {}) };
  return parseExperience(candidate) ?? { template: "general", intent: "general", confidence: "low" };
}
