// Component 1: content-based. One L2-regularised logistic regression per item over the encoded features.
// Linear in the features, so every prediction splits exactly into per-feature contributions (w·x), which is
// where the "because you said …" explanations come from.
import { ITEM_COUNT, type PreparedExample } from "./data";
import { FEATURE_COUNT } from "./features";
import { fitLogistic, type LogisticRow } from "./logistic";
import { safeLogit } from "./math";

export interface ContentParams {
  /** Per item (catalog order). */
  intercept: number[];
  /** [item][feature] */
  weights: number[][];
}

export function trainContent(examples: readonly PreparedExample[], l2: number, priorRate: readonly number[]): ContentParams {
  const rowsByItem: LogisticRow[][] = Array.from({ length: ITEM_COUNT }, () => []);
  for (const e of examples) rowsByItem[e.item].push({ idx: e.x.idx, val: e.x.val, y: e.y, w: e.w });
  const intercept: number[] = [];
  const weights: number[][] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const rows = rowsByItem[i];
    if (rows.length === 0) {
      intercept.push(safeLogit(priorRate[i]));
      weights.push(new Array<number>(FEATURE_COUNT).fill(0));
      continue;
    }
    const fit = fitLogistic(rows, FEATURE_COUNT, { l2 });
    intercept.push(fit.intercept);
    weights.push(Array.from(fit.weights));
  }
  return { intercept, weights };
}
