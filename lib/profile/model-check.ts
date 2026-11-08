// Checks a loaded model file against this code's feature list and person types. No JSON import, so scripts can use it.
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
