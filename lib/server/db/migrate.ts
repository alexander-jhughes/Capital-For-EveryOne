// A small, forward-only migration runner. Migrations are TypeScript modules (no fs at runtime, bundler-safe).
// Each applied migration's checksum is recorded; if the SQL of an applied migration changes later, the database
// refuses to open rather than run against a schema nobody can describe. Fix it with a new migration instead.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** 1, 2, 3...: applied in order, never reused. */
  version: number;
  name: string;
  sql: string;
}

/** sha256 of the SQL with line endings normalised, so a Windows checkout (CRLF) has the same checksum. */
export const migrationChecksum = (m: Migration) => createHash("sha256").update(m.sql.replace(/\r\n/g, "\n")).digest("hex");

export class MigrationError extends Error {
  override name = "MigrationError";
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at INTEGER NOT NULL
) STRICT`;

/** Applies every pending migration, each in its own transaction. Returns the versions applied now. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[], now: number): number[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (!Number.isInteger(m.version) || m.version < 1) throw new MigrationError(`Migration "${m.name}" has an invalid version`);
    if (i > 0 && sorted[i - 1].version === m.version) throw new MigrationError(`Two migrations share version ${m.version}`);
  }

  db.exec(CREATE_TABLE);
  const applied = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as {
    version: number;
    name: string;
    checksum: string;
  }[];
  const byVersion = new Map(sorted.map((m) => [m.version, m]));
  for (const row of applied) {
    const m = byVersion.get(row.version);
    if (!m) throw new MigrationError(`Database has migration ${row.version} ("${row.name}"), which this code doesn't know. Is the code older than the database?`);
    if (migrationChecksum(m) !== row.checksum)
      throw new MigrationError(`Migration ${row.version} ("${row.name}") was changed after it was applied. Add a new migration instead of editing an old one.`);
  }

  const done = new Set(applied.map((r) => r.version));
  const ran: number[] = [];
  const record = db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)");
  for (const m of sorted) {
    if (done.has(m.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      record.run(m.version, m.name, migrationChecksum(m), now);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new MigrationError(`Migration ${m.version} ("${m.name}") failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    ran.push(m.version);
  }
  return ran;
}
