// Makes a registered model the active one. Refuses a model whose stored promotion gates failed (or were never run),
// a rejected model, and an artifact that is missing, altered (sha256) or not valid for this engine.
//
//   node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/recommender/promote.ts --db <path> --version <version>
import { isValidRecommenderModel } from "../../lib/recommender/engine/index";
import { fail, openStore, parseArgs, readArtifact } from "./common";

const args = parseArgs(process.argv.slice(2), ["db", "version"]);
const path = args.values.get("db");
const version = args.values.get("version");
if (!path || !version) fail("Usage: promote.ts --db <path> --version <version>");

const { store, db } = await openStore(path);
try {
  const record = store.listModels(db).find((m) => m.version === version);
  if (!record) fail(`No model ${version} in the registry (scripts/recommender/models.ts lists them).`);
  if (record.status === "active") {
    console.log(`${version} is already active.`);
    process.exit(0);
  }
  if (record.status === "rejected") fail(`${version} was rejected and can't be promoted.`);
  const gates = (record.metrics as { gates?: { passed?: unknown; failed?: unknown } }).gates;
  if (!gates || gates.passed !== true) {
    const failed = Array.isArray(gates?.failed) ? gates.failed.join(", ") : "no gate results stored";
    fail(`Refusing to promote ${version}: promotion gates did not pass (${failed}). Retrain or fix the data; never promote around a failed gate.`);
  }
  let artifact: unknown;
  try {
    artifact = readArtifact(record);
  } catch (err) {
    fail(`Refusing to promote ${version}: ${(err as Error).message}`);
  }
  if (!isValidRecommenderModel(artifact) || artifact.version !== version) fail(`Refusing to promote ${version}: the artifact is not a valid model for this engine.`);
  const previous = store.getActiveModelRecord(db);
  store.activateModel(db, version, Date.now());
  console.log(`Activated ${version} (${record.trainedOn}). ${previous ? `Previous active model ${previous.version} is retired; rollback.ts goes back to it.` : "There was no active model."}`);
} finally {
  db.close();
}
