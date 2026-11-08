import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGE_BANDS } from "../../recommender/profile";
import { SIGNAL_IDS } from "../../recommender/types";
import { EVIDENCE_LEVELS, FEEDBACK_OUTCOMES, FEEDBACK_VIA, RECOMMENDATION_STATUSES, SIGNAL_SOURCES } from "../personalisation/domain";
import { createSubject, forSubject } from "../personalisation/repository";
import { fakeRecommend, prefs, rowsFor, T0, testDb } from "../personalisation/test-helpers";
import { migrate, migrationChecksum, MigrationError, type Migration } from "./migrate";
import { MIGRATIONS } from "./migrations/index";
import { migration0001 } from "./migrations/0001-initial";
import { closeAppDatabase, getAppDatabase } from "./app-database";
import { openDatabase, transaction } from "./sqlite";

const tables = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "cfe-db-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  closeAppDatabase();
  delete process.env.PERSONALISATION_DB_PATH;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migrations", () => {
  it("creates every table and records the migration", () => {
    const db = openDatabase(":memory:", { now: T0 });
    expect(tables(db)).toEqual([
      "consent_events",
      "interaction_signals",
      "learning_datasets",
      "model_versions",
      "recommendation_feedback",
      "recommendations",
      "schema_migrations",
      "subjects",
      "user_preferences",
      "user_profiles",
      "user_research",
    ]);
    expect(db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations").all()).toEqual([
      { version: 1, name: migration0001.name, checksum: migrationChecksum(migration0001), applied_at: T0 },
    ]);
  });

  it("is idempotent: running again applies nothing and changes nothing", () => {
    const db = openDatabase(":memory:", { now: T0 });
    expect(migrate(db, MIGRATIONS, T0 + 1)).toEqual([]);
    expect(migrate(db, MIGRATIONS, T0 + 2)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(1);
  });

  it("re-opens a file database without re-applying, and uses WAL", () => {
    const file = join(tempDir(), "nested", "p.sqlite");
    const a = openDatabase(file, { now: T0 });
    expect((a.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((a.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    a.close();
    const b = openDatabase(file, { now: T0 + 1 });
    expect((b.prepare("SELECT applied_at FROM schema_migrations").get() as { applied_at: number }).applied_at).toBe(T0);
    b.close();
  });

  it("refuses to start when an applied migration was edited", () => {
    const file = join(tempDir(), "p.sqlite");
    openDatabase(file, { now: T0 }).close();
    const tampered: Migration[] = [{ ...migration0001, sql: `${migration0001.sql}\n-- edited` }];
    expect(() => openDatabase(file, { migrations: tampered })).toThrow(/was changed after it was applied/);
  });

  it("ignores line-ending differences in the checksum (Windows checkouts)", () => {
    expect(migrationChecksum({ ...migration0001, sql: migration0001.sql.replace(/\n/g, "\r\n") })).toBe(migrationChecksum(migration0001));
  });

  it("refuses a database that has a migration the code doesn't know", () => {
    const file = join(tempDir(), "p.sqlite");
    const extra: Migration = { version: 2, name: "future", sql: "CREATE TABLE future (id INTEGER PRIMARY KEY) STRICT;" };
    openDatabase(file, { migrations: [migration0001, extra] }).close();
    expect(() => openDatabase(file)).toThrow(MigrationError);
  });

  it("rolls a failed migration back completely", () => {
    const db = openDatabase(":memory:");
    const broken: Migration = { version: 2, name: "broken", sql: "CREATE TABLE half (id INTEGER) STRICT; INSERT INTO nowhere VALUES (1);" };
    expect(() => migrate(db, [migration0001, broken], T0)).toThrow(/Migration 2/);
    expect(tables(db)).not.toContain("half");
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(1);
  });

  it("keeps the CHECK enum lists in step with the TypeScript constants", () => {
    const sql = migration0001.sql;
    const listIn = (column: string) => {
      const m = new RegExp(`${column} [^\\n]*?IN \\(([^)]*)\\)`).exec(sql);
      return m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : null;
    };
    expect(listIn("signal TEXT NOT NULL CHECK \\(signal")).toEqual([...SIGNAL_IDS]);
    expect(listIn("source TEXT NOT NULL CHECK \\(source")).toEqual(SIGNAL_SOURCES);
    expect(listIn("age_band TEXT NOT NULL CHECK \\(age_band")).toEqual([...AGE_BANDS]);
    expect(listIn("outcome TEXT NOT NULL CHECK \\(outcome")).toEqual(FEEDBACK_OUTCOMES);
    expect(listIn("evidence_level TEXT NOT NULL CHECK \\(evidence_level")).toEqual(EVIDENCE_LEVELS);
    expect(listIn("status TEXT NOT NULL DEFAULT 'shown' CHECK \\(status")).toEqual(RECOMMENDATION_STATUSES);
    expect(listIn("via TEXT CHECK \\(via IS NULL OR via")).toEqual(FEEDBACK_VIA);
  });
});

describe("constraints", () => {
  const withSubject = () => {
    const db = testDb();
    return { db, id: createSubject(db, T0) };
  };

  it("rejects values outside an enum", () => {
    const { db, id } = withSubject();
    expect(() => db.prepare("INSERT INTO interaction_signals (subject_id, signal, source, created_at) VALUES (?, 'heartRate', 'voice', ?)").run(id, T0)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO interaction_signals (subject_id, signal, source, created_at) VALUES (?, 'textLarger', 'gemini', ?)").run(id, T0)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO user_research (subject_id, age_band, updated_at) VALUES (?, '40', ?)").run(id, T0)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE user_profiles SET collaborative_consent = 'maybe', collaborative_consent_at = 1 WHERE subject_id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE model_versions SET status = 'live'").run()).toThrow(/CHECK/);
  });

  it("rejects malformed JSON and the wrong JSON shape", () => {
    const { db, id } = withSubject();
    expect(() => db.prepare("UPDATE user_profiles SET answers = '{oops' WHERE subject_id = ?").run(id)).toThrow();
    expect(() => db.prepare("UPDATE user_profiles SET answers = '[1]' WHERE subject_id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO user_preferences (subject_id, preferences, view, explicit_dimensions, updated_at) VALUES (?, '{}', 'simple', '{}', ?)").run(id, T0)).toThrow(/CHECK/);
  });

  it("rejects rows for subjects or models that don't exist", () => {
    const { db } = withSubject();
    expect(() => db.prepare("INSERT INTO interaction_signals (subject_id, signal, source, created_at) VALUES (?, 'textLarger', 'voice', ?)").run("f".repeat(32), T0)).toThrow(/FOREIGN KEY/);
    const id = createSubject(db, T0);
    expect(() =>
      db
        .prepare(
          "INSERT INTO recommendations (id, subject_id, model_version, configuration, confidence, evidence_level, rationale, input_snapshot, created_at, updated_at) VALUES (?, ?, 'nope', '{}', 0.5, 'limited', '{}', '{}', ?, ?)",
        )
        .run(crypto.randomUUID(), id, T0, T0),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects feedback whose subject doesn't own the recommendation", () => {
    const { db, id: a } = withSubject();
    const b = createSubject(db, T0);
    const repo = forSubject(db, a);
    const r = fakeRecommend(
      { format: "cfe-recommender", formatVersion: 1, version: "x", algorithm: "x", trainedOn: "synthetic", datasetVersion: "x", featureIds: [], items: [], body: { weights: [] } },
      { answers: {}, preferences: prefs(), view: "simple", explicit: [], signals: {}, history: [] },
    );
    const { id: recId } = repo.recordRecommendation(
      { modelVersion: "fake-1.0.0+syn.s1", configuration: r.configuration!, alternatives: [], scores: [], explanation: r.explanation, warnings: [], snapshot: { answers: {}, preferences: prefs(), view: "simple", explicit: [], signals: {} } },
      T0,
    );
    expect(() => db.prepare("INSERT INTO recommendation_feedback (recommendation_id, subject_id, outcome, items, created_at) VALUES (?, ?, 'accepted', '[]', ?)").run(recId, b, T0)).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("allows at most one active model", () => {
    const db = testDb();
    db.prepare("INSERT INTO model_versions (version, dataset_version, algorithm, trained_on, artifact_sha256, size_bytes, created_at) VALUES ('m2', 'syn-fake-1', 'x', 'synthetic', ?, 1, ?)").run("b".repeat(64), T0);
    expect(() => db.prepare("UPDATE model_versions SET status = 'active', activated_at = ? WHERE version = 'm2'").run(T0)).toThrow(/UNIQUE/);
  });

  it("rejects a bad subject id, confidence or satisfaction", () => {
    const { db } = withSubject();
    expect(() => db.prepare("INSERT INTO subjects (id, created_at, last_seen_at) VALUES ('ABC', ?, ?)").run(T0, T0)).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO recommendations (id, subject_id, model_version, configuration, confidence, evidence_level, rationale, input_snapshot, created_at, updated_at) VALUES (?, ?, 'fake-1.0.0+syn.s1', '{}', 1.5, 'limited', '{}', '{}', ?, ?)",
        )
        .run(crypto.randomUUID(), createSubject(db, T0), T0, T0),
    ).toThrow(/CHECK/);
  });
});

describe("cascade delete", () => {
  it("leaves no row anywhere for a deleted subject, and keeps everyone else's", () => {
    const db = testDb();
    const a = createSubject(db, T0, { collaborative: true, research: true });
    const b = createSubject(db, T0, { collaborative: true });
    for (const id of [a, b]) {
      const repo = forSubject(db, id);
      repo.saveAnswers({ detailLevel: "keyFacts" }, T0);
      repo.saveResearch({ ageBand: "65+" }, T0);
      repo.savePreferences({ preferences: prefs({ textSize: 125 }), view: "simple", explicit: [] }, T0);
      repo.addSignals([{ id: "textLarger", source: "settings" }], T0);
      const r = fakeRecommend(
        { format: "cfe-recommender", formatVersion: 1, version: "x", algorithm: "x", trainedOn: "synthetic", datasetVersion: "x", featureIds: [], items: [], body: { weights: [] } },
        { answers: {}, preferences: prefs(), view: "simple", explicit: [], signals: {}, history: [] },
      );
      const { id: recId } = repo.recordRecommendation(
        { modelVersion: "fake-1.0.0+syn.s1", configuration: r.configuration!, alternatives: r.alternatives, scores: r.scores, explanation: r.explanation, warnings: [], snapshot: { answers: {}, preferences: prefs(), view: "simple", explicit: [], signals: {} } },
        T0,
      );
      expect(repo.recordFeedback(recId, { outcome: "accepted" }, T0 + 1)).toEqual({ ok: true });
    }
    const before = rowsFor(db, a);
    expect(Object.entries(before).filter(([, n]) => n === 0)).toEqual([]);
    expect(forSubject(db, a).deleteAll()).toBe(true);
    expect(rowsFor(db, a)).toEqual(Object.fromEntries(Object.keys(before).map((k) => [k, 0])));
    expect(rowsFor(db, b).recommendations).toBe(1);
    expect(rowsFor(db, b).recommendation_feedback).toBe(1);
  });
});

describe("transaction", () => {
  it("rolls back on throw and nests with savepoints", () => {
    const db = testDb();
    expect(() =>
      transaction(db, () => {
        createSubject(db, T0);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect((db.prepare("SELECT COUNT(*) AS n FROM subjects").get() as { n: number }).n).toBe(0);
    transaction(db, () => {
      createSubject(db, T0);
      try {
        transaction(db, () => {
          createSubject(db, T0);
          throw new Error("inner");
        });
      } catch {
        // the inner savepoint rolled back; the outer transaction carries on
      }
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM subjects").get() as { n: number }).n).toBe(1);
  });
});

describe("getAppDatabase", () => {
  it("opens the file named by PERSONALISATION_DB_PATH once and re-uses it", () => {
    process.env.PERSONALISATION_DB_PATH = join(tempDir(), "app.sqlite");
    const a = getAppDatabase();
    expect(a).not.toBeNull();
    expect(getAppDatabase()).toBe(a);
  });

  it("returns null (and logs once) when the database can't be opened", () => {
    const dir = tempDir();
    // A directory where the file should be: SQLite can't open it.
    process.env.PERSONALISATION_DB_PATH = dir;
    const warn = console.warn;
    const messages: string[] = [];
    console.warn = (m: string) => messages.push(m);
    try {
      expect(getAppDatabase(T0)).toBeNull();
      expect(getAppDatabase(T0 + 1)).toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/database unavailable/);
  });
});
