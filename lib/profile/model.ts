// The committed, trained profile model, checked once when first used so a hand-edited or stale file fails closed.
import raw from "./model.json";
import { checkModel } from "./model-check";
import type { ProfileModel } from "./train";

export { checkModel };

let cached: ProfileModel | null | undefined;

/** The trained model, or null if the file doesn't match this code. The app then shows no type rather than a wrong one. */
export function profileModel(): ProfileModel | null {
  if (cached === undefined) {
    cached = checkModel(raw);
    if (!cached) console.warn("[profile] model.json doesn't match the feature list, so no person type will be shown. Retrain with scripts/profile/train.ts.");
  }
  return cached;
}
