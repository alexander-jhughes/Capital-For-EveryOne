// The app's one shared connection, opened lazily on first use. If the database can't be opened (read-only disk,
// old Node, a changed migration), this returns null and logs once: the personalisation API answers 503 and the rest
// of the app carries on without suggestions. It tries again at most once a minute.
import { defaultDatabasePath, describeDbError, openDatabase, type Database } from "./sqlite";

const RETRY_MS = 60_000;

interface Slot {
  db: Database | null;
  failedAt: number | null;
  logged: boolean;
}

// Kept on globalThis so a dev-server reload doesn't open a second connection to the same file.
const holder = globalThis as typeof globalThis & { __cfePersonalisationDb?: Slot };

export function getAppDatabase(now: number = Date.now()): Database | null {
  const slot = (holder.__cfePersonalisationDb ??= { db: null, failedAt: null, logged: false });
  if (slot.db) return slot.db;
  if (slot.failedAt !== null && now - slot.failedAt < RETRY_MS) return null;
  try {
    slot.db = openDatabase(defaultDatabasePath());
    slot.failedAt = null;
    return slot.db;
  } catch (error) {
    slot.failedAt = now;
    if (!slot.logged) {
      slot.logged = true;
      const detail = error instanceof Error && error.name === "MigrationError" ? error.message : describeDbError(error);
      console.warn(`[personalisation] database unavailable, so suggestions are off for now: ${detail}`);
    }
    return null;
  }
}

/** For tests and graceful shutdown. */
export function closeAppDatabase(): void {
  const slot = holder.__cfePersonalisationDb;
  if (slot?.db) slot.db.close();
  delete holder.__cfePersonalisationDb;
}
