// Ranking: from the items that passed policy and their thresholds, pick the compatible configuration (at most
// MAX_BUNDLE_SIZE items, no conflicts) that maximises Σ (probability − threshold), by exact enumeration (at most
// 16 items, so at most 2 516 subsets). Alternatives: a smaller "start small" configuration, one without the top
// item's dimension, then the next best.
import { describeActions } from "../../preferences/schema";
import { CATALOG, configurationActions, conflicts, type Dimension, isCompatible, ITEM_IDS, type ItemId, MAX_BUNDLE_SIZE } from "../catalog";
import type { Configuration, EvidenceLevel } from "../types";

export interface Candidate {
  item: ItemId;
  probability: number;
  threshold: number;
  evidence: EvidenceLevel;
}

export interface ScoredSet {
  items: ItemId[];
  score: number;
}

const EVIDENCE_RANK: Record<EvidenceLevel, number> = { insufficient: 0, limited: 1, moderate: 2, strong: 3 };
export const weakestEvidence = (levels: EvidenceLevel[]): EvidenceLevel =>
  levels.reduce((w, e) => (EVIDENCE_RANK[e] < EVIDENCE_RANK[w] ? e : w), "strong" as EvidenceLevel);

/**
 * True if `items` is a valid change from the current state: compatible with each other, and not contradicting a
 * setting already in effect that the configuration leaves in place (e.g. a calmer home screen while staying in
 * Detailed view).
 */
export function isValidChange(items: readonly ItemId[], active: readonly ItemId[]): boolean {
  if (!isCompatible(items)) return false;
  const changed = new Set<Dimension>(items.map((id) => CATALOG[id].dimension));
  for (const a of active) {
    if (changed.has(CATALOG[a].dimension)) continue;
    for (const id of items) if (conflicts(id, a)) return false;
  }
  return true;
}

/** True if adding `item` to `chosen` would contradict a chosen item or a setting left in effect (size aside). */
export function contradicts(item: ItemId, chosen: readonly ItemId[], active: readonly ItemId[]): boolean {
  if (chosen.some((c) => c !== item && conflicts(c, item))) return true;
  const changed = new Set<Dimension>([...chosen, item].map((id) => CATALOG[id].dimension));
  return active.some((a) => !changed.has(CATALOG[a].dimension) && conflicts(item, a));
}

/** Every valid configuration of the candidates, best first (score, then fewer items, then catalog order). */
export function enumerateConfigurations(candidates: readonly Candidate[], active: readonly ItemId[]): ScoredSet[] {
  const sorted = [...candidates].sort((a, b) => ITEM_IDS.indexOf(a.item) - ITEM_IDS.indexOf(b.item));
  const out: ScoredSet[] = [];
  const pick: Candidate[] = [];
  const walk = (start: number) => {
    for (let i = start; i < sorted.length; i++) {
      const c = sorted[i];
      if (pick.some((p) => conflicts(p.item, c.item))) continue;
      pick.push(c);
      const items = pick.map((p) => p.item);
      if (isValidChange(items, active)) out.push({ items, score: pick.reduce((s, p) => s + (p.probability - p.threshold), 0) });
      if (pick.length < MAX_BUNDLE_SIZE) walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  const key = (s: ScoredSet) => s.items.map((id) => String(ITEM_IDS.indexOf(id)).padStart(2, "0")).join(",");
  return out.sort((a, b) => b.score - a.score || a.items.length - b.items.length || key(a).localeCompare(key(b)));
}

/** The best configuration and up to `alternatives` distinct others. */
export function chooseConfigurations(candidates: readonly Candidate[], active: readonly ItemId[], alternatives: number): { best: ScoredSet | null; alternatives: ScoredSet[] } {
  const all = enumerateConfigurations(candidates, active);
  if (all.length === 0) return { best: null, alternatives: [] };
  const best = all[0];
  const same = (a: ScoredSet, b: ScoredSet) => a.items.length === b.items.length && a.items.every((id) => b.items.includes(id));
  const chosen: ScoredSet[] = [];
  const add = (s: ScoredSet | undefined) => {
    if (s && !same(s, best) && !chosen.some((c) => same(c, s))) chosen.push(s);
  };
  if (best.items.length > 1) add(all.find((s) => s.items.length === 1)); // start small
  const byMargin = new Map(candidates.map((c) => [c.item, c.probability - c.threshold]));
  const top = [...best.items].sort((a, b) => byMargin.get(b)! - byMargin.get(a)!)[0];
  const topDimension = CATALOG[top].dimension;
  add(all.find((s) => s.items.every((id) => CATALOG[id].dimension !== topDimension))); // without the top item's dimension
  for (const s of all) {
    if (chosen.length >= alternatives) break;
    add(s);
  }
  return { best, alternatives: chosen.slice(0, alternatives).sort((a, b) => b.score - a.score) };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const joinAnd = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/** "Larger text and less on the home screen". View names keep their capital. */
export function configurationTitle(items: readonly ItemId[]): string {
  const ordered = ITEM_IDS.filter((id) => items.includes(id));
  return joinAnd(ordered.map((id, i) => (i === 0 || CATALOG[id].dimension === "view" ? CATALOG[id].title : lowerFirst(CATALOG[id].title))));
}

/** "Would you like to switch to Simple view and make the text 125% of the standard size?" */
export function configurationOffer(items: readonly ItemId[]): string {
  const { actions, mode } = configurationActions(items);
  const view = mode === "simple" ? "switch to Simple view" : mode === "complex" ? "switch to Detailed view" : null;
  const rest = actions.length ? describeActions(actions) : "";
  const body = view && rest ? (rest.includes(" and ") ? `${view}, ${rest}` : `${view} and ${rest}`) : (view ?? rest);
  return `Would you like to ${body}?`;
}

export function toConfiguration(set: ScoredSet, byItem: ReadonlyMap<ItemId, Candidate>): Configuration {
  const items = ITEM_IDS.filter((id) => set.items.includes(id));
  const { actions, mode } = configurationActions(items);
  const members = items.map((id) => byItem.get(id)!);
  return {
    items,
    actions,
    ...(mode ? { mode } : {}),
    title: configurationTitle(items),
    offer: configurationOffer(items),
    confidence: Math.min(...members.map((m) => m.probability)),
    evidence: weakestEvidence(members.map((m) => m.evidence)),
  };
}
