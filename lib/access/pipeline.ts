// The whole on-device decision for one sentence, shared by Dial's session and the evaluation script so what is measured
// is exactly what runs. Rules-first routing (route.ts), meaning-based understanding (understand.ts), then the decision.
import type { Scope, SituationId } from "./catalogue";
import { decide, worthUnderstanding } from "./route";
import { understand, type Embed, type ExampleIndex } from "./understand";

export interface Adaptation {
  situations: SituationId[];
  scope: Scope;
  /** Offered as a question, and only when the precise rules had nothing else to do with the sentence. */
  tentative: boolean;
}

/**
 * What this sentence could adapt, if anything. A tentative result must only be offered when the precise rules found
 * nothing to do with the sentence (`offeredAdaptation` applies that rule for the session and the evaluation alike).
 */
export async function adaptationFor(text: string, brain: { embed: Embed; index: ExampleIndex }): Promise<Adaptation | null> {
  if (!worthUnderstanding(text)) return null;
  const u = await understand(text, brain.embed, brain.index);
  if (u.kind !== "situations") return null;
  const choice = decide(text, u);
  if (choice === "rules") return null;
  return { situations: u.situations, scope: u.scope, tentative: choice === "maybe" };
}

/** The rule for a tentative result: offered only when the precise rules had nothing to do. */
export const offeredAdaptation = (a: Adaptation | null, rulesGaveUp: boolean): Adaptation | null => (a && (!a.tentative || rulesGaveUp) ? a : null);
