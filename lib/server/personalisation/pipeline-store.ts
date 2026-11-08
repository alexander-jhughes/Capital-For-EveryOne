// Backend → training pipeline (CONTRACT.md §7). The training scripts and the model registry use only this file.
//
// Nothing here returns a stored subject id. The training export gives each subject a fresh random id per export,
// reads only subjects with personalisation AND collaborative consent granted at the time of the export, and never
// reads `user_research`. Datasets are never stored as copies: only their metadata (counts, criteria, hash).
import { randomUUID } from "node:crypto";
import { activeItems, DIMENSIONS, isDimension, isItemId, type Dimension, type ItemId } from "../../recommender/catalog";
import { isValidAnswers, QUESTIONS, type ProfileAnswers, type QuestionId } from "../../recommender/profile";
import { isSignalId, SIGNAL_CAP, type EligibilityCriteria, type EligibleExport, type EvidenceLevel, type FeedbackOutcome, type ItemScore, type Signals, type TrainingExample } from "../../recommender/types";
import { sanitize } from "../../preferences/schema";
import type { Mode } from "../../types";
import { execute, parseJson, queryAll, queryOne } from "../db/query";
import { openDatabase as openDb, transaction, type Database } from "../db/sqlite";
import {
  EVIDENCE_LEVELS,
  FEEDBACK_OUTCOMES,
  historyFromFeedback,
  isDecision,
  isEvidenceLevel,
  iso,
  labelsFor,
  LIMITS,
  offerOf,
  RECOMMENDATION_STATUSES,
  RETENTION,
  type FeedbackRecord,
  type FeedbackVia,
  type Offer,
  type RecommendationStatus,
} from "./domain";
import { decodeFeedback, type InputSnapshot } from "./repository";

export type { Database };

/** Opens the database (default `PERSONALISATION_DB_PATH` or `.data/personalisation.sqlite`) and runs migrations. */
export const openDatabase = (path?: string): Database => openDb(path);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ------------------------------------------------------------------------------------------------------------------
// Types shared with the training pipeline
// ------------------------------------------------------------------------------------------------------------------

/** One training dataset's description. The dataset itself is never stored. */
export interface DatasetMetadata {
  /** Unique, e.g. "syn-20261108.s42" or "real-20261201". Primary key of learning_datasets. */
  version: string;
  /** ISO timestamps of the oldest and newest real record, or nulls for synthetic-only data. */
  sourcePeriod: { from: string | null; to: string | null };
  /** Real records (recommendations with a usable answer) included. */
  eligibleRecords: number;
  /** Distinct real people included. */
  eligibleSubjects: number;
  /** Synthetic records included. */
  syntheticRecords: number;
  /** Records looked at but left out, by reason (see EXCLUSION_REASONS). */
  excluded: Record<string, number>;
  /** The eligibility criteria used, or the generator settings for synthetic data. */
  criteria: EligibilityCriteria | Record<string, unknown>;
  /** Version of the feature/preprocessing code. */
  preprocessingVersion: string;
  /** sha256 (hex) of the dataset content in a canonical form, so a run can be reproduced and checked. */
  contentSha256: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export type ModelStatus = "candidate" | "active" | "retired" | "rejected";

export interface ModelRecordInput {
  /** The artifact's `version` (ModelHeader.version). Primary key of model_versions. */
  version: string;
  /** Must already be registered with registerDataset. */
  datasetVersion: string;
  algorithm: string;
  trainedOn: "synthetic" | "synthetic+real";
  /** Hyper-parameters and seed. */
  config: Record<string, unknown>;
  /** Evaluation results (including fairness checks). */
  metrics: Record<string, unknown>;
  /** JSON artifact file, absolute or relative to the working directory. Null for the model bundled with the app. */
  artifactPath: string | null;
  /** sha256 (hex) of the artifact file's bytes, or of JSON.stringify(model) for the bundled model. */
  artifactSha256: string;
  sizeBytes: number;
  /** Epoch milliseconds. */
  createdAt: number;
  notes?: string | null;
}

export interface ModelRecord extends Omit<ModelRecordInput, "notes"> {
  status: ModelStatus;
  activatedAt: number | null;
  retiredAt: number | null;
  /** The model that was active before this one was activated: where rollbackModel goes. */
  rollbackTo: string | null;
  notes: string | null;
}

export interface RateCount {
  shown: number;
  kept: number;
  /** kept / shown, or null when nothing was shown. */
  rate: number | null;
}

/** Aggregates only. No subject ids, no recommendation ids, no free text. */
export interface MonitoringSnapshot {
  since: string | null;
  recommendations: { total: number; byStatus: Record<RecommendationStatus, number>; byModel: Record<string, number> };
  /** Over recommendations that have an answer. "kept": accepted or modified (even if later undone). */
  acceptance: {
    overall: RateCount;
    /** Main-configuration items. */
    byItem: Partial<Record<ItemId, RateCount>>;
    byEvidence: Record<EvidenceLevel, RateCount>;
    /** Index 0 is rank 1: the item's position in the ranked scores when it was suggested. */
    byRank: RateCount[];
  };
  feedback: {
    byOutcome: Record<FeedbackOutcome, number>;
    revertedVia: Record<FeedbackVia | "unspecified", number>;
    satisfaction: { helpful: number; neutral: number; unhelpful: number };
  };
  /** Input feature distributions over the stored snapshots (counts of recommendations). */
  inputs: {
    snapshots: number;
    answers: Record<QuestionId, Record<string, number>>;
    activeItems: Partial<Record<ItemId, number>>;
    view: Record<Mode, number>;
    explicit: Partial<Record<Dimension, number>>;
  };
}

/**
 * Exclusion reasons in EligibleExport.excluded / DatasetMetadata.excluded, and their unit.
 * A "record" is one recommendation that has an answer.
 */
export const EXCLUSION_REASONS = {
  no_consent: "records of people without personalisation and collaborative consent now",
  too_new: "records answered less than minAgeHours ago (the undo window)",
  too_old: "records answered more than maxAgeDays ago",
  invalid: "records whose stored snapshot or items no longer validate",
  no_label: "records with no usable label (\"Not now\", or every kept item undone by a reset)",
  reset: "items left unlabelled because they were undone by a reset",
  duplicate: "examples identical to one already in the export (same person, input, item and label)",
  over_cap: "examples over maxExamplesPerSubject (the oldest are dropped)",
} as const;

// ------------------------------------------------------------------------------------------------------------------
// Training export
// ------------------------------------------------------------------------------------------------------------------

function decodeSnapshot(text: string): InputSnapshot | null {
  const o = parseJson<Record<string, unknown> | null>(text, null);
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (!isValidAnswers(o.answers)) return null;
  if (typeof o.preferences !== "object" || o.preferences === null) return null;
  if (o.view !== "simple" && o.view !== "complex") return null;
  if (!Array.isArray(o.explicit) || !o.explicit.every(isDimension)) return null;
  const raw = typeof o.signals === "object" && o.signals !== null ? (o.signals as Record<string, unknown>) : null;
  if (!raw) return null;
  const signals: Signals = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isSignalId(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    if (v > 0) signals[k] = Math.min(Math.round(v), SIGNAL_CAP);
  }
  return { answers: o.answers as ProfileAnswers, preferences: sanitize(o.preferences), view: o.view, explicit: [...new Set(o.explicit as Dimension[])], signals };
}

interface ExportRecRow {
  id: string;
  configuration: string;
  alternatives: string;
  input_snapshot: string;
  created_at: number;
}

interface ExportFeedbackRow {
  recommendation_id: string;
  outcome: FeedbackOutcome;
  items: string;
  via: FeedbackVia | null;
  satisfaction: -1 | 0 | 1 | null;
  created_at: number;
}

function checkCriteria(c: EligibilityCriteria) {
  const ok =
    c.requireCollaborativeConsent === true &&
    Number.isFinite(c.minAgeHours) &&
    c.minAgeHours >= 0 &&
    Number.isFinite(c.maxAgeDays) &&
    c.maxAgeDays > 0 &&
    Number.isInteger(c.maxExamplesPerSubject) &&
    c.maxExamplesPerSubject > 0;
  if (!ok) throw new Error("Invalid eligibility criteria");
}

/**
 * The real training examples that may be used now (CONTRACT.md §8). Read-only: the database is not changed.
 * Run purgeExpired first so expired data is gone before anything is read.
 */
export function exportEligibleTrainingData(db: Database, criteria: EligibilityCriteria, now: number): EligibleExport {
  checkCriteria(criteria);
  const newest = now - criteria.minAgeHours * HOUR_MS;
  const oldest = now - criteria.maxAgeDays * DAY_MS;
  const excluded: Record<keyof typeof EXCLUSION_REASONS, number> = { no_consent: 0, too_new: 0, too_old: 0, invalid: 0, no_label: 0, reset: 0, duplicate: 0, over_cap: 0 };

  // Counted without reading anything about the people concerned.
  excluded.no_consent =
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM recommendations r
       WHERE r.status <> 'shown'
         AND NOT EXISTS (SELECT 1 FROM user_profiles p WHERE p.subject_id = r.subject_id
                         AND p.personalisation_consent = 'granted' AND p.collaborative_consent = 'granted')`,
    )?.n ?? 0;

  const subjects = queryAll<{ subject_id: string }>(
    db,
    "SELECT subject_id FROM user_profiles WHERE personalisation_consent = 'granted' AND collaborative_consent = 'granted'",
  ).map((r) => r.subject_id);

  type Timed = TrainingExample & { at: number };
  const all: Timed[] = [];
  const included = new Set<string>();
  let from: number | null = null;
  let to: number | null = null;

  for (const subjectId of subjects) {
    const recs = queryAll<ExportRecRow>(db, "SELECT id, configuration, alternatives, input_snapshot, created_at FROM recommendations WHERE subject_id = ? ORDER BY created_at, id", subjectId);
    const feedback = queryAll<ExportFeedbackRow>(
      db,
      "SELECT recommendation_id, outcome, items, via, satisfaction, created_at FROM recommendation_feedback WHERE subject_id = ? ORDER BY created_at, id",
      subjectId,
    );
    const offers = new Map<string, Offer | null>();
    for (const r of recs) {
      const configuration = parseJson<{ items?: unknown }>(r.configuration, {});
      const alternatives = parseJson<unknown>(r.alternatives, []);
      const valid =
        Array.isArray(configuration.items) &&
        configuration.items.every(isItemId) &&
        Array.isArray(alternatives) &&
        alternatives.every((a) => Array.isArray((a as { items?: unknown })?.items) && (a as { items: unknown[] }).items.every(isItemId));
      offers.set(r.id, valid ? offerOf(configuration as { items: ItemId[] }, alternatives as { items: ItemId[] }[]) : null);
    }
    const decoded = feedback.map((f) => ({ recommendationId: f.recommendation_id, record: decodeFeedback(f) }));
    const pseudo = randomUUID();
    const mine: Timed[] = [];

    for (const r of recs) {
      const fb: FeedbackRecord[] = decoded.filter((d) => d.recommendationId === r.id).map((d) => d.record);
      const decision = fb.find((f) => isDecision(f.outcome));
      if (!decision) continue; // still open: not a record yet
      if (decision.at > newest) {
        excluded.too_new++;
        continue;
      }
      if (decision.at < oldest) {
        excluded.too_old++;
        continue;
      }
      const offer = offers.get(r.id);
      const snapshot = decodeSnapshot(r.input_snapshot);
      if (!offer || !snapshot) {
        excluded.invalid++;
        continue;
      }
      const result = labelsFor(fb, offer);
      if (result.kind === "none" || result.labels.size === 0) {
        excluded.no_label++;
        if (result.kind === "labels") excluded.reset += result.unlabelled;
        continue;
      }
      excluded.reset += result.unlabelled;
      // Point in time: only answers this person gave before this suggestion was made.
      const history = decoded
        .filter((d) => d.record.at < r.created_at)
        .flatMap((d) => {
          const o = offers.get(d.recommendationId);
          return o ? historyFromFeedback(d.record, o) : [];
        })
        .slice(-LIMITS.historyEntries);
      const input = { ...snapshot, history };
      for (const [item, label] of result.labels) mine.push({ subject: pseudo, input, item, label, weight: 1, source: "real", at: decision.at });
    }

    const seen = new Set<string>();
    const unique = mine.filter((e) => {
      const key = `${e.item}|${e.label}|${JSON.stringify(e.input)}`;
      if (seen.has(key)) {
        excluded.duplicate++;
        return false;
      }
      seen.add(key);
      return true;
    });
    // Keep the newest examples when over the cap.
    unique.sort((a, b) => b.at - a.at);
    excluded.over_cap += Math.max(0, unique.length - criteria.maxExamplesPerSubject);
    const kept = unique.slice(0, criteria.maxExamplesPerSubject);
    if (kept.length === 0) continue;
    included.add(pseudo);
    for (const e of kept) {
      from = from === null ? e.at : Math.min(from, e.at);
      to = to === null ? e.at : Math.max(to, e.at);
    }
    all.push(...kept);
  }

  // Order by the random ids, so the output order says nothing about the stored order.
  all.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.at - b.at || (a.item < b.item ? -1 : 1)));
  return {
    examples: all.map((e) => ({ subject: e.subject, input: e.input, item: e.item, label: e.label, weight: e.weight, source: e.source })),
    subjects: included.size,
    sourcePeriod: { from: iso(from), to: iso(to) },
    criteria: { ...criteria },
    excluded,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Retention (CONTRACT.md §9)
// ------------------------------------------------------------------------------------------------------------------

/** Deletes expired rows. Returns how many rows were deleted directly from each table (cascades not counted). */
export function purgeExpired(db: Database, now: number): Record<string, number> {
  return transaction(db, () => ({
    interaction_signals: execute(db, "DELETE FROM interaction_signals WHERE created_at < ?", now - RETENTION.signalsMs),
    recommendation_feedback: execute(db, "DELETE FROM recommendation_feedback WHERE created_at < ?", now - RETENTION.feedbackMs),
    recommendations: execute(db, "DELETE FROM recommendations WHERE created_at < ?", now - RETENTION.recommendationsMs),
    subjects: execute(db, "DELETE FROM subjects WHERE last_seen_at < ?", now - RETENTION.inactiveSubjectMs),
  }));
}

// ------------------------------------------------------------------------------------------------------------------
// Dataset and model registry
// ------------------------------------------------------------------------------------------------------------------

const isHex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isVersion = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 128;
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Records a dataset's metadata. Re-registering the same version with the same content hash does nothing. */
export function registerDataset(db: Database, meta: DatasetMetadata): void {
  if (!isVersion(meta.version) || !isHex64(meta.contentSha256) || ![meta.eligibleRecords, meta.eligibleSubjects, meta.syntheticRecords].every(isCount))
    throw new Error("Invalid dataset metadata");
  transaction(db, () => {
    const existing = queryOne<{ content_sha256: string }>(db, "SELECT content_sha256 FROM learning_datasets WHERE version = ?", meta.version);
    if (existing) {
      if (existing.content_sha256 !== meta.contentSha256) throw new Error(`Dataset ${meta.version} is already registered with different content`);
      return;
    }
    execute(
      db,
      `INSERT INTO learning_datasets (version, source_from, source_to, eligible_records, eligible_subjects, synthetic_records, excluded, criteria,
         preprocessing_version, content_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meta.version,
      meta.sourcePeriod.from,
      meta.sourcePeriod.to,
      meta.eligibleRecords,
      meta.eligibleSubjects,
      meta.syntheticRecords,
      JSON.stringify(meta.excluded ?? {}),
      JSON.stringify(meta.criteria ?? {}),
      meta.preprocessingVersion,
      meta.contentSha256,
      meta.createdAt,
    );
  });
}

interface ModelRow {
  version: string;
  dataset_version: string;
  algorithm: string;
  trained_on: "synthetic" | "synthetic+real";
  config: string;
  metrics: string;
  artifact_path: string | null;
  artifact_sha256: string;
  size_bytes: number;
  status: ModelStatus;
  created_at: number;
  activated_at: number | null;
  retired_at: number | null;
  rollback_to: string | null;
  notes: string | null;
}

const toModel = (r: ModelRow): ModelRecord => ({
  version: r.version,
  datasetVersion: r.dataset_version,
  algorithm: r.algorithm,
  trainedOn: r.trained_on,
  config: parseJson(r.config, {}),
  metrics: parseJson(r.metrics, {}),
  artifactPath: r.artifact_path,
  artifactSha256: r.artifact_sha256,
  sizeBytes: r.size_bytes,
  createdAt: r.created_at,
  status: r.status,
  activatedAt: r.activated_at,
  retiredAt: r.retired_at,
  rollbackTo: r.rollback_to,
  notes: r.notes,
});

export function getModelRecord(db: Database, version: string): ModelRecord | null {
  const r = queryOne<ModelRow>(db, "SELECT * FROM model_versions WHERE version = ?", version);
  return r ? toModel(r) : null;
}

/** Registers a trained model as a "candidate". Re-registering the same version and artifact does nothing. */
export function registerModel(db: Database, record: ModelRecordInput): void {
  if (!isVersion(record.version) || !isHex64(record.artifactSha256) || !isCount(record.sizeBytes)) throw new Error("Invalid model record");
  transaction(db, () => {
    const existing = getModelRecord(db, record.version);
    if (existing) {
      if (existing.artifactSha256 !== record.artifactSha256 || existing.artifactPath !== record.artifactPath)
        throw new Error(`Model ${record.version} is already registered with a different artifact`);
      return;
    }
    if (!queryOne(db, "SELECT 1 AS one FROM learning_datasets WHERE version = ?", record.datasetVersion))
      throw new Error(`Register dataset ${record.datasetVersion} before model ${record.version}`);
    execute(
      db,
      `INSERT INTO model_versions (version, dataset_version, algorithm, trained_on, config, metrics, artifact_path, artifact_sha256, size_bytes,
         status, created_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
      record.version,
      record.datasetVersion,
      record.algorithm,
      record.trainedOn,
      JSON.stringify(record.config ?? {}),
      JSON.stringify(record.metrics ?? {}),
      record.artifactPath,
      record.artifactSha256,
      record.sizeBytes,
      record.createdAt,
      record.notes ?? null,
    );
  });
}

export function getActiveModelRecord(db: Database): ModelRecord | null {
  const r = queryOne<ModelRow>(db, "SELECT * FROM model_versions WHERE status = 'active'");
  return r ? toModel(r) : null;
}

/** Newest first. */
export const listModels = (db: Database): ModelRecord[] => queryAll<ModelRow>(db, "SELECT * FROM model_versions ORDER BY created_at DESC, version").map(toModel);

/**
 * Makes a model the active one, in one transaction: the previous active model becomes "retired" and the new one
 * remembers it in `rollback_to`. Activating the active model does nothing. A "rejected" model can't be activated.
 */
export function activateModel(db: Database, version: string, now: number): void {
  transaction(db, () => {
    const target = getModelRecord(db, version);
    if (!target) throw new Error(`Unknown model ${version}`);
    if (target.status === "active") return;
    if (target.status === "rejected") throw new Error(`Model ${version} was rejected and can't be activated`);
    const previous = getActiveModelRecord(db);
    if (previous) execute(db, "UPDATE model_versions SET status = 'retired', retired_at = ? WHERE version = ?", now, previous.version);
    execute(db, "UPDATE model_versions SET status = 'active', activated_at = ?, retired_at = NULL, rollback_to = ? WHERE version = ?", now, previous?.version ?? null, version);
  });
}

/**
 * Re-activates the model the active one replaced and returns its version. The re-activated model keeps its own
 * `rollback_to`, so rolling back again walks further back instead of bouncing between two models.
 */
export function rollbackModel(db: Database, now: number): string {
  return transaction(db, () => {
    const current = getActiveModelRecord(db);
    if (!current) throw new Error("No active model to roll back");
    if (!current.rollbackTo) throw new Error(`Model ${current.version} has no earlier model to roll back to`);
    const target = getModelRecord(db, current.rollbackTo);
    if (!target || target.status === "rejected") throw new Error(`Can't roll back to ${current.rollbackTo}`);
    execute(db, "UPDATE model_versions SET status = 'retired', retired_at = ? WHERE version = ?", now, current.version);
    execute(db, "UPDATE model_versions SET status = 'active', activated_at = ?, retired_at = NULL WHERE version = ?", now, target.version);
    return target.version;
  });
}

/** Marks a candidate as rejected (failed its evaluation gates), so it can never be activated. */
export function rejectModel(db: Database, version: string, notes?: string): void {
  const changed = execute(db, "UPDATE model_versions SET status = 'rejected', notes = COALESCE(?, notes) WHERE version = ? AND status = 'candidate'", notes ?? null, version);
  if (changed === 0) throw new Error(`Model ${version} is not a candidate`);
}

// ------------------------------------------------------------------------------------------------------------------
// Monitoring
// ------------------------------------------------------------------------------------------------------------------

const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const rate = (shown: number, kept: number): RateCount => ({ shown, kept, rate: shown > 0 ? kept / shown : null });

/** Aggregates over recommendations and feedback created at or after `since` (epoch ms). No identifiers. */
export function monitoringSnapshot(db: Database, since: number): MonitoringSnapshot {
  const recs = queryAll<{ id: string; model_version: string; configuration: string; scores: string; evidence_level: string; input_snapshot: string; status: RecommendationStatus }>(
    db,
    "SELECT id, model_version, configuration, scores, evidence_level, input_snapshot, status FROM recommendations WHERE created_at >= ?",
    since,
  );
  const decisions = new Map(
    queryAll<{ recommendation_id: string; outcome: FeedbackOutcome; items: string }>(
      db,
      `SELECT f.recommendation_id, f.outcome, f.items FROM recommendation_feedback f
       JOIN recommendations r ON r.id = f.recommendation_id AND r.created_at >= ?
       WHERE f.outcome <> 'reverted' ORDER BY f.created_at DESC, f.id DESC`,
      since,
    ).map((d) => [d.recommendation_id, d]),
  );

  const byStatus = zeroes(RECOMMENDATION_STATUSES);
  const byModel: Record<string, number> = {};
  const overall = { shown: 0, kept: 0 };
  const byItem: Partial<Record<ItemId, { shown: number; kept: number }>> = {};
  const byEvidence = Object.fromEntries(EVIDENCE_LEVELS.map((e) => [e, { shown: 0, kept: 0 }])) as Record<EvidenceLevel, { shown: number; kept: number }>;
  const byRank: { shown: number; kept: number }[] = [];
  const answers = Object.fromEntries(QUESTIONS.map((q) => [q.id, { skipped: 0, ...zeroes(q.options.map((o) => o.value)) }])) as Record<QuestionId, Record<string, number>>;
  const active: Partial<Record<ItemId, number>> = {};
  const view: Record<Mode, number> = { simple: 0, complex: 0 };
  const explicit: Partial<Record<Dimension, number>> = {};
  let snapshots = 0;

  for (const r of recs) {
    byStatus[r.status]++;
    byModel[r.model_version] = (byModel[r.model_version] ?? 0) + 1;

    const snapshot = decodeSnapshot(r.input_snapshot);
    if (snapshot) {
      snapshots++;
      for (const q of QUESTIONS) {
        const v = (snapshot.answers as Record<string, string | undefined>)[q.id];
        answers[q.id][v ?? "skipped"]++;
      }
      for (const item of activeItems(snapshot.preferences, snapshot.view)) active[item] = (active[item] ?? 0) + 1;
      view[snapshot.view]++;
      for (const d of snapshot.explicit) explicit[d] = (explicit[d] ?? 0) + 1;
    }

    const decision = decisions.get(r.id);
    if (!decision) continue;
    const main = parseJson<{ items?: unknown[] }>(r.configuration, {}).items?.filter(isItemId) ?? [];
    const keptItems = decision.outcome === "accepted" || decision.outcome === "modified" ? parseJson<unknown[]>(decision.items, []).filter(isItemId) : [];
    const kept = keptItems.length > 0 ? 1 : 0;
    overall.shown++;
    overall.kept += kept;
    if (isEvidenceLevel(r.evidence_level)) {
      byEvidence[r.evidence_level].shown++;
      byEvidence[r.evidence_level].kept += kept;
    }
    const ranked = parseJson<Pick<ItemScore, "item">[]>(r.scores, []).map((s) => s?.item);
    for (const item of main) {
      const k = keptItems.includes(item) ? 1 : 0;
      const slot = (byItem[item] ??= { shown: 0, kept: 0 });
      slot.shown++;
      slot.kept += k;
      const position = ranked.indexOf(item);
      if (position >= 0) {
        while (byRank.length <= position) byRank.push({ shown: 0, kept: 0 });
        byRank[position].shown++;
        byRank[position].kept += k;
      }
    }
  }

  const feedbackRows = queryAll<{ outcome: FeedbackOutcome; via: FeedbackVia | null; satisfaction: number | null }>(
    db,
    "SELECT outcome, via, satisfaction FROM recommendation_feedback WHERE created_at >= ?",
    since,
  );
  const byOutcome = zeroes(FEEDBACK_OUTCOMES);
  const revertedVia: Record<FeedbackVia | "unspecified", number> = { card: 0, undo: 0, settings: 0, reset: 0, unspecified: 0 };
  const satisfaction = { helpful: 0, neutral: 0, unhelpful: 0 };
  for (const f of feedbackRows) {
    byOutcome[f.outcome]++;
    if (f.outcome === "reverted") revertedVia[f.via ?? "unspecified"]++;
    if (f.satisfaction === 1) satisfaction.helpful++;
    else if (f.satisfaction === 0) satisfaction.neutral++;
    else if (f.satisfaction === -1) satisfaction.unhelpful++;
  }

  const sortedExplicit: Partial<Record<Dimension, number>> = {};
  for (const d of DIMENSIONS) if (explicit[d]) sortedExplicit[d] = explicit[d];

  return {
    since: iso(since),
    recommendations: { total: recs.length, byStatus, byModel },
    acceptance: {
      overall: rate(overall.shown, overall.kept),
      byItem: Object.fromEntries(Object.entries(byItem).map(([k, v]) => [k, rate(v.shown, v.kept)])) as Partial<Record<ItemId, RateCount>>,
      byEvidence: Object.fromEntries(EVIDENCE_LEVELS.map((e) => [e, rate(byEvidence[e].shown, byEvidence[e].kept)])) as Record<EvidenceLevel, RateCount>,
      byRank: byRank.map((r) => rate(r.shown, r.kept)),
    },
    feedback: { byOutcome, revertedVia, satisfaction },
    inputs: { snapshots, answers, activeItems: active, view, explicit: sortedExplicit },
  };
}
