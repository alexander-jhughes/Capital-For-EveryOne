// The committed, trained profile model, checked once when first used so a hand-edited or stale file fails closed.
import raw from "./model.json";
import { PERSON_TYPES } from "./catalog";
import { FEATURE_NAMES } from "./features";
import type { ProfileModel } from "./train";

export function checkModel(m: unknown): ProfileModel | null {
  const o = m as ProfileModel;
  if (typeof o !== "object" || o === null || typeof o.version !== "string") return null;
  if (JSON.stringify(o.classes) !== JSON.stringify(PERSON_TYPES) || JSON.stringify(o.features) !== JSON.stringify(FEATURE_NAMES)) return null;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!Array.isArray(o.weights) || o.weights.length !== PERSON_TYPES.length) return null;
  if (!o.weights.every((w) => Array.isArray(w) && w.length === FEATURE_NAMES.length && w.every(finite))) return null;
  if (!Array.isArray(o.bias) || o.bias.length !== PERSON_TYPES.length || !o.bias.every(finite)) return null;
  if (!finite(o.threshold) || o.threshold <= 0 || o.threshold >= 1) return null;
  return o;
}

let cached: ProfileModel | null | undefined;

/** The trained model, or null if the file doesn't match this code. The app then shows no type rather than a wrong one. */
export function profileModel(): ProfileModel | null {
  if (cached === undefined) {
    cached = checkModel(raw);
    if (!cached) console.warn("[profile] model.json doesn't match the feature list, so no person type will be shown. Retrain with scripts/profile/train.ts.");
  }
  return cached;
}
