// Hard-coded answers for the demo questions, used on an error, a timeout or a missing key.
// Only the wording is stored. Evidence always comes from the facts, and ask.ts re-checks each answer against them.
import type { Intent } from "../types";

interface CachedAnswer {
  intent: Intent;
  answer: string;
}

/** Normalised so case, punctuation and spacing don't cost a demo answer. */
export const cacheKey = (question: string) =>
  question.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export const DEMO_ANSWERS: Record<string, CachedAnswer> = {
  [cacheKey("Did I pay Tesco twice this month?")]: {
    intent: "duplicates",
    answer: "It looks like it: Tesco charged you £38.62 on Thursday 5 November and again on Friday 6 November.",
  },
  [cacheKey("What did I spend this month?")]: {
    intent: "spend_this_month",
    answer: "You have spent £402.35 so far this month.",
  },
  [cacheKey("Has any subscription gone up?")]: {
    intent: "price_changes",
    answer: "Yes, Netflix went up from £10.99 to £12.99.",
  },
  [cacheKey("When is my bill due?")]: {
    intent: "days_until_due",
    answer: "Your bill of £486.20 is due on Friday 13 November.",
  },
};

export const cachedAnswer = (question: string): CachedAnswer | null => DEMO_ANSWERS[cacheKey(question)] ?? null;
