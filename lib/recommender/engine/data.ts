// Training examples, encoded once. Only what the components need: the item, the label, the weight, the encoded
// input (sparse) and the person's own history (for item-to-item collaborative filtering).
import { isItemId, ITEM_IDS, type ItemId } from "../catalog";
import type { HistoryEntry, TrainingExample } from "../types";
import { encodeNormalised, FEATURE_COUNT, normaliseInput, type SparseRow, toSparse } from "./features";

export const ITEM_COUNT = ITEM_IDS.length;
export const ITEM_INDEX = new Map<ItemId, number>(ITEM_IDS.map((id, i) => [id, i]));

export interface PreparedExample {
  subject: string;
  item: number;
  y: 0 | 1;
  w: number;
  x: SparseRow;
  history: HistoryEntry[];
}

/** Drops malformed examples (unknown item, bad label). A missing or invalid weight counts as 1; weight 0 drops it. */
export function prepareExamples(examples: readonly TrainingExample[]): PreparedExample[] {
  const out: PreparedExample[] = [];
  const dense = new Float64Array(FEATURE_COUNT);
  for (const e of examples) {
    if (!e || !isItemId(e.item) || (e.label !== 0 && e.label !== 1)) continue;
    const w = typeof e.weight === "number" && Number.isFinite(e.weight) && e.weight >= 0 ? e.weight : 1;
    if (w === 0) continue;
    const n = normaliseInput(e.input);
    encodeNormalised(n, dense);
    out.push({ subject: String(e.subject), item: ITEM_INDEX.get(e.item)!, y: e.label, w, x: toSparse(dense), history: n.history });
  }
  return out;
}

export function toDense(row: SparseRow, out = new Float64Array(FEATURE_COUNT)): Float64Array {
  out.fill(0);
  for (let k = 0; k < row.idx.length; k++) out[row.idx[k]] = row.val[k];
  return out;
}

/** Examples grouped by subject, in first-seen order (deterministic). */
export function bySubject(examples: readonly PreparedExample[]): Map<string, PreparedExample[]> {
  const m = new Map<string, PreparedExample[]>();
  for (const e of examples) {
    const list = m.get(e.subject);
    if (list) list.push(e);
    else m.set(e.subject, [e]);
  }
  return m;
}

/** Splits subjects (not examples) into two groups, seeded and deterministic. */
export function splitSubjects(examples: readonly PreparedExample[], fraction: number, r: () => number): { a: PreparedExample[]; b: PreparedExample[] } {
  const groups = bySubject(examples);
  const a: PreparedExample[] = [];
  const b: PreparedExample[] = [];
  for (const list of groups.values()) (r() < fraction ? b : a).push(...list);
  return { a, b };
}
