// How a new sentence starts a Dial turn: which words it corrects, what is then waiting for an answer, and whether Dial
// asks a question back instead of acting. Pure, so the rules between voice corrections and the accessibility layer's
// clarifying questions can be tested without React. Used by components/dial/session.tsx.
import { clarify } from "../access/clarify";
import { opensWithCorrection, splitCorrection } from "../voice/correction";

export interface TurnStart {
  /** The words this sentence corrects: from the voice engine (inside one utterance), or the question still in flight. */
  replaces?: string;
  /** What is waiting for its answer once this turn starts, so the next sentence can correct it. */
  inFlight: string | null;
  /** A question to ask back instead of acting (a vague or contradictory request), or null. */
  question: string | null;
}

export function startTurn(input: string, engineReplaces: string | undefined, inFlight: string | null): TurnStart {
  // "How much on food?" ... "actually, groceries" while the first is still with the backend: the context only learns a
  // question once its answer is back, so the correction is planned against the question it cuts off.
  const replaces = engineReplaces ?? (inFlight && opensWithCorrection(input) ? inFlight : undefined);
  // A correction is already a clear choice, so it never gets a question back (lib/access/clarify.ts).
  const question = replaces || splitCorrection(input) ? null : clarify(input);
  // A question back never reaches the backend, and the turn it replaces is cancelled: nothing is left to correct.
  if (question) return { question, inFlight: null };
  return { replaces, inFlight: replaces ? `${replaces}. ${input}` : input, question: null };
}
