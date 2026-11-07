// The trained model as stored in model.json, and the check that runs before it is ever used.
import { type Calibration, isValidCalibration } from "./calibration";
import { FEATURE_IDS } from "./features";
import { isValidTree, type Tree } from "./forest";
import { TARGET_IDS, type TargetId } from "./targets";

export const MODEL_FORMAT = "cfe-personalisation-forest";
/**
 * Format 1: model v1, the first 28 features, raw forest probabilities.
 * Format 2: all current features and a per-target calibration fitted on validation data.
 * Features are append-only, so a format-1 model reads exactly the values it was trained on.
 */
export const MODEL_FORMAT_VERSION = 2;
export const FORMAT_FEATURES: Record<1 | 2, string[]> = { 1: FEATURE_IDS.slice(0, 28), 2: FEATURE_IDS };

export interface TargetModel {
  /** Minimum CALIBRATED probability before Dial offers this. null: the model was not reliable enough for this target, so it is never offered. */
  threshold: number | null;
  /** Format 2: maps the forest's vote share to a calibrated probability, fitted on validation data only. Format 1 has none. */
  calibration?: Calibration;
  /** Share of eligible training people who kept this setting. */
  baseRate: number;
  trees: Tree[];
}

export interface ModelArtifact {
  format: typeof MODEL_FORMAT;
  formatVersion: 1 | 2;
  modelVersion: string;
  /** Always "synthetic" for now: no real people's data has been used. */
  trainedOn: "synthetic";
  generatorVersion: number;
  seed: number;
  /** Feature order the trees were trained with. Must match FORMAT_FEATURES for its format exactly. */
  features: string[];
  targets: Record<TargetId, TargetModel>;
}

/** Rejects anything that is not exactly a model this code can run: wrong format, feature drift, broken trees. */
export function isValidModel(m: unknown): m is ModelArtifact {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  if (o.format !== MODEL_FORMAT || (o.formatVersion !== 1 && o.formatVersion !== 2) || o.trainedOn !== "synthetic") return false;
  if (typeof o.modelVersion !== "string" || !o.modelVersion) return false;
  const expected = FORMAT_FEATURES[o.formatVersion];
  if (!Array.isArray(o.features) || o.features.length !== expected.length || o.features.some((f, i) => f !== expected[i])) return false;
  if (typeof o.targets !== "object" || o.targets === null) return false;
  const targets = o.targets as Record<string, unknown>;
  return TARGET_IDS.every((id) => {
    const t = targets[id] as Record<string, unknown> | undefined;
    if (!t || typeof t !== "object") return false;
    const th = t.threshold;
    if (!(th === null || (typeof th === "number" && th > 0 && th <= 1))) return false;
    if (typeof t.baseRate !== "number" || t.baseRate < 0 || t.baseRate > 1) return false;
    if (o.formatVersion === 2 ? !isValidCalibration(t.calibration) : t.calibration !== undefined) return false;
    return Array.isArray(t.trees) && t.trees.length > 0 && t.trees.every((tree) => isValidTree(tree, expected.length));
  });
}
