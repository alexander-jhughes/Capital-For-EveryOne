// Who gets a sentence first: the precise on-device rules, or the situation model. Pure and deterministic.
//
// The precise rules (lib/voice/interpret.ts) are exact for commands: "undo", "go to settings", "read it out loud",
// "make the text bigger". The situation model is for people describing themselves. This decides between them without
// either one hijacking the other, and keeps money questions with the money code.
import { interpret, isQuestionText } from "../voice/interpret";
import type { Understanding } from "./understand";

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** Talking about themselves: "I", "my", "me". Commands rarely do ("make the text bigger"). */
const FIRST_PERSON = / (i|i'm|im|i've|ive|i'd|id|my|me|mine) /;
/** Words about the account. A sentence with these is a money question unless it is about money worries. */
const MONEY = / (bill|balance|spend|spent|spending|refund|refunds|payment|payments|pay|owe|transaction|transactions|charged|charge|purchase|purchases|bought|credit|budget|statement|subscription|subscriptions|minimum) /;

/**
 * Whether the situation model should be asked at all. Fast, so the model only runs when it could help.
 * Control words, page names and view changes always go to the precise rules.
 */
export function worthUnderstanding(text: string): boolean {
  const s = norm(text);
  if (s.trim().length === 0 || s.length > 300) return false;
  const exact = interpret(text);
  if (exact.kind === "control" || exact.kind === "navigate" || exact.kind === "mode") return false;
  // A plain question ("how much did I spend at night?") belongs to the money code.
  if (isQuestionText(text) && MONEY.test(s)) return false;
  return true;
}

/**
 * What to do with the model's answer, given what the precise rules made of the same sentence.
 *  - "adapt": offer the situation's changes now.
 *  - "rules": let the precise rules (and then the cloud model) handle it as before.
 *  - "maybe": only if the rules find nothing to do, offer the situation as a question.
 */
export function decide(text: string, u: Understanding): "adapt" | "maybe" | "rules" {
  if (u.kind !== "situations") return "rules";
  const s = norm(text);
  const aboutMoneyWorries = u.situations.includes("money_anxiety");
  // "My balance is giving me a headache" is about the balance, not about migraines.
  if (MONEY.test(s) && !aboutMoneyWorries) return "rules";
  // "Make the writing larger" is a command the precise rules do exactly; a situation would change more than asked.
  const exact = interpret(text);
  if (exact.kind === "ui" && !FIRST_PERSON.test(s)) return "rules";
  return u.confidence === "sure" ? "adapt" : "maybe";
}
