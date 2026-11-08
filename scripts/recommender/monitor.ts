// Production monitoring from aggregates only (the backend's monitoringSnapshot has no subject ids):
// input drift (PSI against the active model's training distribution, stored with its evaluation) and feedback bias
// (acceptance by rank position, evidence level and item; ratings; undo). Prints warnings over thresholds.
//
//   node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/recommender/monitor.ts --db <path> [--days 30] [--json]
// Exit code 0 with no warnings, 2 with warnings (so a scheduler can alert), 1 on error.
import { analyseMonitoring, type MonitoringReference, type MonitoringSnapshotLike } from "../../lib/recommender/evaluation/monitoring";
import type { MonitoringSnapshot } from "../../lib/server/personalisation/pipeline-store";
import { fail, openStore, parseArgs, readManifest } from "./common";

// Compile-time check that the backend's snapshot is what the analysis reads.
const asLike = (s: MonitoringSnapshot): MonitoringSnapshotLike => s;

const args = parseArgs(process.argv.slice(2), ["db", "days"]);
const path = args.values.get("db");
const days = Number(args.values.get("days") ?? 30);
if (!path || !Number.isFinite(days) || days <= 0) fail("Usage: monitor.ts --db <path> [--days 30] [--json]");

const { store, db } = await openStore(path);
let exitCode = 0;
try {
  const active = store.getActiveModelRecord(db);
  let reference = (active?.metrics as { monitoringReference?: MonitoringReference } | undefined)?.monitoringReference ?? null;
  if (!reference && active?.artifactPath === null) {
    const m = readManifest();
    if (m?.version === active.version) reference = (m.metrics as { monitoringReference?: MonitoringReference }).monitoringReference ?? null;
  }
  const since = Date.now() - days * 86_400_000;
  const report = analyseMonitoring(asLike(store.monitoringSnapshot(db, since)), reference);
  if (args.flags.has("json")) console.log(JSON.stringify({ activeModel: active?.version ?? null, ...report }, null, 2));
  else {
    const pct = (r: { rate: number | null; shown: number }) => (r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}% of ${r.shown}`);
    console.log(`Active model: ${active?.version ?? "none"}. Window: last ${days} days (since ${report.since ?? "-"}). Recommendations: ${report.recommendations}.`);
    console.log(`Kept (before undo): ${pct(report.acceptance.overall)}`);
    console.log(`By rank: ${report.acceptance.byRank.map((r, i) => `#${i + 1} ${pct(r)}`).join(", ") || "n/a"}`);
    console.log(`By evidence: ${Object.entries(report.acceptance.byEvidence).map(([k, r]) => `${k} ${pct(r)}`).join(", ")}`);
    const top = report.drift.features.slice(0, 5).map((f) => `${f.feature} ${f.psi.toFixed(3)} (${f.level})`);
    console.log(`Input drift (PSI, top 5): ${report.drift.insufficient ? "not enough data" : top.join(", ")}`);
    console.log(report.warnings.length ? `Warnings:\n- ${report.warnings.join("\n- ")}` : "No warnings.");
  }
  if (report.warnings.length) exitCode = 2;
} finally {
  db.close();
}
process.exit(exitCode);
