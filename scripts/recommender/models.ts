// Lists registered models, newest first, with status, gate results and headline (synthetic) metrics.
//
//   node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/recommender/models.ts --db <path> [--json]
import { fail, fmt, iso, openStore, parseArgs } from "./common";

const args = parseArgs(process.argv.slice(2), ["db"]);
const path = args.values.get("db");
if (!path) fail("Usage: models.ts --db <path> [--json]");

const { store, db } = await openStore(path);
try {
  const models = store.listModels(db);
  if (args.flags.has("json")) {
    console.log(JSON.stringify(models.map((m) => ({ ...m, metrics: { headline: (m.metrics as Record<string, unknown>).headline ?? null, gates: (m.metrics as Record<string, unknown>).gates ?? null } })), null, 2));
  } else if (models.length === 0) console.log("No models registered. The app registers its bundled model on first use; train.ts --register adds candidates.");
  else {
    for (const m of models) {
      const metrics = m.metrics as { headline?: { ndcg3?: number; ece?: number; suggestionRate?: number }; gates?: { passed?: boolean; failed?: string[] } };
      const gates = metrics.gates ? (metrics.gates.passed ? "gates passed" : `gates FAILED (${(metrics.gates.failed ?? []).join(", ")})`) : "no gate results";
      console.log(
        `${m.status.padEnd(9)} ${m.version}\n` +
          `          trained on ${m.trainedOn}, dataset ${m.datasetVersion}, ${(m.sizeBytes / 1024).toFixed(1)} KB, ${m.artifactPath ?? "bundled with the app"}\n` +
          `          created ${iso(m.createdAt)}, activated ${iso(m.activatedAt)}, retired ${iso(m.retiredAt)}, rollback to ${m.rollbackTo ?? "-"}\n` +
          `          ${gates}; synthetic test NDCG@3 ${fmt(metrics.headline?.ndcg3)}, ECE ${fmt(metrics.headline?.ece)}, offered to ${fmt((metrics.headline?.suggestionRate ?? NaN) * 100, 1)}%`,
      );
    }
  }
} finally {
  db.close();
}
