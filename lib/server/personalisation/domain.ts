// Shared rules for the personalisation store: allowlists, retention, and how feedback becomes history and labels.
// Pure: no I/O. Used by the per-subject repository (live suggestions) and the pipeline store (training export), so
// the two can never disagree about what a piece of feedback means.
import { isItemId, type ItemId } from "../../recommender/catalog";
import type { Configuration, EvidenceLevel, FeedbackOutcome, HistoryEntry, SignalSource } from "../../recommender/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bumped when the consent wording changes. Recorded with every consent event. */
export const CONSENT_POLICY_VERSION = "2026-11-v2";

export const RETENTION = {
  signalsMs: 180 * DAY_MS,
  recommendationsMs: 365 * DAY_MS,
  feedbackMs: 365 * DAY_MS,
  inactiveSubjectMs: 400 * DAY_MS,
} as const;

export const LIMITS = {
  /** Signals in one request. */
  signalsPerRequest: 20,
  /** Signals stored per subject per rolling 24 hours. More are accepted by HTTP but not stored. */
  signalsPerDay: 200,
  /** An open recommendation with the same content is re-used for this long. */
  dedupeWindowMs: DAY_MS,
  /** Newest past answers passed to the engine. */
  historyEntries: 200,
} as const;

// `Record<Union, true>` makes the compiler check each list is complete.
const SOURCE_SET: Record<SignalSource, true> = { settings: true, voice: true, style: true, onboarding: true, dial: true };
export const SIGNAL_SOURCES = Object.keys(SOURCE_SET) as SignalSource[];
export const isSignalSource = (v: unknown): v is SignalSource => typeof v === "string" && Object.hasOwn(SOURCE_SET, v);

const OUTCOME_SET: Record<FeedbackOutcome, true> = { accepted: true, modified: true, rejected: true, dismissed: true, reverted: true };
export const FEEDBACK_OUTCOMES = Object.keys(OUTCOME_SET) as FeedbackOutcome[];
export const isFeedbackOutcome = (v: unknown): v is FeedbackOutcome => typeof v === "string" && Object.hasOwn(OUTCOME_SET, v);

export type FeedbackVia = "card" | "undo" | "settings" | "reset";
const VIA_SET: Record<FeedbackVia, true> = { card: true, undo: true, settings: true, reset: true };
export const FEEDBACK_VIA = Object.keys(VIA_SET) as FeedbackVia[];
export const isFeedbackVia = (v: unknown): v is FeedbackVia => typeof v === "string" && Object.hasOwn(VIA_SET, v);

export type RecommendationStatus = "shown" | "accepted" | "modified" | "rejected" | "dismissed" | "reverted";
const STATUS_SET: Record<RecommendationStatus, true> = { shown: true, accepted: true, modified: true, rejected: true, dismissed: true, reverted: true };
export const RECOMMENDATION_STATUSES = Object.keys(STATUS_SET) as RecommendationStatus[];

const EVIDENCE_SET: Record<EvidenceLevel, true> = { strong: true, moderate: true, limited: true, insufficient: true };
export const EVIDENCE_LEVELS = Object.keys(EVIDENCE_SET) as EvidenceLevel[];
export const isEvidenceLevel = (v: unknown): v is EvidenceLevel => typeof v === "string" && Object.hasOwn(EVIDENCE_SET, v);

export type Satisfaction = -1 | 0 | 1;
export const isSatisfaction = (v: unknown): v is Satisfaction => v === -1 || v === 0 || v === 1;

/** The items a recommendation offered: the main configuration, then each alternative. */
export interface Offer {
  main: ItemId[];
  alternatives: ItemId[][];
}

export const offerOf = (configuration: Pick<Configuration, "items">, alternatives: readonly Pick<Configuration, "items">[]): Offer => ({
  main: configuration.items.filter(isItemId),
  alternatives: alternatives.map((a) => a.items.filter(isItemId)),
});

export const offeredItems = (offer: Offer): Set<ItemId> => new Set([...offer.main, ...offer.alternatives.flat()]);

export const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  return sa.size === new Set(b).size && [...sa].every((x) => b.includes(x));
};

/** One stored feedback row, decoded. */
export interface FeedbackRecord {
  outcome: FeedbackOutcome;
  items: ItemId[];
  via: FeedbackVia | null;
  satisfaction: Satisfaction | null;
  at: number;
}

export const isDecision = (o: FeedbackOutcome) => o !== "reverted";

/**
 * What one feedback row tells the engine about this person's past answers.
 * - accepted: each kept item. modified: kept items accepted, main-configuration items not kept rejected
 *   (alternative items not kept say nothing).
 * - rejected / dismissed: each item.
 * - reverted via undo or settings: "reverted". Reverted by a full reset: treated like "Not now" (a cooldown, not a
 *   rejection), because a reset says nothing about that one item.
 */
export function historyFromFeedback(f: FeedbackRecord, offer: Offer): HistoryEntry[] {
  const entry = (item: ItemId, outcome: HistoryEntry["outcome"]): HistoryEntry => ({ item, outcome, at: f.at });
  switch (f.outcome) {
    case "accepted":
      return f.items.map((i) => entry(i, "accepted"));
    case "modified":
      return [...f.items.map((i) => entry(i, "accepted")), ...offer.main.filter((i) => !f.items.includes(i)).map((i) => entry(i, "rejected"))];
    case "rejected":
      return f.items.map((i) => entry(i, "rejected"));
    case "dismissed":
      return f.items.map((i) => entry(i, "dismissed"));
    case "reverted":
      return f.items.map((i) => entry(i, f.via === "reset" ? "dismissed" : "reverted"));
  }
}

/** Items kept by a decision and not yet reverted. */
export function stillKept(feedback: readonly FeedbackRecord[]): ItemId[] {
  const decision = feedback.find((f) => isDecision(f.outcome));
  if (!decision || (decision.outcome !== "accepted" && decision.outcome !== "modified")) return [];
  const reverted = new Set(feedback.filter((f) => f.outcome === "reverted").flatMap((f) => f.items));
  return decision.items.filter((i) => !reverted.has(i));
}

export type LabelResult = { kind: "labels"; labels: Map<ItemId, 0 | 1>; unlabelled: number } | { kind: "none"; reason: "no_decision" | "dismissed" };

/**
 * Training labels for one recommendation (CONTRACT.md §8), from its feedback in time order.
 * 1: kept, not reverted via undo or settings, and not rated -1. 0: rejected, a main-configuration item left out of a
 * modified suggestion, reverted (not via reset), or kept but rated -1. No label: "Not now", alternative items not
 * kept, and items reverted by a reset.
 */
export function labelsFor(feedback: readonly FeedbackRecord[], offer: Offer): LabelResult {
  const decision = feedback.find((f) => isDecision(f.outcome));
  if (!decision) return { kind: "none", reason: "no_decision" };
  if (decision.outcome === "dismissed") return { kind: "none", reason: "dismissed" };
  const labels = new Map<ItemId, 0 | 1>();
  let unlabelled = 0;
  if (decision.outcome === "rejected") {
    for (const i of decision.items) labels.set(i, 0);
    return { kind: "labels", labels, unlabelled };
  }
  const unhelpful = decision.satisfaction === -1;
  for (const i of decision.items) labels.set(i, unhelpful ? 0 : 1);
  if (decision.outcome === "modified") for (const i of offer.main) if (!decision.items.includes(i)) labels.set(i, 0);
  for (const f of feedback) {
    if (f.outcome !== "reverted") continue;
    for (const i of f.items) {
      if (!decision.items.includes(i)) continue;
      if (f.via === "reset") {
        if (labels.delete(i)) unlabelled++;
      } else if (labels.has(i)) labels.set(i, 0);
    }
  }
  return { kind: "labels", labels, unlabelled };
}

export const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
