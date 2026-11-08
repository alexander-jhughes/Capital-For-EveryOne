// Production monitoring for the recommender: input drift (PSI against the training distribution stored with the
// model's evaluation) and feedback-bias checks on live acceptance (by rank position, evidence level and item).
// Reads aggregates only (the backend's monitoringSnapshot has no subject ids). Pure: no I/O.
import { activeItems, DIMENSIONS, type Dimension, ITEM_IDS, type ItemId } from "../catalog";
import { QUESTIONS, type QuestionId } from "../profile";
import type { Mode } from "../../types";
import type { RecommenderInput } from "../types";

/** Same shape as MonitoringSnapshot.inputs in lib/server/personalisation/pipeline-store.ts. */
export interface InputDistribution {
  snapshots: number;
  /** Per question: counts per answer value, plus "skipped". */
  answers: Record<QuestionId, Record<string, number>>;
  /** Snapshots in which each item was already in effect. */
  activeItems: Partial<Record<ItemId, number>>;
  view: Record<Mode, number>;
  /** Snapshots in which each dimension was explicit. */
  explicit: Partial<Record<Dimension, number>>;
}

/** Distribution over distinct input snapshots (one per suggestion shown, as the backend counts them). */
export function inputDistribution(inputs: Iterable<RecommenderInput>): InputDistribution {
  const answers = Object.fromEntries(QUESTIONS.map((q) => [q.id, Object.fromEntries([...q.options.map((o) => [o.value, 0]), ["skipped", 0]])])) as Record<QuestionId, Record<string, number>>;
  const active: Partial<Record<ItemId, number>> = {};
  const explicit: Partial<Record<Dimension, number>> = {};
  const view: Record<Mode, number> = { simple: 0, complex: 0 };
  const seen = new Set<RecommenderInput>();
  for (const x of inputs) {
    if (seen.has(x)) continue;
    seen.add(x);
    for (const q of QUESTIONS) answers[q.id][(x.answers as Record<string, string | undefined>)[q.id] ?? "skipped"]++;
    for (const id of activeItems(x.preferences, x.view)) active[id] = (active[id] ?? 0) + 1;
    for (const d of x.explicit) explicit[d] = (explicit[d] ?? 0) + 1;
    view[x.view]++;
  }
  const a: Partial<Record<ItemId, number>> = {};
  for (const id of ITEM_IDS) if (active[id]) a[id] = active[id];
  const e: Partial<Record<Dimension, number>> = {};
  for (const d of DIMENSIONS) if (explicit[d]) e[d] = explicit[d];
  return { snapshots: seen.size, answers, activeItems: a, view, explicit: e };
}

/**
 * Population stability index: Σ (a − e)·ln(a / e) over categories, with proportions floored at `eps`.
 * < 0.1 stable, 0.1-0.25 moderate shift, > 0.25 large shift (the usual rule of thumb).
 */
export function psi(expected: Record<string, number>, actual: Record<string, number>, eps = 1e-4): number {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const te = Object.values(expected).reduce((s, v) => s + v, 0);
  const ta = Object.values(actual).reduce((s, v) => s + v, 0);
  if (te === 0 || ta === 0) return 0;
  let s = 0;
  for (const k of keys) {
    const e = Math.max((expected[k] ?? 0) / te, eps);
    const a = Math.max((actual[k] ?? 0) / ta, eps);
    s += (a - e) * Math.log(a / e);
  }
  return s;
}

export interface DriftFeature {
  feature: string;
  psi: number;
  level: "stable" | "moderate" | "large";
}

export const DRIFT_THRESHOLDS = { moderate: 0.1, large: 0.25 };

const binary = (count: number | undefined, total: number) => ({ yes: count ?? 0, no: Math.max(0, total - (count ?? 0)) });

export function drift(training: InputDistribution, live: InputDistribution, thresholds = DRIFT_THRESHOLDS): { features: DriftFeature[]; max: DriftFeature | null; insufficient: boolean } {
  if (live.snapshots === 0 || training.snapshots === 0) return { features: [], max: null, insufficient: true };
  const level = (v: number): DriftFeature["level"] => (v > thresholds.large ? "large" : v > thresholds.moderate ? "moderate" : "stable");
  const out: DriftFeature[] = [];
  const add = (feature: string, e: Record<string, number>, a: Record<string, number>) => {
    const v = psi(e, a);
    out.push({ feature, psi: v, level: level(v) });
  };
  for (const q of QUESTIONS) add(`answer: ${q.id}`, training.answers[q.id] ?? {}, live.answers[q.id] ?? {});
  add("view", training.view, live.view);
  for (const id of ITEM_IDS) add(`active: ${id}`, binary(training.activeItems[id], training.snapshots), binary(live.activeItems[id], live.snapshots));
  for (const d of DIMENSIONS) add(`explicit: ${d}`, binary(training.explicit[d], training.snapshots), binary(live.explicit[d], live.snapshots));
  out.sort((a, b) => b.psi - a.psi);
  return { features: out, max: out[0] ?? null, insufficient: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Feedback bias
// ---------------------------------------------------------------------------------------------------------------

export interface RateCountLike {
  shown: number;
  kept: number;
  rate: number | null;
}

/** The parts of the backend's MonitoringSnapshot this module reads (it is assignable to this). */
export interface MonitoringSnapshotLike {
  since: string | null;
  recommendations: { total: number; byModel: Record<string, number> };
  acceptance: { overall: RateCountLike; byItem: Partial<Record<ItemId, RateCountLike>>; byEvidence: Record<string, RateCountLike>; byRank: RateCountLike[] };
  feedback: { byOutcome: Record<string, number>; satisfaction: { helpful: number; neutral: number; unhelpful: number } };
  inputs: InputDistribution;
}

/** What the model's evaluation stored about its training data, to compare live behaviour with. */
export interface MonitoringReference {
  inputs: InputDistribution;
  /** Share of shown items kept (before undo) in the training data. */
  keptRate: number;
  /** Kept rate by position of the item in the shown suggestion (0 = first). */
  keptRateByPosition: number[];
}

export const MONITORING_THRESHOLDS = {
  /** Minimum shown items before a rate is judged. */
  minShown: 30,
  /** Live kept rate this far below the training kept rate is flagged. */
  keptRateDrop: 0.15,
  /** Items kept less often than this are flagged. */
  minItemRate: 0.05,
  /** Unhelpful ratings above this share of ratings are flagged. */
  maxUnhelpfulShare: 0.3,
  /** Undo/settings reverts above this share of decisions are flagged. */
  maxRevertShare: 0.3,
  /** The two most suggested items above this share of suggestions: a self-reinforcing popularity loop. */
  maxTopTwoShare: 0.8,
};

export interface MonitoringReport {
  since: string | null;
  recommendations: number;
  drift: ReturnType<typeof drift>;
  acceptance: {
    overall: RateCountLike;
    byRank: RateCountLike[];
    byEvidence: Record<string, RateCountLike>;
    byItem: Partial<Record<ItemId, RateCountLike>>;
  };
  warnings: string[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function analyseMonitoring(snap: MonitoringSnapshotLike, reference: MonitoringReference | null, t = MONITORING_THRESHOLDS): MonitoringReport {
  const warnings: string[] = [];
  const d = reference ? drift(reference.inputs, snap.inputs) : { features: [], max: null, insufficient: true };
  for (const f of d.features) if (f.level !== "stable") warnings.push(`Input drift (${f.level}): ${f.feature} PSI ${f.psi.toFixed(3)}`);
  if (!reference) warnings.push("No training distribution stored with the active model: drift cannot be measured");

  const a = snap.acceptance;
  const enough = (r: RateCountLike | undefined): r is RateCountLike & { rate: number } => !!r && r.shown >= t.minShown && r.rate !== null;
  if (reference && enough(a.overall) && a.overall.rate < reference.keptRate - t.keptRateDrop)
    warnings.push(`Kept rate ${pct(a.overall.rate)} is more than ${pct(t.keptRateDrop)} below the training data's ${pct(reference.keptRate)}`);
  const [r1, r2] = a.byRank;
  if (enough(r1) && enough(r2) && r2.rate > r1.rate) warnings.push(`Rank 2 is kept more often than rank 1 (${pct(r2.rate)} vs ${pct(r1.rate)}): ranking or position bias`);
  const strong = a.byEvidence.strong;
  const weak = a.byEvidence.limited;
  if (enough(strong) && enough(weak) && weak.rate > strong.rate) warnings.push(`"limited" evidence suggestions are kept more often than "strong" ones (${pct(weak.rate)} vs ${pct(strong.rate)}): evidence levels are not informative`);
  for (const id of ITEM_IDS) {
    const r = a.byItem[id];
    if (enough(r) && r.rate < t.minItemRate) warnings.push(`${id} is kept only ${pct(r.rate)} of the time (${r.shown} shown): consider withholding it`);
  }
  const shownTotal = Object.values(a.byItem).reduce((s, r) => s + (r?.shown ?? 0), 0);
  const topTwo = Object.values(a.byItem)
    .map((r) => r?.shown ?? 0)
    .sort((x, y) => y - x)
    .slice(0, 2)
    .reduce((s, v) => s + v, 0);
  if (shownTotal >= t.minShown && topTwo / shownTotal > t.maxTopTwoShare) warnings.push(`Two items make up ${pct(topTwo / shownTotal)} of suggestions: possible popularity feedback loop`);

  const s = snap.feedback.satisfaction;
  const ratings = s.helpful + s.neutral + s.unhelpful;
  if (ratings >= t.minShown && s.unhelpful / ratings > t.maxUnhelpfulShare) warnings.push(`${pct(s.unhelpful / ratings)} of ratings say the change did not make Dial easier to use`);
  const o = snap.feedback.byOutcome;
  const decisions = (o.accepted ?? 0) + (o.modified ?? 0) + (o.rejected ?? 0);
  if (decisions >= t.minShown && (o.reverted ?? 0) / decisions > t.maxRevertShare) warnings.push(`Undone suggestions are ${pct((o.reverted ?? 0) / decisions)} of decisions`);

  return { since: snap.since, recommendations: snap.recommendations.total, drift: d, acceptance: { overall: a.overall, byRank: a.byRank, byEvidence: a.byEvidence, byItem: a.byItem }, warnings };
}
