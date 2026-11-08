// How the person's profile reaches Dial's answers. Wording only: every answer still goes through the same facts,
// guard and validator, so a style can make an answer plainer or shorter but can't change a figure in it.
// Kept apart from the model client so any provider (Gemini, Groq, ...) adds the same lines to its system prompt.
import type { AnswerStyle } from "../profile/infer";

/** Extra rules for the phrasing prompt, or "" when there's nothing to add. They never relax the base rules. */
export function styleInstruction(style: AnswerStyle | undefined): string {
  if (!style) return "";
  const lines = [
    style.plain && "- Use everyday words and short sentences. Say what a money term means the first time you use it.",
    style.brief && "- Keep it to one short sentence if the facts allow it.",
    style.stepByStep && "- Give the most important fact first, then one more fact per sentence.",
    style.gentle && "- Be calm and reassuring. Never judge, never hurry the person, and never mention debt problems unless asked.",
  ].filter(Boolean);
  return lines.length ? `\n\nThis person has asked for answers worded this way. These rules come after the rules above and never replace them:\n${lines.join("\n")}` : "";
}

/** Someone asking for help with money worries. Narrow on purpose: "What is my minimum payment?" is a lookup, not this. */
const HELP_PATTERNS = [
  /\b(free|impartial|independent)\b.{0,30}\b(help|advice|support|guidance)\b/i,
  /\b(where|who)\b.{0,20}\b(get|find|go for|turn to)\b.{0,20}\b(help|advice|support)\b/i,
  /\b(struggling|struggle) (with|to)\b/i,
  /\b(can'?t|cannot|can not|unable to) (afford|pay|keep up|make (my|the) payment)/i,
  /\b(debt|money) (help|advice|worries|problems?)\b/i,
  /\b(worried|anxious|stressed|scared) about (money|my debt|debt|paying|my bill|bills)\b/i,
  /\b(financial|money) (difficulty|difficulties|hardship|trouble)\b/i,
  /\bbehind (on|with) (my )?(bills|payments|repayments)\b/i,
];

export const isHelpRequest = (question: string) => HELP_PATTERNS.some((p) => p.test(question));

/** Names and websites only: no amounts, dates or phone numbers, so nothing here can be mistaken for an account figure. */
export const HELP_ANSWER =
  "You're not alone, and free, confidential help is available. MoneyHelper, National Debtline and StepChange all give free, impartial money and debt advice. If a payment is worrying you, it's best to talk to your card provider before it's due, so you can look at your options together.";

export const SIGNPOST_SENTENCE = "If money feels tight, free and confidential help is available from MoneyHelper, National Debtline or StepChange.";
