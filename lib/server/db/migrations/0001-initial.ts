// Migration 1: the personalisation schema. NEVER edit this after it has shipped: add a new migration instead.
// (Applied migrations are checksummed; an edit makes every existing database refuse to open.)
//
// Conventions: snake_case, STRICT tables, times are epoch milliseconds (INTEGER), JSON lives in TEXT with a
// json_valid CHECK, every enum has a CHECK, and everything personal hangs off `subjects` with ON DELETE CASCADE,
// so deleting one subject row erases everything about that person.
//
// The enum lists below are literals on purpose (a migration is history). lib/server/db/schema.test.ts checks they
// still match the TypeScript constants; when one changes, write migration 2.
import type { Migration } from "../migrate";

const hex64 = (col: string) => `length(${col}) = 64 AND ${col} NOT GLOB '*[^0-9a-f]*'`;
const jsonObject = (col: string) => `json_valid(${col}) AND json_type(${col}) = 'object'`;
const jsonArray = (col: string) => `json_valid(${col}) AND json_type(${col}) = 'array'`;

const sql = `
CREATE TABLE subjects (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (last_seen_at >= created_at)
) STRICT;
CREATE INDEX subjects_last_seen ON subjects (last_seen_at);

CREATE TABLE user_profiles (
  subject_id TEXT PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  answers TEXT NOT NULL DEFAULT '{}' CHECK (${jsonObject("answers")}),
  profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
  personalisation_consent TEXT NOT NULL DEFAULT 'granted' CHECK (personalisation_consent = 'granted'),
  personalisation_consent_at INTEGER NOT NULL,
  collaborative_consent TEXT NOT NULL DEFAULT 'unset' CHECK (collaborative_consent IN ('unset', 'granted', 'declined')),
  collaborative_consent_at INTEGER,
  research_consent TEXT NOT NULL DEFAULT 'unset' CHECK (research_consent IN ('unset', 'granted', 'declined')),
  research_consent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((collaborative_consent = 'unset') = (collaborative_consent_at IS NULL)),
  CHECK ((research_consent = 'unset') = (research_consent_at IS NULL))
) STRICT;
CREATE INDEX user_profiles_collaborative ON user_profiles (collaborative_consent);

CREATE TABLE user_research (
  subject_id TEXT PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  age_band TEXT NOT NULL CHECK (age_band IN ('18-24', '25-34', '35-49', '50-64', '65+')),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE user_preferences (
  subject_id TEXT PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  preferences TEXT NOT NULL CHECK (${jsonObject("preferences")}),
  view TEXT NOT NULL CHECK (view IN ('simple', 'complex')),
  explicit_dimensions TEXT NOT NULL DEFAULT '[]' CHECK (${jsonArray("explicit_dimensions")}),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE interaction_signals (
  id INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('textLarger', 'textSmaller', 'lessOnScreen', 'moreDetail', 'moreVisual', 'voiceSessions', 'shorterAnswers', 'undoneChanges')),
  source TEXT NOT NULL CHECK (source IN ('settings', 'voice', 'style', 'onboarding', 'dial')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX interaction_signals_subject_time ON interaction_signals (subject_id, created_at);
CREATE INDEX interaction_signals_time ON interaction_signals (created_at);

CREATE TABLE learning_datasets (
  version TEXT PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 128),
  source_from TEXT,
  source_to TEXT,
  eligible_records INTEGER NOT NULL CHECK (eligible_records >= 0),
  eligible_subjects INTEGER NOT NULL CHECK (eligible_subjects >= 0),
  synthetic_records INTEGER NOT NULL CHECK (synthetic_records >= 0),
  excluded TEXT NOT NULL DEFAULT '{}' CHECK (${jsonObject("excluded")}),
  criteria TEXT NOT NULL DEFAULT '{}' CHECK (${jsonObject("criteria")}),
  preprocessing_version TEXT NOT NULL CHECK (length(preprocessing_version) >= 1),
  content_sha256 TEXT NOT NULL CHECK (${hex64("content_sha256")}),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE model_versions (
  version TEXT PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 128),
  dataset_version TEXT NOT NULL REFERENCES learning_datasets (version),
  algorithm TEXT NOT NULL CHECK (length(algorithm) >= 1),
  trained_on TEXT NOT NULL CHECK (trained_on IN ('synthetic', 'synthetic+real')),
  config TEXT NOT NULL DEFAULT '{}' CHECK (${jsonObject("config")}),
  metrics TEXT NOT NULL DEFAULT '{}' CHECK (${jsonObject("metrics")}),
  artifact_path TEXT,
  artifact_sha256 TEXT NOT NULL CHECK (${hex64("artifact_sha256")}),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'retired', 'rejected')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  rollback_to TEXT REFERENCES model_versions (version) ON DELETE SET NULL,
  notes TEXT,
  CHECK (rollback_to IS NULL OR rollback_to <> version),
  CHECK (status <> 'active' OR activated_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX model_versions_one_active ON model_versions (status) WHERE status = 'active';
CREATE INDEX model_versions_dataset ON model_versions (dataset_version);

CREATE TABLE recommendations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  model_version TEXT NOT NULL REFERENCES model_versions (version),
  configuration TEXT NOT NULL CHECK (${jsonObject("configuration")}),
  alternatives TEXT NOT NULL DEFAULT '[]' CHECK (${jsonArray("alternatives")}),
  scores TEXT NOT NULL DEFAULT '[]' CHECK (${jsonArray("scores")}),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('strong', 'moderate', 'limited', 'insufficient')),
  rationale TEXT NOT NULL CHECK (${jsonObject("rationale")}),
  warnings TEXT NOT NULL DEFAULT '[]' CHECK (${jsonArray("warnings")}),
  input_snapshot TEXT NOT NULL CHECK (${jsonObject("input_snapshot")}),
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown', 'accepted', 'modified', 'rejected', 'dismissed', 'reverted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, subject_id)
) STRICT;
CREATE INDEX recommendations_subject_time ON recommendations (subject_id, created_at);
CREATE INDEX recommendations_time ON recommendations (created_at);
CREATE INDEX recommendations_model ON recommendations (model_version);

CREATE TABLE recommendation_feedback (
  id INTEGER PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'modified', 'rejected', 'dismissed', 'reverted')),
  items TEXT NOT NULL DEFAULT '[]' CHECK (${jsonArray("items")}),
  via TEXT CHECK (via IS NULL OR via IN ('card', 'undo', 'settings', 'reset')),
  satisfaction INTEGER CHECK (satisfaction IS NULL OR (satisfaction IN (-1, 0, 1) AND outcome IN ('accepted', 'modified'))),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (recommendation_id, subject_id) REFERENCES recommendations (id, subject_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX recommendation_feedback_recommendation ON recommendation_feedback (recommendation_id, created_at);
CREATE INDEX recommendation_feedback_subject_time ON recommendation_feedback (subject_id, created_at);
CREATE INDEX recommendation_feedback_time ON recommendation_feedback (created_at);

CREATE TABLE consent_events (
  id INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('personalisation', 'collaborative', 'research')),
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  policy_version TEXT NOT NULL CHECK (length(policy_version) >= 1),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX consent_events_subject_time ON consent_events (subject_id, created_at);
`;

export const migration0001: Migration = { version: 1, name: "personalisation schema", sql };
