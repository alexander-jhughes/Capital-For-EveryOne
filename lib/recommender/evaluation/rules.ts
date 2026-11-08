// BASELINE ONLY. Maps "About you" answers onto the rules-based "Make it yours" choices, runs the published rule
// table (lib/preferences/recommend.ts, unchanged) and turns its output into catalogue items.
//
// The product never does this: "Make it yours" is only ever driven by the boxes a person ticks. This mapping exists
// so the rules system can be (1) one of the synthetic logging policies and (2) a baseline in the benchmark.
// Every mapping below is a judgement call written by us, documented in docs/ml-personalisation/v2/EVALUATION.md.
import type { UiAction } from "../../preferences/schema";
import { type ChoiceId, recommend } from "../../preferences/recommend";
import { conflicts, ITEM_IDS, type ItemId } from "../catalog";
import type { ProfileAnswers } from "../profile";

/** Answer -> "Make it yours" choice. Questions not listed (budgeting, answer length, screen reader) map to nothing. */
export const ANSWER_TO_CHOICE: readonly { when: (a: ProfileAnswers) => boolean; choice: ChoiceId; rule: string }[] = [
  { when: (a) => a.screenComplexity === "minimal", choice: "lessInfo", rule: "screenComplexity = minimal -> lessInfo" },
  { when: (a) => a.detailLevel === "keyFacts", choice: "lessInfo", rule: "detailLevel = keyFacts -> lessInfo" },
  { when: (a) => a.screenComplexity === "everything", choice: "moreDetail", rule: "screenComplexity = everything -> moreDetail" },
  { when: (a) => a.detailLevel === "everything", choice: "moreDetail", rule: "detailLevel = everything -> moreDetail" },
  { when: (a) => a.explanationFormat === "visual", choice: "moreVisual", rule: "explanationFormat = visual -> moreVisual" },
  { when: (a) => a.priority === "spending", choice: "moreVisual", rule: "priority = spending -> moreVisual" },
  { when: (a) => a.guidance === "guided", choice: "stepByStep", rule: "guidance = guided -> stepByStep" },
  { when: (a) => a.creditFamiliarity === "new" || a.appConfidence === "low", choice: "stepByStep", rule: "creditFamiliarity = new or appConfidence = low -> stepByStep" },
  { when: (a) => a.inputMode === "voice", choice: "voiceFirst", rule: "inputMode = voice -> voiceFirst" },
  { when: (a) => a.priority === "payments", choice: "paymentsProminent", rule: "priority = payments -> paymentsProminent" },
];

export function answersToChoices(answers: ProfileAnswers): ChoiceId[] {
  const out = new Set<ChoiceId>();
  for (const m of ANSWER_TO_CHOICE) if (m.when(answers)) out.add(m.choice);
  return [...out];
}

/** The catalogue item a preferences action corresponds to, if any. */
export function itemOfAction(a: UiAction): ItemId | null {
  switch (a.type) {
    case "density":
      return a.value === "calm" ? "density.calm" : null;
    case "textSize":
      return a.value === 125 ? "textSize.125" : a.value >= 150 ? "textSize.150" : null;
    case "contrast":
      return a.value === "high" ? "contrast.high" : null;
    case "spacing":
      return a.value === "roomy" ? "spacing.roomy" : null;
    case "motion":
      return a.value === "reduced" ? "motion.reduced" : null;
    case "targets":
      return a.value === "large" ? "targets.large" : null;
    case "explanations":
      return a.value === "stepByStep" ? "explanations.stepByStep" : null;
    case "voiceFirst":
      return a.value ? "voiceFirst.on" : null;
    case "moveToTop":
    case "emphasize": {
      const id = `homeFocus.${a.widget}`;
      return (ITEM_IDS as readonly string[]).includes(id) ? (id as ItemId) : null;
    }
    default:
      return null;
  }
}

/**
 * The rules system's suggestion as catalogue items, in the rule table's order (view, style preset, direct settings).
 * Conflicts are resolved the way the rule table does: direct settings win over the style preset.
 * Not capped and not filtered for eligibility: callers do that.
 */
export function rulesItems(answers: ProfileAnswers): ItemId[] {
  const rec = recommend(answersToChoices(answers));
  if (!rec) return [];
  const raw: ItemId[] = [rec.mode === "simple" ? "view.simple" : "view.detailed"];
  for (const a of rec.actions) {
    const item = itemOfAction(a);
    if (item && !raw.includes(item)) raw.push(item);
  }
  // Later entries (direct settings) win: walk backwards keeping compatible items, then restore the order.
  const kept: ItemId[] = [];
  for (let i = raw.length - 1; i >= 0; i--) if (!kept.some((k) => k === raw[i] || conflicts(k, raw[i]))) kept.push(raw[i]);
  return kept.reverse();
}
