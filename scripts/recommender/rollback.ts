// Re-activates the model the active one replaced (one step back per run).
//
//   node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/recommender/rollback.ts --db <path>
import { fail, openStore, parseArgs } from "./common";

const args = parseArgs(process.argv.slice(2), ["db"]);
const path = args.values.get("db");
if (!path) fail("Usage: rollback.ts --db <path>");

const { store, db } = await openStore(path);
try {
  const before = store.getActiveModelRecord(db);
  const version = store.rollbackModel(db, Date.now());
  console.log(`Rolled back from ${before?.version ?? "(none)"} to ${version}. The app picks it up on its next model load.`);
} catch (err) {
  fail(`Rollback failed: ${(err as Error).message}`);
} finally {
  db.close();
}
