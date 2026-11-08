// SQLite through Node's built-in `node:sqlite` (Node 22.5+, no flag from 24). No npm dependency, no service.
//
// The module is loaded with `process.getBuiltinModule` so no bundler ever tries to resolve "node:sqlite": only the
// type is imported statically, and that import is erased at compile time.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrate, type Migration } from "./migrate";
import { MIGRATIONS } from "./migrations/index";

export type Database = DatabaseSync;

/** How long a write waits for another connection's lock before giving up. */
export const BUSY_TIMEOUT_MS = 5000;

/** The default data directory: `<cwd>/.data` (git-ignored). */
export const defaultDataDirectory = () => join(process.cwd(), ".data");

/** `PERSONALISATION_DB_PATH`, else `<cwd>/.data/personalisation.sqlite`. */
export const defaultDatabasePath = () => process.env.PERSONALISATION_DB_PATH || join(defaultDataDirectory(), "personalisation.sqlite");

export const isMemoryPath = (path: string) => path === ":memory:" || path.startsWith("file::memory:");

function sqliteModule(): typeof import("node:sqlite") {
  const load = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = typeof load === "function" ? (load.call(process, "node:sqlite") as typeof import("node:sqlite") | undefined) : undefined;
  if (!mod?.DatabaseSync) throw new Error("node:sqlite is not available in this Node.js runtime (needs Node 22.5 or later)");
  return mod;
}

export interface OpenOptions {
  /** For tests only. Defaults to every migration in ./migrations. */
  migrations?: readonly Migration[];
  /** Epoch milliseconds recorded as `applied_at`. */
  now?: number;
}

/**
 * Opens (creating if needed) the personalisation database and brings its schema up to date.
 * Throws if the file can't be opened or an applied migration was changed after it ran.
 */
export function openDatabase(path: string = defaultDatabasePath(), options: OpenOptions = {}): Database {
  const memory = isMemoryPath(path);
  const file = memory ? path : resolve(path);
  if (!memory) mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!memory) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    migrate(db, options.migrations ?? MIGRATIONS, options.now ?? Date.now());
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

let savepoints = 0;

/**
 * Runs `fn` in a transaction (a savepoint when already inside one), committing on return and rolling back on throw.
 * `fn` must be synchronous: node:sqlite is synchronous, so nothing else runs on this connection meanwhile.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** A short, data-free description of an error for logs: never includes values from a request. */
export function describeDbError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === "string" ? ` ${code}` : ""}`;
  }
  return "unknown error";
}
