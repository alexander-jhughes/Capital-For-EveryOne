// Data-quality checks run on every training dataset before anything is trained (synthetic and real alike).
// Errors stop the run; warnings are reported. Pure: no I/O.
import { sanitize } from "../../preferences/schema";
import { CATALOG, isActive, isDimension, isItemId, ITEM_IDS, type ItemId } from "../catalog";
import { AGE_BANDS, isValidAnswers } from "../profile";
import { isSignalId, SIGNAL_CAP, type TrainingExample } from "../types";

export interface QualityOptions {
  /** Below this many labelled examples an item is flagged (warning). */
  minPerItem: number;
  /** Label rates outside [minRate, maxRate] are flagged (warning). */
  minRate: number;
  maxRate: number;
}

export const DEFAULT_QUALITY: QualityOptions = { minPerItem: 30, minRate: 0.02, maxRate: 0.98 };

export interface QualityReport {
  ok: boolean;
  examples: number;
  subjects: number;
  errors: string[];
  warnings: string[];
  /** Invalid examples by reason. */
  invalid: Record<string, number>;
  /** Exact duplicates (same subject, input, item and label). */
  duplicates: number;
  labelBalance: Record<ItemId, { n: number; positives: number; rate: number | null }>;
  /** Subjects found in more than one split (must be 0). */
  leakage: { trainValidation: number; trainTest: number; validationTest: number } | null;
}

const RESEARCH_KEYS = /"(ageBand|age|band|research|birthYear|gender|ethnicity)":/i;
const AGE_VALUES = AGE_BANDS.map((b) => `"${b}"`);
const OUTCOMES = new Set(["accepted", "rejected", "reverted", "dismissed"]);

/** Why one example is invalid, or null if it is valid. */
export function invalidReason(e: TrainingExample): string | null {
  if (typeof e !== "object" || e === null) return "not an object";
  if (typeof e.subject !== "string" || e.subject.length === 0) return "subject";
  if (!isItemId(e.item)) return "unknown item";
  if (e.label !== 0 && e.label !== 1) return "label";
  if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight <= 0) return "weight";
  if (e.source !== "synthetic" && e.source !== "real") return "source";
  const x = e.input;
  if (typeof x !== "object" || x === null) return "input";
  const keys = Object.keys(x).sort().join(",");
  if (keys !== "answers,explicit,history,preferences,signals,view") return "input keys";
  if (!isValidAnswers(x.answers)) return "answers";
  if (JSON.stringify(sanitize(x.preferences)) !== JSON.stringify(x.preferences)) return "preferences";
  if (x.view !== "simple" && x.view !== "complex") return "view";
  if (!Array.isArray(x.explicit) || !x.explicit.every(isDimension) || new Set(x.explicit).size !== x.explicit.length) return "explicit";
  if (typeof x.signals !== "object" || x.signals === null) return "signals";
  for (const [k, v] of Object.entries(x.signals)) if (!isSignalId(k) || typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SIGNAL_CAP) return "signals";
  if (!Array.isArray(x.history)) return "history";
  for (let i = 0; i < x.history.length; i++) {
    const h = x.history[i];
    if (!isItemId(h?.item) || !OUTCOMES.has(h.outcome) || typeof h.at !== "number" || !Number.isFinite(h.at)) return "history";
    if (i > 0 && h.at < x.history[i - 1].at) return "history order";
  }
  // Product policy: a suggestion is never made for something already on, or on a dimension the person set.
  if (isActive(e.item, x.preferences, x.view)) return "item already active";
  if (x.explicit.includes(CATALOG[e.item].dimension)) return "item on explicit dimension";
  return null;
}

/** True if research data (an age band, by key or value) appears anywhere in the example. */
export function containsResearchData(e: TrainingExample): boolean {
  const json = JSON.stringify(e);
  return RESEARCH_KEYS.test(json) || AGE_VALUES.some((v) => json.includes(v));
}

export interface Splits {
  train: readonly TrainingExample[];
  validation: readonly TrainingExample[];
  test: readonly TrainingExample[];
}

export function checkDataset(examples: readonly TrainingExample[], splits: Splits | null, options: QualityOptions = DEFAULT_QUALITY): QualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const invalid: Record<string, number> = {};
  let research = 0;
  const seen = new Set<string>();
  let duplicates = 0;
  const subjects = new Set<string>();
  const balance = Object.fromEntries(ITEM_IDS.map((id) => [id, { n: 0, positives: 0, rate: null as number | null }])) as QualityReport["labelBalance"];
  const inputJson = new WeakMap<object, string>();

  for (const e of examples) {
    const reason = invalidReason(e);
    if (reason) {
      invalid[reason] = (invalid[reason] ?? 0) + 1;
      continue;
    }
    // Inputs are shared between items of one suggestion: serialise each once.
    let json = inputJson.get(e.input);
    if (json === undefined) {
      json = JSON.stringify(e.input);
      inputJson.set(e.input, json);
      if (RESEARCH_KEYS.test(json) || AGE_VALUES.some((v) => json!.includes(v))) research++;
    }
    const key = `${e.subject}|${e.item}|${e.label}|${json}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
    subjects.add(e.subject);
    balance[e.item].n++;
    balance[e.item].positives += e.label;
  }
  for (const id of ITEM_IDS) {
    const b = balance[id];
    b.rate = b.n ? b.positives / b.n : null;
    if (b.n < options.minPerItem) warnings.push(`${id}: only ${b.n} labelled examples (minimum ${options.minPerItem})`);
    else if (b.rate! < options.minRate || b.rate! > options.maxRate) warnings.push(`${id}: label rate ${(b.rate! * 100).toFixed(1)}% is outside ${options.minRate * 100}-${options.maxRate * 100}%`);
  }
  const invalidTotal = Object.values(invalid).reduce((s, v) => s + v, 0);
  if (invalidTotal > 0) errors.push(`${invalidTotal} invalid examples: ${JSON.stringify(invalid)}`);
  if (research > 0) errors.push(`${research} inputs contain research data (age band): never allowed in training data`);
  if (duplicates > 0) warnings.push(`${duplicates} exact duplicate examples`);
  if (examples.length === 0) errors.push("no examples");

  let leakage: QualityReport["leakage"] = null;
  if (splits) {
    const s = (xs: readonly TrainingExample[]) => new Set(xs.map((e) => e.subject));
    const [a, b, c] = [s(splits.train), s(splits.validation), s(splits.test)];
    const overlap = (x: Set<string>, y: Set<string>) => [...x].filter((v) => y.has(v)).length;
    leakage = { trainValidation: overlap(a, b), trainTest: overlap(a, c), validationTest: overlap(b, c) };
    if (leakage.trainValidation + leakage.trainTest + leakage.validationTest > 0) errors.push(`split leakage: ${JSON.stringify(leakage)} subjects in more than one split`);
  }
  return { ok: errors.length === 0, examples: examples.length, subjects: subjects.size, errors, warnings, invalid, duplicates, labelBalance: balance, leakage };
}
