// Per-subject data access: the only code that reads or writes one person's rows.
//
// SQLite has no row-level security, so this is the substitute. `forSubject(db, subjectId)` returns a repository
// bound to one subject, and every query in it is scoped `WHERE subject_id = ?` with that bound id. The id only ever
// comes from a verified session cookie (see session.ts); no API takes a subject id from the client.
import { randomBytes, randomUUID } from "node:crypto";
import { DIMENSIONS, isDimension, isItemId, nonDefaultDimensions, type Dimension, type ItemId } from "../../recommender/catalog";
import { answeredCount, PROFILE_VERSION, sanitizeAnswers, type AgeBand, type ProfileAnswers, type ResearchAnswers } from "../../recommender/profile";
import { isSignalId, SIGNAL_CAP, type Configuration, type HistoryEntry, type ItemScore, type SignalId, type Signals, type SignalSource, type Warning } from "../../recommender/types";
import { sanitize, type Preferences } from "../../preferences/schema";
import type { Mode } from "../../types";
import { execute, parseJson, queryAll, queryOne } from "../db/query";
import { transaction, type Database } from "../db/sqlite";
import {
  CONSENT_POLICY_VERSION,
  historyFromFeedback,
  isDecision,
  iso,
  LIMITS,
  offeredItems,
  offerOf,
  RETENTION,
  sameSet,
  stillKept,
  type FeedbackRecord,
  type FeedbackVia,
  type Offer,
  type RecommendationStatus,
  type Satisfaction,
} from "./domain";

export type ConsentKind = "personalisation" | "collaborative" | "research";
type ConsentValue = "unset" | "granted" | "declined";

export interface ConsentState {
  personalisation: boolean;
  collaborative: boolean;
  research: boolean;
}

export const NO_CONSENT: ConsentState = { personalisation: false, collaborative: false, research: false };

/** The context stored with a recommendation, for point-in-time training. Never research data, never history. */
export interface InputSnapshot {
  answers: ProfileAnswers;
  preferences: Preferences;
  view: Mode;
  explicit: Dimension[];
  signals: Signals;
}

export interface PreferencesSnapshot {
  preferences: Preferences;
  view: Mode;
  explicit: Dimension[];
}

export interface NewRecommendation {
  modelVersion: string;
  configuration: Configuration;
  alternatives: Configuration[];
  scores: ItemScore[];
  explanation: { summary: string; reasons: string[] };
  warnings: Warning[];
  snapshot: InputSnapshot;
}

/** What the client sees. */
export interface RecommendationDto {
  id: string;
  modelVersion: string;
  trainedOn: "synthetic" | "synthetic+real";
  configuration: Configuration;
  alternatives: Configuration[];
  explanation: { summary: string; reasons: string[] };
  warnings: Warning[];
}

export interface StoredRecommendation extends RecommendationDto {
  status: RecommendationStatus;
  createdAt: number;
}

export interface FeedbackInput {
  outcome: FeedbackRecord["outcome"];
  items?: ItemId[];
  via?: FeedbackVia;
}

export type FeedbackResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

// ------------------------------------------------------------------------------------------------------------------
// Creating a subject: the only write that isn't scoped to an existing subject. The id is generated here.
// ------------------------------------------------------------------------------------------------------------------

/** 128 random bits, hex. */
export const newSubjectId = () => randomBytes(16).toString("hex");

export const isSubjectIdShape = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

const consentValue = (granted: boolean): ConsentValue => (granted ? "granted" : "declined");

/**
 * Grants personalisation: creates a new pseudonymous subject and its profile in one transaction, with any other
 * consents given at the same time. Returns the new subject id (for the session cookie only).
 */
export function createSubject(db: Database, now: number, also: { collaborative?: boolean; research?: boolean } = {}): string {
  const id = newSubjectId();
  transaction(db, () => {
    execute(db, "INSERT INTO subjects (id, created_at, last_seen_at) VALUES (?, ?, ?)", id, now, now);
    execute(
      db,
      `INSERT INTO user_profiles (subject_id, answers, profile_version, personalisation_consent, personalisation_consent_at,
         collaborative_consent, collaborative_consent_at, research_consent, research_consent_at, created_at, updated_at)
       VALUES (?, '{}', ?, 'granted', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      PROFILE_VERSION,
      now,
      also.collaborative === undefined ? "unset" : consentValue(also.collaborative),
      also.collaborative === undefined ? null : now,
      also.research === undefined ? "unset" : consentValue(also.research),
      also.research === undefined ? null : now,
      now,
      now,
    );
    const event = (kind: ConsentKind, granted: boolean) =>
      execute(db, "INSERT INTO consent_events (subject_id, kind, granted, policy_version, created_at) VALUES (?, ?, ?, ?, ?)", id, kind, granted, CONSENT_POLICY_VERSION, now);
    event("personalisation", true);
    if (also.collaborative !== undefined) event("collaborative", also.collaborative);
    if (also.research !== undefined) event("research", also.research);
  });
  return id;
}

// ------------------------------------------------------------------------------------------------------------------
// Row shapes
// ------------------------------------------------------------------------------------------------------------------

interface ProfileRow {
  answers: string;
  profile_version: number;
  collaborative_consent: ConsentValue;
  collaborative_consent_at: number | null;
  research_consent: ConsentValue;
  research_consent_at: number | null;
  personalisation_consent_at: number;
  created_at: number;
  updated_at: number;
}

interface RecommendationRow {
  id: string;
  model_version: string;
  trained_on: "synthetic" | "synthetic+real";
  configuration: string;
  alternatives: string;
  scores: string;
  confidence: number;
  evidence_level: string;
  rationale: string;
  warnings: string;
  input_snapshot: string;
  status: RecommendationStatus;
  created_at: number;
  updated_at: number;
}

interface FeedbackRow {
  id: number;
  recommendation_id: string;
  outcome: FeedbackRecord["outcome"];
  items: string;
  via: FeedbackVia | null;
  satisfaction: Satisfaction | null;
  created_at: number;
}

const EMPTY_CONFIGURATION: Configuration = { items: [], actions: [], title: "", offer: "", confidence: 0, evidence: "insufficient" };

export const decodeFeedback = (r: Pick<FeedbackRow, "outcome" | "items" | "via" | "satisfaction" | "created_at">): FeedbackRecord => ({
  outcome: r.outcome,
  items: parseJson<unknown[]>(r.items, []).filter(isItemId),
  via: r.via,
  satisfaction: r.satisfaction,
  at: r.created_at,
});

const toDto = (r: RecommendationRow): StoredRecommendation => ({
  id: r.id,
  modelVersion: r.model_version,
  trainedOn: r.trained_on,
  configuration: parseJson<Configuration>(r.configuration, EMPTY_CONFIGURATION),
  alternatives: parseJson<Configuration[]>(r.alternatives, []),
  explanation: parseJson(r.rationale, { summary: "", reasons: [] as string[] }),
  warnings: parseJson<Warning[]>(r.warnings, []),
  status: r.status,
  createdAt: r.created_at,
});

const sortDimensions = (ds: Iterable<Dimension>): Dimension[] => {
  const set = new Set(ds);
  return DIMENSIONS.filter((d) => set.has(d));
};

// ------------------------------------------------------------------------------------------------------------------
// The per-subject repository
// ------------------------------------------------------------------------------------------------------------------

export type SubjectRepository = ReturnType<typeof forSubject>;

export function forSubject(db: Database, subjectId: string) {
  const id = subjectId;

  const profileRow = () =>
    queryOne<ProfileRow>(
      db,
      `SELECT answers, profile_version, collaborative_consent, collaborative_consent_at, research_consent, research_consent_at,
              personalisation_consent_at, created_at, updated_at
       FROM user_profiles WHERE subject_id = ?`,
      id,
    );

  const recommendationRow = (recommendationId: string) =>
    queryOne<RecommendationRow>(
      db,
      `SELECT r.*, m.trained_on FROM recommendations r JOIN model_versions m ON m.version = r.model_version
       WHERE r.id = ? AND r.subject_id = ?`,
      recommendationId,
      id,
    );

  const feedbackRows = (recommendationId: string) =>
    queryAll<FeedbackRow>(
      db,
      "SELECT id, recommendation_id, outcome, items, via, satisfaction, created_at FROM recommendation_feedback WHERE recommendation_id = ? AND subject_id = ? ORDER BY created_at, id",
      recommendationId,
      id,
    );

  const consentEvent = (kind: ConsentKind, granted: boolean, now: number) =>
    execute(db, "INSERT INTO consent_events (subject_id, kind, granted, policy_version, created_at) VALUES (?, ?, ?, ?, ?)", id, kind, granted, CONSENT_POLICY_VERSION, now);

  const repo = {
    subjectId: id,

    exists: (): boolean => queryOne(db, "SELECT 1 AS one FROM subjects WHERE id = ?", id) !== undefined,

    /** Records that the subject used the API. Writes at most once per `minIntervalMs`. True if it wrote. */
    touch: (now: number, minIntervalMs: number): boolean =>
      execute(db, "UPDATE subjects SET last_seen_at = ? WHERE id = ? AND last_seen_at <= ?", now, id, now - minIntervalMs) > 0,

    // --- consent -------------------------------------------------------------------------------------------------

    consent(): ConsentState {
      const p = profileRow();
      if (!p) return NO_CONSENT;
      return { personalisation: true, collaborative: p.collaborative_consent === "granted", research: p.research_consent === "granted" };
    },

    /**
     * Changes collaborative and/or research consent. Withdrawing research consent deletes the age band at once.
     * Withdrawing personalisation is `deleteAll()`.
     */
    setConsent(change: { collaborative?: boolean; research?: boolean }, now: number): ConsentState {
      transaction(db, () => {
        const p = profileRow();
        if (!p) return;
        if (change.collaborative !== undefined && p.collaborative_consent !== consentValue(change.collaborative)) {
          execute(db, "UPDATE user_profiles SET collaborative_consent = ?, collaborative_consent_at = ?, updated_at = ? WHERE subject_id = ?", consentValue(change.collaborative), now, now, id);
          consentEvent("collaborative", change.collaborative, now);
        }
        if (change.research !== undefined && p.research_consent !== consentValue(change.research)) {
          execute(db, "UPDATE user_profiles SET research_consent = ?, research_consent_at = ?, updated_at = ? WHERE subject_id = ?", consentValue(change.research), now, now, id);
          consentEvent("research", change.research, now);
        }
        if (change.research === false) execute(db, "DELETE FROM user_research WHERE subject_id = ?", id);
      });
      return repo.consent();
    },

    // --- profile ---------------------------------------------------------------------------------------------------

    profile(): { answers: ProfileAnswers; answered: number; profileVersion: number } | null {
      const p = profileRow();
      if (!p) return null;
      const answers = sanitizeAnswers(parseJson(p.answers, {}));
      return { answers, answered: answeredCount(answers), profileVersion: p.profile_version };
    },

    /** Replaces the answers (a missing key means skipped). Input must already be validated. */
    saveAnswers(answers: ProfileAnswers, now: number): { answers: ProfileAnswers; answered: number } {
      const clean = sanitizeAnswers(answers);
      execute(db, "UPDATE user_profiles SET answers = ?, profile_version = ?, updated_at = ? WHERE subject_id = ?", JSON.stringify(clean), PROFILE_VERSION, now, id);
      return { answers: clean, answered: answeredCount(clean) };
    },

    // --- research (separate consent, never read by the recommender) ------------------------------------------------

    /** Null without research consent. */
    research(): ResearchAnswers | null {
      if (!repo.consent().research) return null;
      const r = queryOne<{ age_band: AgeBand }>(db, "SELECT age_band FROM user_research WHERE subject_id = ?", id);
      return r ? { ageBand: r.age_band } : {};
    },

    /** False (and nothing stored) without research consent. A missing age band deletes it. */
    saveResearch(answers: ResearchAnswers, now: number): boolean {
      return transaction(db, () => {
        if (!repo.consent().research) return false;
        if (answers.ageBand)
          execute(
            db,
            "INSERT INTO user_research (subject_id, age_band, updated_at) VALUES (?, ?, ?) ON CONFLICT (subject_id) DO UPDATE SET age_band = excluded.age_band, updated_at = excluded.updated_at",
            id,
            answers.ageBand,
            now,
          );
        else execute(db, "DELETE FROM user_research WHERE subject_id = ?", id);
        return true;
      });
    },

    // --- settings snapshot -----------------------------------------------------------------------------------------

    preferences(): PreferencesSnapshot | null {
      const r = queryOne<{ preferences: string; view: Mode; explicit_dimensions: string }>(db, "SELECT preferences, view, explicit_dimensions FROM user_preferences WHERE subject_id = ?", id);
      if (!r) return null;
      return { preferences: sanitize(parseJson(r.preferences, {})), view: r.view, explicit: sortDimensions(parseJson<unknown[]>(r.explicit_dimensions, []).filter(isDimension)) };
    },

    /**
     * Stores the current settings. Explicit dimensions are sticky: the stored set is the union of what was stored,
     * what the client sent, and every dimension not at its default. A dimension stops being explicit only when the
     * subject's data is deleted. Returns what was stored (the explicit set to give the engine).
     */
    savePreferences(snapshot: PreferencesSnapshot, now: number): PreferencesSnapshot {
      return transaction(db, () => {
        const preferences = sanitize(snapshot.preferences);
        const explicit = sortDimensions([...(repo.preferences()?.explicit ?? []), ...snapshot.explicit.filter(isDimension), ...nonDefaultDimensions(preferences)]);
        execute(
          db,
          `INSERT INTO user_preferences (subject_id, preferences, view, explicit_dimensions, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (subject_id) DO UPDATE SET preferences = excluded.preferences, view = excluded.view,
             explicit_dimensions = excluded.explicit_dimensions, updated_at = excluded.updated_at`,
          id,
          JSON.stringify(preferences),
          snapshot.view,
          JSON.stringify(explicit),
          now,
        );
        return { preferences, view: snapshot.view, explicit };
      });
    },

    // --- signals ---------------------------------------------------------------------------------------------------

    /** Stores allowlisted signals up to the daily cap. Returns how many were stored. */
    addSignals(signals: readonly { id: SignalId; source: SignalSource }[], now: number): number {
      return transaction(db, () => {
        const today = queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM interaction_signals WHERE subject_id = ? AND created_at > ?", id, now - 24 * 60 * 60 * 1000)?.n ?? 0;
        const room = Math.max(0, LIMITS.signalsPerDay - today);
        const accepted = signals.filter((s) => isSignalId(s.id)).slice(0, room);
        for (const s of accepted) execute(db, "INSERT INTO interaction_signals (subject_id, signal, source, created_at) VALUES (?, ?, ?, ?)", id, s.id, s.source, now);
        return accepted.length;
      });
    },

    /** Counts per signal over the retention window, each capped at SIGNAL_CAP. */
    signalCounts(now: number): Signals {
      const rows = queryAll<{ signal: string; n: number }>(
        db,
        "SELECT signal, COUNT(*) AS n FROM interaction_signals WHERE subject_id = ? AND created_at > ? GROUP BY signal",
        id,
        now - RETENTION.signalsMs,
      );
      const out: Signals = {};
      for (const r of rows) if (isSignalId(r.signal) && r.n > 0) out[r.signal] = Math.min(r.n, SIGNAL_CAP);
      return out;
    },

    /** This subject's past answers for the engine, oldest first, newest last, at most LIMITS.historyEntries. */
    historyFor(before: number = Number.MAX_SAFE_INTEGER): HistoryEntry[] {
      const rows = queryAll<FeedbackRow & { configuration: string; alternatives: string }>(
        db,
        `SELECT f.outcome, f.items, f.via, f.satisfaction, f.created_at, r.configuration, r.alternatives
         FROM recommendation_feedback f JOIN recommendations r ON r.id = f.recommendation_id AND r.subject_id = f.subject_id
         WHERE f.subject_id = ? AND f.created_at < ? ORDER BY f.created_at, f.id`,
        id,
        before,
      );
      const history = rows.flatMap((r) => historyFromFeedback(decodeFeedback(r), offerOf(parseJson(r.configuration, EMPTY_CONFIGURATION), parseJson(r.alternatives, []))));
      return history.slice(-LIMITS.historyEntries);
    },

    // --- recommendations -------------------------------------------------------------------------------------------

    /**
     * Stores a recommendation, or re-uses an open ("shown") one from the last 24 hours with the same model version and
     * the same configuration and alternatives. Returns its id.
     */
    recordRecommendation(rec: NewRecommendation, now: number): { id: string; reused: boolean } {
      return transaction(db, () => {
        const open = queryAll<{ id: string; configuration: string; alternatives: string }>(
          db,
          `SELECT id, configuration, alternatives FROM recommendations
           WHERE subject_id = ? AND status = 'shown' AND model_version = ? AND created_at > ? ORDER BY created_at DESC`,
          id,
          rec.modelVersion,
          now - LIMITS.dedupeWindowMs,
        );
        const same = open.find((o) => {
          const config = parseJson<Configuration>(o.configuration, EMPTY_CONFIGURATION);
          const alternatives = parseJson<Configuration[]>(o.alternatives, []);
          return (
            sameSet(config.items, rec.configuration.items) &&
            alternatives.length === rec.alternatives.length &&
            alternatives.every((a, i) => sameSet(a.items, rec.alternatives[i].items))
          );
        });
        if (same) {
          execute(db, "UPDATE recommendations SET updated_at = ? WHERE id = ? AND subject_id = ?", now, same.id, id);
          return { id: same.id, reused: true };
        }
        const recommendationId = randomUUID();
        execute(
          db,
          `INSERT INTO recommendations (id, subject_id, model_version, configuration, alternatives, scores, confidence, evidence_level,
             rationale, warnings, input_snapshot, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shown', ?, ?)`,
          recommendationId,
          id,
          rec.modelVersion,
          JSON.stringify(rec.configuration),
          JSON.stringify(rec.alternatives),
          JSON.stringify(rec.scores),
          Math.min(1, Math.max(0, Number.isFinite(rec.configuration.confidence) ? rec.configuration.confidence : 0)),
          rec.configuration.evidence,
          JSON.stringify(rec.explanation),
          JSON.stringify(rec.warnings),
          JSON.stringify(rec.snapshot),
          now,
          now,
        );
        return { id: recommendationId, reused: false };
      });
    },

    /** One of this subject's recommendations, or null (also for another subject's id: callers answer 404). */
    recommendation(recommendationId: string): StoredRecommendation | null {
      const r = recommendationRow(recommendationId);
      return r ? toDto(r) : null;
    },

    /**
     * Records an answer to a recommendation and moves its status on.
     * shown → accepted | modified | rejected | dismissed. accepted | modified | reverted → reverted (items still kept).
     */
    recordFeedback(recommendationId: string, input: FeedbackInput, now: number): FeedbackResult {
      return transaction(db, (): FeedbackResult => {
        const row = recommendationRow(recommendationId);
        if (!row) return { ok: false, status: 404, error: "Suggestion not found" };
        const rec = toDto(row);
        const offer: Offer = offerOf(rec.configuration, rec.alternatives);
        const offered = offeredItems(offer);
        if (input.items?.some((i) => !offered.has(i))) return { ok: false, status: 400, error: "items must belong to this suggestion" };

        let items: ItemId[];
        let status: RecommendationStatus;
        if (input.outcome === "reverted") {
          if (rec.status !== "accepted" && rec.status !== "modified" && rec.status !== "reverted") return { ok: false, status: 409, error: "Nothing from this suggestion was kept" };
          const kept = stillKept(feedbackRows(recommendationId).map(decodeFeedback));
          items = input.items ?? kept;
          if (items.length === 0) return { ok: false, status: 409, error: "Nothing left to undo" };
          if (items.some((i) => !kept.includes(i))) return { ok: false, status: 409, error: "Only kept items can be undone" };
          status = "reverted";
        } else {
          if (rec.status !== "shown") return { ok: false, status: 409, error: "This suggestion already has an answer" };
          switch (input.outcome) {
            case "accepted":
              items = input.items ?? offer.main;
              if (!sameSet(items, offer.main)) return { ok: false, status: 400, error: "accepted means the whole suggestion: send modified with the items kept" };
              items = offer.main;
              break;
            case "modified":
              items = input.items ?? [];
              if (items.length === 0) return { ok: false, status: 400, error: "modified needs the items kept" };
              if (sameSet(items, offer.main)) return { ok: false, status: 400, error: "Every item was kept: send accepted" };
              break;
            case "rejected":
            case "dismissed":
              items = input.items ?? offer.main;
              if (items.length === 0) return { ok: false, status: 400, error: "items can't be empty" };
              break;
          }
          status = input.outcome;
        }
        execute(
          db,
          "INSERT INTO recommendation_feedback (recommendation_id, subject_id, outcome, items, via, satisfaction, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
          recommendationId,
          id,
          input.outcome,
          JSON.stringify([...new Set(items)]),
          input.via ?? null,
          now,
        );
        execute(db, "UPDATE recommendations SET status = ?, updated_at = ? WHERE id = ? AND subject_id = ?", status, now, recommendationId, id);
        return { ok: true };
      });
    },

    /** "Did this make Dial easier to use?" Only after something was kept; a new rating replaces the old one. */
    rate(recommendationId: string, satisfaction: Satisfaction, now: number): FeedbackResult {
      return transaction(db, (): FeedbackResult => {
        const row = recommendationRow(recommendationId);
        if (!row) return { ok: false, status: 404, error: "Suggestion not found" };
        const decision = feedbackRows(recommendationId).find((f) => isDecision(f.outcome));
        if (!decision || (decision.outcome !== "accepted" && decision.outcome !== "modified")) return { ok: false, status: 409, error: "Only a kept suggestion can be rated" };
        execute(db, "UPDATE recommendation_feedback SET satisfaction = ? WHERE id = ? AND subject_id = ?", satisfaction, decision.id, id);
        execute(db, "UPDATE recommendations SET updated_at = ? WHERE id = ? AND subject_id = ?", now, recommendationId, id);
        return { ok: true };
      });
    },

    // --- the person's rights -----------------------------------------------------------------------------------------

    /** Everything stored about this subject, readable. */
    exportAll(now: number) {
      const subject = queryOne<{ id: string; created_at: number; last_seen_at: number }>(db, "SELECT id, created_at, last_seen_at FROM subjects WHERE id = ?", id);
      const p = profileRow();
      const research = queryOne<{ age_band: AgeBand; updated_at: number }>(db, "SELECT age_band, updated_at FROM user_research WHERE subject_id = ?", id);
      const prefs = queryOne<{ preferences: string; view: Mode; explicit_dimensions: string; updated_at: number }>(
        db,
        "SELECT preferences, view, explicit_dimensions, updated_at FROM user_preferences WHERE subject_id = ?",
        id,
      );
      const signals = queryAll<{ signal: string; source: string; created_at: number }>(db, "SELECT signal, source, created_at FROM interaction_signals WHERE subject_id = ? ORDER BY created_at, id", id);
      const recs = queryAll<RecommendationRow>(
        db,
        `SELECT r.*, m.trained_on FROM recommendations r JOIN model_versions m ON m.version = r.model_version
         WHERE r.subject_id = ? ORDER BY r.created_at, r.id`,
        id,
      );
      const feedback = queryAll<FeedbackRow>(
        db,
        "SELECT id, recommendation_id, outcome, items, via, satisfaction, created_at FROM recommendation_feedback WHERE subject_id = ? ORDER BY created_at, id",
        id,
      );
      const events = queryAll<{ kind: string; granted: number; policy_version: string; created_at: number }>(
        db,
        "SELECT kind, granted, policy_version, created_at FROM consent_events WHERE subject_id = ? ORDER BY created_at, id",
        id,
      );
      return {
        exportedAt: iso(now),
        about:
          "Everything Dial's personalisation stores about you, under a random id that isn't linked to your card account. " +
          "Nothing here is shared with anyone. Turning personalisation off deletes all of it.",
        subject: subject ? { id: subject.id, createdAt: iso(subject.created_at), lastSeenAt: iso(subject.last_seen_at) } : null,
        consent: p
          ? {
              personalisation: { granted: true, at: iso(p.personalisation_consent_at) },
              collaborative: { state: p.collaborative_consent, at: iso(p.collaborative_consent_at) },
              research: { state: p.research_consent, at: iso(p.research_consent_at) },
            }
          : null,
        profile: p ? { answers: parseJson(p.answers, {}), profileVersion: p.profile_version, createdAt: iso(p.created_at), updatedAt: iso(p.updated_at) } : null,
        research: research ? { ageBand: research.age_band, updatedAt: iso(research.updated_at) } : null,
        settings: prefs
          ? { preferences: parseJson(prefs.preferences, {}), view: prefs.view, explicitDimensions: parseJson(prefs.explicit_dimensions, []), updatedAt: iso(prefs.updated_at) }
          : null,
        signals: signals.map((s) => ({ signal: s.signal, source: s.source, at: iso(s.created_at) })),
        recommendations: recs.map((r) => ({
          ...toDto(r),
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
          confidence: r.confidence,
          evidenceLevel: r.evidence_level,
          scores: parseJson(r.scores, []),
          inputSnapshot: parseJson(r.input_snapshot, {}),
          feedback: feedback
            .filter((f) => f.recommendation_id === r.id)
            .map((f) => ({ outcome: f.outcome, items: parseJson(f.items, []), via: f.via, satisfaction: f.satisfaction, at: iso(f.created_at) })),
        })),
        consentHistory: events.map((e) => ({ kind: e.kind, granted: e.granted === 1, policyVersion: e.policy_version, at: iso(e.created_at) })),
      };
    },

    /** Deletes the subject; ON DELETE CASCADE removes every other row about them. True if anything was deleted. */
    deleteAll: (): boolean => execute(db, "DELETE FROM subjects WHERE id = ?", id) > 0,
  };
  return repo;
}

export type SubjectExport = ReturnType<SubjectRepository["exportAll"]>;
