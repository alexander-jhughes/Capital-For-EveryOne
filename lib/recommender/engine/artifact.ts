// The serialised model: rounding (to keep it small) and thorough structural validation (so a corrupt or
// mismatched file can never be used). The artifact holds parameters and aggregates only: no examples, no subject
// ids, no cluster smaller than the training minimum, no per-person rows.
import { ITEM_IDS, ITEM_TAGS } from "../catalog";
import { FEATURE_COUNT, FEATURE_IDS } from "./features";
import { ITEM_COUNT } from "./data";
import { round4 } from "./math";
import { STACKER_INPUTS, type RecommenderModel } from "./model";

/** Deep copy with every number rounded to 4 significant digits. Integers below 10 000 are unchanged. */
export function roundDeep<T>(value: T): T {
  if (typeof value === "number") return round4(value) as T;
  if (Array.isArray(value)) return value.map(roundDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = roundDeep(v);
    return out as T;
  }
  return value;
}

export const artifactBytes = (m: RecommenderModel) => new TextEncoder().encode(JSON.stringify(m)).length;

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (lo: number, hi: number) => (v: unknown) => isNum(v) && v >= lo && v <= hi;
const any = (v: unknown) => isNum(v);
const nonNeg = inRange(0, Number.MAX_VALUE);
const prob = inRange(0, 1);

function isVector(v: unknown, length: number, ok: (x: unknown) => boolean = any): boolean {
  if (!Array.isArray(v) || v.length !== length) return false;
  for (const x of v) if (!ok(x)) return false;
  return true;
}

function isMatrix(v: unknown, rows: number, cols: number, ok: (x: unknown) => boolean = any): boolean {
  if (!Array.isArray(v) || v.length !== rows) return false;
  for (const row of v) if (!isVector(row, cols, ok)) return false;
  return true;
}

const sameStrings = (v: unknown, expected: readonly string[]) =>
  Array.isArray(v) && v.length === expected.length && v.every((x, i) => x === expected[i]);

const MAX_CLUSTERS = 2000;

function validHeader(m: Record<string, unknown>): boolean {
  return (
    m.format === "cfe-recommender" &&
    m.formatVersion === 1 &&
    typeof m.version === "string" &&
    m.version.length > 0 &&
    m.version.length <= 200 &&
    typeof m.algorithm === "string" &&
    m.algorithm.length > 0 &&
    (m.trainedOn === "synthetic" || m.trainedOn === "synthetic+real") &&
    typeof m.datasetVersion === "string" &&
    m.datasetVersion.length > 0 &&
    sameStrings(m.featureIds, FEATURE_IDS) &&
    sameStrings(m.items, ITEM_IDS)
  );
}

function validStats(s: unknown): boolean {
  if (!isObj(s)) return false;
  for (const key of ["trainExamples", "trainSubjects", "validationExamples", "validationSubjects", "clusters", "itemsWithThreshold"]) if (!nonNeg(s[key])) return false;
  for (const key of ["validationLogLoss", "validationEce"]) if (s[key] !== null && !nonNeg(s[key])) return false;
  return true;
}

function validCollaborative(c: unknown): boolean {
  if (!isObj(c)) return false;
  if (!(isNum(c.temperature) && c.temperature > 0) || !(isNum(c.priorStrength) && c.priorStrength > 0) || !nonNeg(c.historyClip)) return false;
  if (!isVector(c.simWeights, FEATURE_COUNT, nonNeg)) return false;
  if (!Array.isArray(c.centroids) || c.centroids.length > MAX_CLUSTERS) return false;
  const k = c.centroids.length;
  return (
    isMatrix(c.centroids, k, FEATURE_COUNT, inRange(-1, 1)) &&
    isMatrix(c.rate, k, ITEM_COUNT, prob) &&
    isMatrix(c.count, k, ITEM_COUNT, nonNeg) &&
    Array.isArray(c.coLift) &&
    c.coLift.length === ITEM_COUNT &&
    c.coLift.every((byOutcome) => isMatrix(byOutcome, 2, ITEM_COUNT))
  );
}

function validFactorization(f: unknown): boolean {
  if (!isObj(f)) return false;
  const k = f.factors;
  if (!(Number.isInteger(k) && (k as number) >= 1 && (k as number) <= 64)) return false;
  return (
    sameStrings(f.tags, ITEM_TAGS) &&
    isVector(f.featureBias, FEATURE_COUNT) &&
    isMatrix(f.featureEmb, FEATURE_COUNT, k as number) &&
    isVector(f.itemBias, ITEM_COUNT) &&
    isMatrix(f.itemEmb, ITEM_COUNT, k as number) &&
    isMatrix(f.tagEmb, ITEM_TAGS.length, k as number)
  );
}

/** Thorough structural check: right shapes, finite numbers, the same features and items as this code. */
export function isValidRecommenderModel(x: unknown): x is RecommenderModel {
  try {
    if (!isObj(x) || !validHeader(x)) return false;
    if (!isObj(x.hyper) || !Object.values(x.hyper).every(isNum)) return false;
    if (!validStats(x.stats)) return false;
    const pop = x.popularity;
    if (!isObj(pop) || !isVector(pop.rate, ITEM_COUNT, inRange(1e-9, 1 - 1e-9)) || !isVector(pop.count, ITEM_COUNT, nonNeg)) return false;
    const content = x.content;
    if (!isObj(content) || !isVector(content.intercept, ITEM_COUNT) || !isMatrix(content.weights, ITEM_COUNT, FEATURE_COUNT)) return false;
    if (!validCollaborative(x.collaborative) || !validFactorization(x.factorization)) return false;
    const st = x.stacker;
    if (!isObj(st) || !isVector(st.slopes, STACKER_INPUTS.length) || !isVector(st.intercepts, ITEM_COUNT)) return false;
    if (!Array.isArray(x.thresholds) || x.thresholds.length !== ITEM_COUNT) return false;
    for (const t of x.thresholds) if (t !== null && !(isNum(t) && t > 0 && t < 1)) return false;
    return true;
  } catch {
    return false;
  }
}
