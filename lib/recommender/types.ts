// Shared contracts for the collaborative recommender (Dial personalisation v2).
// Owned by the integration lead. Workstreams implement against these types; changing one is a contract change.
//
// Data flow:
//   browser (consent) ─► /api/personalisation/* ─► SQLite (lib/server) ─► recommend() (lib/recommender/engine)
//   eligible feedback ─► exportEligibleTrainingData() ─► training pipeline (scripts/recommender) ─► model registry
//
// Nothing here may carry money data, transactions, conversation text, audio or demographic answers.
import type { Preferences, UiAction } from "../preferences/schema";
import type { Mode } from "../types";
import type { Dimension, ItemId } from "./catalog";
import type { ProfileAnswers } from "./profile";

// ---------------------------------------------------------------------------------------------------------------
// Signals: counts of explicit actions only. No content, no timestamps exposed to the model, nothing financial.
// ---------------------------------------------------------------------------------------------------------------

export const SIGNAL_IDS = [
  "textLarger", // made the text bigger in Settings or by voice
  "textSmaller", // made the text smaller
  "lessOnScreen", // chose a calmer home screen or hid a section
  "moreDetail", // switched to Detailed view or showed more sections
  "moreVisual", // showed or moved the spending chart up
  "voiceSessions", // tapped to open Voice Mode (nothing said is recorded)
  "shorterAnswers", // explicitly asked for shorter answers (structured signal from the voice/Dial layer)
  "undoneChanges", // undid a display change
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];
export type Signals = Partial<Record<SignalId, number>>;
/** Counts are capped so one busy session cannot dominate. */
export const SIGNAL_CAP = 10;
export const isSignalId = (v: unknown): v is SignalId => typeof v === "string" && (SIGNAL_IDS as readonly string[]).includes(v);

/** Where an explicit change came from. Mirrors `ChangeSource` in lib/preferences/events.ts, plus onboarding. */
export type SignalSource = "settings" | "voice" | "style" | "onboarding" | "dial";

// ---------------------------------------------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------------------------------------------

/**
 * accepted: kept the whole suggestion. modified: kept some of it (keptItems) and left the rest.
 * rejected: "No thanks". dismissed: "Not now" (no label for training). reverted: undid a kept item later.
 */
export type FeedbackOutcome = "accepted" | "modified" | "rejected" | "dismissed" | "reverted";

/** One past answer by this person, for suppression ("don't ask again") and warm start. */
export interface HistoryEntry {
  item: ItemId;
  outcome: "accepted" | "rejected" | "reverted" | "dismissed";
  /** Epoch milliseconds. */
  at: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Recommender input: everything the model may read about one person. Nothing else.
// ---------------------------------------------------------------------------------------------------------------

export interface RecommenderInput {
  answers: ProfileAnswers;
  /** Current settings, already sanitized with lib/preferences/schema.ts `sanitize`. */
  preferences: Preferences;
  view: Mode;
  /** Dimensions the person set themselves. Never overridden or contradicted by a suggestion. */
  explicit: Dimension[];
  signals: Signals;
  /** This person's own past answers, newest last. Empty for a new person. */
  history: HistoryEntry[];
}

// ---------------------------------------------------------------------------------------------------------------
// Training data. Produced by the synthetic generator and by exportEligibleTrainingData(). Never stored as a copy.
// ---------------------------------------------------------------------------------------------------------------

export interface TrainingExample {
  /** Opaque id, unique within one dataset only. Never the stored subject id. */
  subject: string;
  /** The context when the suggestion was shown. `history` holds only answers given before it. */
  input: RecommenderInput;
  item: ItemId;
  /** 1: kept and not undone (and not rated unhelpful). 0: turned down, undone, or rated unhelpful. */
  label: 0 | 1;
  /** Sample weight (default 1). */
  weight: number;
  source: "synthetic" | "real";
}

// ---------------------------------------------------------------------------------------------------------------
// Recommender output
// ---------------------------------------------------------------------------------------------------------------

/** How much evidence stands behind a score: from the number of similar people with an answer on that item. */
export type EvidenceLevel = "strong" | "moderate" | "limited" | "insufficient";

export interface Reason {
  kind: "answer" | "setting" | "signal" | "similar_people" | "history";
  /** Plain English, about the person's own choices, never a statement about who they are. */
  text: string;
  /** Contribution to the score (log-odds or probability points), for ordering. */
  weight: number;
}

export interface ItemScore {
  item: ItemId;
  /** Calibrated probability that the person keeps it and it helps (0..1). */
  probability: number;
  evidence: EvidenceLevel;
  /** Effective number of similar people with an answer on this item. */
  support: number;
  /** Uncalibrated component scores (0..1), for transparency and evaluation. */
  components: { content: number; collaborative: number; factorization: number; prior: number };
  reasons: Reason[];
}

export interface Configuration {
  items: ItemId[];
  /** Preferences actions to preview (from catalog.configurationActions). */
  actions: UiAction[];
  mode?: Mode;
  /** "Larger text and a calmer home screen". */
  title: string;
  /** One-sentence offer, phrased as a question to the person. */
  offer: string;
  /** Conservative: the lowest item probability in the configuration. */
  confidence: number;
  evidence: EvidenceLevel;
}

export type WithheldReason =
  | "explicit" // the person set this themselves
  | "already_on"
  | "rejected" // turned down before (and not cooled down)
  | "cooldown" // "Not now" recently
  | "conflict" // contradicts an explicit setting or a better item
  | "below_threshold"
  | "insufficient_evidence";

export interface Warning {
  code: "synthetic_only" | "few_answers" | "limited_evidence" | "low_confidence" | "fatigue" | "model_unavailable";
  text: string;
}

export interface RecommendationResult {
  status: "ok" | "no_recommendation" | "insufficient_data" | "unavailable";
  modelVersion: string | null;
  trainedOn: "synthetic" | "synthetic+real" | null;
  configuration: Configuration | null;
  /** Up to 2 other compatible configurations, best first. */
  alternatives: Configuration[];
  /** Every eligible item, best first. Logged with the recommendation for later off-policy evaluation. */
  scores: ItemScore[];
  explanation: { summary: string; reasons: string[] };
  warnings: Warning[];
  withheld: { item: ItemId; reason: WithheldReason }[];
}

export interface RecommendOptions {
  /** Default 2. */
  alternatives?: number;
  /** Epoch milliseconds, for cooldowns. Default Date.now(). */
  now?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Model artifact header. The body is engine-specific; the engine validates the whole artifact.
// ---------------------------------------------------------------------------------------------------------------

export interface ModelHeader {
  format: "cfe-recommender";
  formatVersion: 1;
  /** e.g. "hybrid-2.0.0+syn.s20261108". Unique; also the model_versions primary key. */
  version: string;
  algorithm: string;
  trainedOn: "synthetic" | "synthetic+real";
  datasetVersion: string;
  /** Feature ids in order, so a model can't be used with a different encoding. */
  featureIds: string[];
  items: ItemId[];
}

// ---------------------------------------------------------------------------------------------------------------
// Database ↔ training pipeline (implemented in lib/server/personalisation, consumed by scripts/recommender)
// ---------------------------------------------------------------------------------------------------------------

export interface EligibilityCriteria {
  /** Both consents must be granted now: personalisation and collaborative learning. */
  requireCollaborativeConsent: true;
  /** Only feedback at least this old (lets the "undo" window settle). */
  minAgeHours: number;
  /** Only feedback newer than this (retention / drift). */
  maxAgeDays: number;
  /** Per-person cap, so no one person dominates a dataset. */
  maxExamplesPerSubject: number;
}

export interface EligibleExport {
  examples: TrainingExample[];
  subjects: number;
  sourcePeriod: { from: string | null; to: string | null };
  criteria: EligibilityCriteria;
  /** Records looked at but excluded, by reason (no consent, too new, invalid, over cap, duplicate...). */
  excluded: Record<string, number>;
}
