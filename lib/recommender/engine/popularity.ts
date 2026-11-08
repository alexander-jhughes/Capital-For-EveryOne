// Component 4: popularity. Per-item keep rate over everyone, shrunk toward the overall keep rate with a Beta prior.
// The baseline every other component must beat, and the prior the others fall back to.
import { ITEM_COUNT, type PreparedExample } from "./data";

export interface PopularityParams {
  /** Posterior mean keep rate per item (catalog order). */
  rate: number[];
  /** Weighted number of examples per item. */
  count: number[];
}

export function trainPopularity(examples: readonly PreparedExample[], priorStrength: number): PopularityParams {
  const pos = new Float64Array(ITEM_COUNT);
  const tot = new Float64Array(ITEM_COUNT);
  let allPos = 0;
  let allTot = 0;
  for (const e of examples) {
    pos[e.item] += e.w * e.y;
    tot[e.item] += e.w;
    allPos += e.w * e.y;
    allTot += e.w;
  }
  const overall = (allPos + 1) / (allTot + 2);
  const rate: number[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) rate.push((pos[i] + priorStrength * overall) / (tot[i] + priorStrength));
  return { rate, count: Array.from(tot) };
}
