// The trained model as stored in model.json, and the check that runs before it is ever used.
import { FEATURE_IDS } from "./features";
import { isValidTree, type Tree } from "./forest";
import { TARGET_IDS, type TargetId } from "./targets";

export const MODEL_FORMAT = "cfe-personalisation-forest";
export const MODEL_FORMAT_VERSION = 1;

export interface TargetModel {
  /** Minimum probability before Dial offers this. null: the model was not reliable enough for this target, so it is never offered. */
  threshold: number | null;
  /** Share of eligible training people who kept this setting. */
  baseRate: number;
  trees: Tree[];
}

export interface ModelArtifact {
  format: typeof MODEL_FORMAT;
  formatVersion: typeof MODEL_FORMAT_VERSION;
  modelVersion: string;
  /** Always "synthetic" for now: no real people's data has been used. */
  trainedOn: "synthetic";
  generatorVersion: number;
  seed: number;
  /** Feature order the trees were trained with. Must match features.ts exactly. */
  features: string[];
  targets: Record<TargetId, TargetModel>;
}

/** Rejects anything that is not exactly a model this code can run: wrong format, feature drift, broken trees. */
export function isValidModel(m: unknown): m is ModelArtifact {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  if (o.format !== MODEL_FORMAT || o.formatVersion !== MODEL_FORMAT_VERSION || o.trainedOn !== "synthetic") return false;
  if (typeof o.modelVersion !== "string" || !o.modelVersion) return false;
  if (!Array.isArray(o.features) || o.features.length !== FEATURE_IDS.length || o.features.some((f, i) => f !== FEATURE_IDS[i])) return false;
  if (typeof o.targets !== "object" || o.targets === null) return false;
  const targets = o.targets as Record<string, unknown>;
  return TARGET_IDS.every((id) => {
    const t = targets[id] as Record<string, unknown> | undefined;
    if (!t || typeof t !== "object") return false;
    const th = t.threshold;
    if (!(th === null || (typeof th === "number" && th > 0 && th <= 1))) return false;
    if (typeof t.baseRate !== "number" || t.baseRate < 0 || t.baseRate > 1) return false;
    return Array.isArray(t.trees) && t.trees.length > 0 && t.trees.every((tree) => isValidTree(tree, FEATURE_IDS.length));
  });
}
