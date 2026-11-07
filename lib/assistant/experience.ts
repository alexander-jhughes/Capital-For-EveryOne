// Frontend side of the optional `experience` field on POST /api/ask (being added by the backend).
// The backend decides the template; the frontend only checks it against this allowlist and draws it.
// Nothing here infers an intent from the question: missing or invalid data means the general experience.

export const TEMPLATES = ["statement", "spending", "subscriptions", "transaction", "payment", "general"] as const;
export type ExperienceTemplate = (typeof TEMPLATES)[number];

export const EXPERIENCE_INTENTS = [
  "statement_balance",
  "spending_insights",
  "subscription_query",
  "transaction_investigation",
  "payment_planning",
  "general",
] as const;
export type ExperienceIntent = (typeof EXPERIENCE_INTENTS)[number];

export interface Experience {
  template: ExperienceTemplate;
  /** Null when the backend sent no intent or one outside the allowlist; the template still applies. */
  intent: ExperienceIntent | null;
}

export const GENERAL: Experience = { template: "general", intent: null };

/**
 * Reads `body.experience` defensively. Accepts `{ template, intent? }` with allowlisted strings;
 * anything else (missing, wrong type, unknown values) becomes the general experience. Never throws.
 */
export function parseExperience(raw: unknown): Experience {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return GENERAL;
  const { template, intent } = raw as Record<string, unknown>;
  if (typeof template !== "string" || !(TEMPLATES as readonly string[]).includes(template)) return GENERAL;
  const okIntent = typeof intent === "string" && (EXPERIENCE_INTENTS as readonly string[]).includes(intent);
  return { template: template as ExperienceTemplate, intent: okIntent ? (intent as ExperienceIntent) : null };
}
