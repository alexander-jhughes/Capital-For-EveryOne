// Trains, evaluates and versions the Dial personalisation v2 recommender.
//
// ALL EVALUATION DATA IS SYNTHETIC (lib/recommender/synthetic.ts). Results show the pipeline works and that the model
// recovers structure we wrote into the generator; they do not show that it helps real people.
//
//   purge expired data (--db) -> generate the synthetic world -> optionally add eligible real examples (--db)
//   -> data-quality checks -> train the hybrid (precision-target sweep) and the component/baseline systems
//   -> choose the deployed model on VALIDATION people only -> evaluate once on TEST people -> gates
//   -> write artifact + evaluation JSON + EVALUATION.md -> --register: dataset metadata and model as "candidate"
//
// Usage (Node 24, no extra packages):
//   node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/recommender/train.ts [options]
//     --seed <n>       world, split and training seed (default 20261108)
//     --people <n>     synthetic people (default 20000)
//     --db <path>      use the personalisation database: purge, real data, active model, registry
//     --register       register the dataset metadata and the model as "candidate" (needs --db)
//     --check          retrain and compare byte-for-byte with the committed artifact; writes nothing (exit 1 if different)
//     --no-write       evaluate and print only
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ITEM_IDS, type ItemId } from "../../lib/recommender/catalog";
import {
  FEATURE_IDS,
  isValidRecommenderModel,
  recommend,
  type RecommenderModel,
  scoreItems,
  trainComponentScorers,
  trainRecommender,
  type TrainOptions,
} from "../../lib/recommender/engine/index";
import { assertV1Model, randomScorer, rulesPolicy, trainPopularity, trainRules, v1ForestScorer, v1Policy } from "../../lib/recommender/evaluation/baselines";
import { type Contender, evaluateContender, oracleScorer, type Policy, runBenchmark, type Scorer } from "../../lib/recommender/evaluation/benchmark";
import { evaluateGates } from "../../lib/recommender/evaluation/gates";
import { auc, calibration, mean } from "../../lib/recommender/evaluation/metrics";
import { inputDistribution, type MonitoringReference } from "../../lib/recommender/evaluation/monitoring";
import { checkDataset } from "../../lib/recommender/evaluation/quality";
import { type EvaluationReport, EVALUATION_FORMAT, registryMetrics, renderEvaluation, roundedJson, slimBenchmark, SYNTHETIC_DISCLAIMER, type SweepRow } from "../../lib/recommender/evaluation/report";
import { PROFILE_VERSION } from "../../lib/recommender/profile";
import { rng, shuffle } from "../../lib/recommender/random";
import { DEFAULT_WORLD, examplesFor, generateWorld, loggedFor, mixSeed, splitPeople, SYNTHETIC_GENERATOR_VERSION } from "../../lib/recommender/synthetic";
import type { EligibilityCriteria, RecommenderInput, TrainingExample } from "../../lib/recommender/types";
import type { DatasetMetadata } from "../../lib/server/personalisation/pipeline-store";
import { EVALUATION_MD, fail, INDEX_PATH, type Manifest, MANIFEST_PATH, MODELS_DIR, openStore, parseArgs, PRIVATE_MODELS_DIR, readArtifact, readManifest, ROOT, sha256, type Store } from "./common";

const args = parseArgs(process.argv.slice(2), ["seed", "people", "db"]);
const SEED = Number(args.values.get("seed") ?? DEFAULT_WORLD.seed);
const PEOPLE = Number(args.values.get("people") ?? DEFAULT_WORLD.people);
const DB_PATH = args.values.get("db") ?? null;
const CHECK = args.flags.has("check");
const REGISTER = args.flags.has("register");
const WRITE = !CHECK && !args.flags.has("no-write");
for (const f of args.flags) if (!["check", "register", "no-write"].includes(f)) fail(`Unknown option --${f}`);
if (!Number.isInteger(SEED) || !Number.isInteger(PEOPLE) || PEOPLE < 1000) fail("--seed must be an integer and --people an integer ≥ 1000");
if (REGISTER && !DB_PATH) fail("--register needs --db <path>");
if (CHECK && DB_PATH) fail("--check reproduces the committed synthetic-only model: run it without --db");

/** Model family: engine "hybrid-2" plus this pipeline's version. Bump on any change to features, engine or pipeline. */
const MODEL_FAMILY = "hybrid-2.0.0";
/** CONTRACT.md §8. */
const CRITERIA: EligibilityCriteria = { requireCollaborativeConsent: true, minAgeHours: 24, maxAgeDays: 365, maxExamplesPerSubject: 50 };
const MIN_REAL_SUBJECTS = 200;
const MIN_REAL_PER_ITEM = 30;
/** Precision targets swept on validation (lead decision); the engine default is 0.75. */
const MIN_PRECISION_SWEEP = [0.6, 0.65, 0.7, 0.75];
const DEFAULT_MIN_PRECISION = 0.75;
/** Deploy the lowest target whose offered items on validation have at most this false-recommendation rate... */
const MAX_OFFERED_FALSE_REC = 0.15;
/** ...measured on at least this many offered items. */
const MIN_OFFERED_ITEMS = 20;
/** Share of training people whose examples train the components; the rest fit the engine's stacker and thresholds. */
const FIT_SHARE = 0.75;

const now = Date.now();
const timings: Record<string, number> = {};
let mark = performance.now();
const lap = (name: string) => {
  const t = performance.now();
  timings[name] = Math.round(t - mark);
  mark = t;
};
const log = (s: string) => console.log(s);

// ---------------------------------------------------------------------------------------------------------------
// 1. Database: purge expired data first (CONTRACT.md §9)
// ---------------------------------------------------------------------------------------------------------------

let store: Store | null = null;
let db: ReturnType<Store["openDatabase"]> | null = null;
if (DB_PATH) {
  ({ store, db } = await openStore(DB_PATH));
  const purged = store.purgeExpired(db, now);
  log(`Purged expired rows: ${JSON.stringify(purged)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Synthetic world and person-disjoint splits
// ---------------------------------------------------------------------------------------------------------------

const world = generateWorld({ seed: SEED, people: PEOPLE });
const split = splitPeople(world.people.length, SEED);
const shuffledTrain = shuffle(rng(mixSeed(SEED, 0xf17)), split.train.slice());
const cut = Math.round(shuffledTrain.length * FIT_SHARE);
const byIndex = (a: number, b: number) => a - b;
const people = { fit: shuffledTrain.slice(0, cut).sort(byIndex), calibration: shuffledTrain.slice(cut).sort(byIndex), validation: split.validation, test: split.test };
lap("generate");

// ---------------------------------------------------------------------------------------------------------------
// 3. Real data (only with --db, only if there is enough of it)
// ---------------------------------------------------------------------------------------------------------------

const real: EvaluationReport["realData"] = { used: false, reason: "no database given (--db)", subjects: 0, examples: 0, excluded: {} };
const realParts: Record<"fit" | "calibration" | "validation" | "test", TrainingExample[]> = { fit: [], calibration: [], validation: [], test: [] };
let realPeriod: DatasetMetadata["sourcePeriod"] = { from: null, to: null };
if (store && db) {
  const exp = store.exportEligibleTrainingData(db, CRITERIA, now);
  real.excluded = exp.excluded;
  const perItem = Object.fromEntries(ITEM_IDS.map((id) => [id, 0])) as Record<ItemId, number>;
  for (const e of exp.examples) perItem[e.item]++;
  const short = ITEM_IDS.filter((id) => perItem[id] < MIN_REAL_PER_ITEM);
  if (exp.subjects < MIN_REAL_SUBJECTS) real.reason = `only ${exp.subjects} eligible people (minimum ${MIN_REAL_SUBJECTS})`;
  else if (short.length) real.reason = `fewer than ${MIN_REAL_PER_ITEM} labelled examples for ${short.length} items (${short.join(", ")})`;
  else {
    const subjects = shuffle(rng(mixSeed(SEED, 0x4ea1)), [...new Set(exp.examples.map((e) => e.subject))].sort());
    const n = subjects.length;
    const bounds = [0.45, 0.6, 0.8].map((x) => Math.round(n * x));
    const part = new Map<string, keyof typeof realParts>();
    subjects.forEach((s, i) => part.set(s, i < bounds[0] ? "fit" : i < bounds[1] ? "calibration" : i < bounds[2] ? "validation" : "test"));
    for (const e of exp.examples) realParts[part.get(e.subject)!].push(e);
    Object.assign(real, { used: true, reason: "enough eligible real data", subjects: exp.subjects, examples: exp.examples.length });
    realPeriod = exp.sourcePeriod;
  }
  log(`Real data: ${real.used ? `using ${real.examples} examples from ${real.subjects} people` : `skipped (${real.reason})`}`);
}
const trainedOn: "synthetic" | "synthetic+real" = real.used ? "synthetic+real" : "synthetic";

const parts = {
  fit: [...examplesFor(world, people.fit), ...realParts.fit],
  calibration: [...examplesFor(world, people.calibration), ...realParts.calibration],
  validation: [...examplesFor(world, people.validation), ...realParts.validation],
  test: [...examplesFor(world, people.test), ...realParts.test],
};
const allExamples = [...parts.fit, ...parts.calibration, ...parts.validation, ...parts.test];

// ---------------------------------------------------------------------------------------------------------------
// 4. Data-quality checks (stop on any error)
// ---------------------------------------------------------------------------------------------------------------

const quality = checkDataset(allExamples, { train: [...parts.fit, ...parts.calibration], validation: parts.validation, test: parts.test });
if (!quality.ok) fail(`Data-quality checks failed:\n- ${quality.errors.join("\n- ")}`);
for (const w of quality.warnings) log(`Data-quality warning: ${w}`);

// Dataset identity: content hash over every example in a canonical order (inputs serialised once each).
const inputJson = new WeakMap<RecommenderInput, string>();
const hash = (() => {
  const h = createHash("sha256");
  for (const e of allExamples) {
    let j = inputJson.get(e.input);
    if (j === undefined) inputJson.set(e.input, (j = JSON.stringify(e.input)));
    h.update(`${e.subject}|${e.item}|${e.label}|${e.weight}|${e.source}|${j}\n`);
  }
  return h.digest("hex");
})();
const preprocessingVersion = `features-${sha256(FEATURE_IDS.join(",")).slice(0, 12)}.profile-v${PROFILE_VERSION}`;
const synTag = `syn.g${SYNTHETIC_GENERATOR_VERSION}.s${SEED}${PEOPLE === DEFAULT_WORLD.people ? "" : `.n${PEOPLE}`}`;
const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
const datasetVersion = real.used ? `${synTag}+real-${day}-${hash.slice(0, 8)}` : synTag;
const versionFor = (minPrecision: number) => `${MODEL_FAMILY}+${synTag}${real.used ? `+real.${day}.${hash.slice(0, 8)}` : ""}.mp${Math.round(minPrecision * 100)}`;
lap("prepare");

// ---------------------------------------------------------------------------------------------------------------
// 5. Train: the hybrid for every precision target, the components on their own, the baselines
// ---------------------------------------------------------------------------------------------------------------

const baseOptions = (minPrecision: number): TrainOptions => ({ seed: SEED, version: versionFor(minPrecision), datasetVersion, trainedOn, minPrecision });
const sweepModels = MIN_PRECISION_SWEEP.map((mp) => trainRecommender(parts.fit, parts.calibration, baseOptions(mp)));
sweepModels.forEach((m, k) => {
  if (!isValidRecommenderModel(m)) fail(`The engine produced an invalid model (${versionFor(MIN_PRECISION_SWEEP[k])})`);
});
lap("train hybrid sweep");
const trainAll = [...parts.fit, ...parts.calibration];
// Ablations: each component alone, trained on exactly the people the hybrid's own components were trained on (fit).
const components = trainComponentScorers(parts.fit, { seed: SEED, version: "components", datasetVersion, trainedOn });
const v1Model = assertV1Model(JSON.parse(readFileSync(join(ROOT, "lib", "personalisation", "model.json"), "utf8")));
const v1Bytes = readFileSync(join(ROOT, "lib", "personalisation", "model.json")).length;
const baselines = { popularity: trainPopularity(trainAll), rules: trainRules(trainAll) };
lap("train components and baselines");

const hybridScorer =
  (model: RecommenderModel): Scorer =>
  (input) => {
    const out: Partial<Record<ItemId, number>> = {};
    for (const s of scoreItems(model, input)) out[s.item] = s.probability;
    return out;
  };
const hybridPolicy =
  (model: RecommenderModel): Policy =>
  (input, at) =>
    recommend(model, input, { now: at }).configuration?.items ?? [];
const modelBytes = (m: RecommenderModel) => Buffer.byteLength(JSON.stringify(m));
const hybrid = (name: string, m: RecommenderModel): Contender => ({ name, description: m.version, scorer: hybridScorer(m), policy: hybridPolicy(m), bytes: modelBytes(m) });

// ---------------------------------------------------------------------------------------------------------------
// 6. Choose the precision target on VALIDATION people only
// ---------------------------------------------------------------------------------------------------------------

const validationLogged = loggedFor(world, people.validation);
const sweep: SweepRow[] = sweepModels.map((m, k) => {
  const r = evaluateContender(world, people.validation, hybrid(`minPrecision ${MIN_PRECISION_SWEEP[k]}`, m), { latencySamples: 5 });
  const p = r.policy!;
  // Precision on labels: logged validation exposures whose probability clears that item's threshold.
  const score = hybridScorer(m);
  const labels: number[] = [];
  for (const l of validationLogged) {
    const t = m.thresholds[ITEM_IDS.indexOf(l.example.item)];
    if (t !== null && (score(l.example.input)[l.example.item] ?? 0) >= t) labels.push(l.example.label);
  }
  const offeredPeople = Math.round(p.suggestionRate * p.people);
  return {
    minPrecision: MIN_PRECISION_SWEEP[k],
    version: m.version,
    itemsWithThreshold: m.thresholds.filter((t) => t !== null).length,
    people: p.people,
    offeredPeople,
    suggestionRate: p.suggestionRate,
    meanConfigurationSize: p.meanConfigurationSize,
    offeredItems: p.offeredItems,
    falseRecRate: p.falseRecRate,
    benefit: p.benefit,
    expectedKeptRate: p.expectedKeptRate,
    labelPrecision: mean(labels),
    labelPrecisionN: labels.length,
    qualifies: p.offeredItems >= MIN_OFFERED_ITEMS && p.falseRecRate !== null && p.falseRecRate <= MAX_OFFERED_FALSE_REC,
  };
});
// The hidden-truth ceiling at the same kind of cut-off: label rate of logged validation exposures whose TRUE expected
// probability (keep and not undone) clears a threshold. Shows what precision is reachable at all in this world.
const ceilingScore = oracleScorer(world);
const ceiling = [0.55, 0.6, 0.7].map((threshold) => {
  const ys = validationLogged.filter((l) => (ceilingScore(l.example.input)[l.example.item] ?? 0) >= threshold).map((l) => l.example.label);
  return { threshold, precision: mean(ys), n: ys.length };
});
const qualifying = sweep.filter((s) => s.qualifies).sort((a, b) => a.minPrecision - b.minPrecision);
const chosenRow = qualifying[0] ?? sweep.find((s) => s.minPrecision === DEFAULT_MIN_PRECISION)!;
const model = sweepModels[sweep.indexOf(chosenRow)];
const version = model.version;
lap("select on validation");
for (const r of sweep)
  log(
    `  minPrecision ${r.minPrecision.toFixed(2)}: ${r.itemsWithThreshold} items with a threshold, offered to ${r.offeredPeople}/${r.people}, false rec ${r.falseRecRate === null ? "n/a" : (r.falseRecRate * 100).toFixed(1) + "%"}, label precision ${r.labelPrecision === null ? "n/a" : (r.labelPrecision * 100).toFixed(1) + "%"}${r.qualifies ? " (qualifies)" : ""}`,
  );
log(`Chosen precision target ${chosenRow.minPrecision}${qualifying.length ? "" : " (no candidate qualified: engine default kept)"} -> ${version}`);

// ---------------------------------------------------------------------------------------------------------------
// --check: reproducibility of the committed artifact
// ---------------------------------------------------------------------------------------------------------------

const artifactJson = JSON.stringify(model);
const artifactFile = `${JSON.stringify(model)}\n`;
if (CHECK) {
  const manifest = readManifest();
  if (!manifest) fail("No committed model (lib/recommender/models/manifest.json): nothing to check.");
  const committed = existsSync(join(MODELS_DIR, manifest.file)) ? readFileSync(join(MODELS_DIR, manifest.file), "utf8") : "";
  const same = manifest.version === version && committed === artifactFile;
  log(same ? `${manifest.file} matches a fresh training run byte for byte.` : `${manifest.file} differs from a fresh training run (fresh version ${version}).`);
  process.exit(same ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------------------------
// 7. The currently active model (for the false-recommendation gate and the comparison)
// ---------------------------------------------------------------------------------------------------------------

let active: Contender | null = null;
let noActiveNote: string | undefined;
try {
  if (store && db) {
    const rec = store.getActiveModelRecord(db);
    if (!rec) noActiveNote = "no active model in the registry: reported, not gated";
    else if (rec.version === version) noActiveNote = "the candidate is the active version: not compared with itself";
    else {
      const m = readArtifact(rec);
      if (isValidRecommenderModel(m)) active = hybrid(`active (${rec.version})`, m);
      else noActiveNote = `active model ${rec.version} no longer validates with this engine: not compared`;
    }
  } else {
    const manifest = readManifest();
    if (!manifest) noActiveNote = "no bundled model yet (first model): reported, not gated";
    else if (manifest.version === version) noActiveNote = "the candidate is the bundled (active) version: not compared with itself";
    else {
      const m = JSON.parse(readFileSync(join(MODELS_DIR, manifest.file), "utf8"));
      if (isValidRecommenderModel(m)) active = hybrid(`active (${manifest.version})`, m);
      else noActiveNote = `bundled model ${manifest.version} no longer validates with this engine: not compared`;
    }
  }
} catch (err) {
  noActiveNote = `active model could not be loaded (${(err as Error).message}): not compared`;
}

// ---------------------------------------------------------------------------------------------------------------
// 8. Benchmarks: validation (all systems, for the record) and test (reported once)
// ---------------------------------------------------------------------------------------------------------------

const contenders = (includeActive: boolean): Contender[] => [
  { name: "oracle", description: "REFERENCE CEILING: scores with the hidden synthetic truth; can never be deployed", scorer: oracleScorer(world) },
  hybrid("hybrid", model),
  { name: "content", description: "engine content component alone (trained on the fit people, like the hybrid's)", scorer: components.content },
  { name: "collaborative", description: "engine collaborative component alone", scorer: components.collaborative },
  { name: "factorization", description: "engine factorisation component alone", scorer: components.factorization },
  { name: "popularity", description: "per-item label rate", scorer: baselines.popularity },
  { name: "rules", description: "Make it yours rules via the baseline-only answer mapping", scorer: baselines.rules, policy: rulesPolicy },
  { name: "v1 forest", description: "v1 random forest (8 items, no answers or history)", scorer: v1ForestScorer(v1Model), policy: v1Policy(v1Model), bytes: v1Bytes },
  { name: "random", description: "seeded random scores", scorer: randomScorer(SEED) },
  ...(includeActive && active ? [active] : []),
];
const validation = runBenchmark(world, people.validation, contenders(false));
lap("benchmark validation");
const test = runBenchmark(world, people.test, contenders(true));
lap("benchmark test");

// Overfitting: the same systems on (a sample of) the people they were trained on.
const fitSample = people.fit.slice(0, 4000);
const trainBench = runBenchmark(
  world,
  fitSample,
  contenders(false).filter((c) => ["hybrid", "content", "collaborative", "factorization", "popularity", "rules"].includes(c.name)),
  { latencySamples: 10 },
);
const overfitting = trainBench.contenders.map((c) => {
  const v = validation.contenders.find((x) => x.name === c.name)!;
  const t = test.contenders.find((x) => x.name === c.name)!;
  const pick = (r: typeof c) => ({ ndcg3: r.oracle.overall["ndcg@3"], auc: r.logged.auc });
  return { name: c.name, train: pick(c), validation: pick(v), test: pick(t) };
});
lap("overfitting check");

// Real held-out feedback: logged evaluation only (no hidden truth exists for real people).
let realTest: EvaluationReport["realTest"] = null;
if (realParts.test.length) {
  const s = hybridScorer(model);
  const y = realParts.test.map((e) => e.label);
  const p = realParts.test.map((e) => s(e.input)[e.item] ?? 0);
  const c = calibration(y, p);
  realTest = { n: y.length, auc: auc(y, p), ece: c.ece, brier: c.brier };
}

// ---------------------------------------------------------------------------------------------------------------
// 9. Gates (test people)
// ---------------------------------------------------------------------------------------------------------------

const testResult = (name: string) => test.contenders.find((c) => c.name === name)!;
const gates = evaluateGates({
  candidate: testResult("hybrid"),
  popularity: testResult("popularity"),
  v1: testResult("v1 forest"),
  active: active ? testResult(active.name) : null,
  noActiveNote,
  artifactBytes: Buffer.byteLength(artifactJson),
});

// ---------------------------------------------------------------------------------------------------------------
// 10. Report
// ---------------------------------------------------------------------------------------------------------------

const trainLogged = loggedFor(world, [...people.fit, ...people.calibration]);
const positions: [number, number][] = [];
for (const l of trainLogged) {
  positions[l.position] ??= [0, 0];
  positions[l.position][0]++;
  if (l.outcome !== "rejected") positions[l.position][1]++;
}
const monitoringReference: MonitoringReference = {
  inputs: inputDistribution(trainAll.map((e) => e.input)),
  keptRate: trainLogged.filter((l) => l.outcome !== "rejected").length / Math.max(1, trainLogged.length),
  keptRateByPosition: positions.map(([n, k]) => (n ? k / n : 0)),
};
const policyShares: Record<string, number> = {};
for (const l of world.logged) policyShares[l.policy] = (policyShares[l.policy] ?? 0) + 1 / world.logged.length;

const keepNote =
  `The synthetic world's label rate is ${(world.examples.reduce((s, e) => s + e.label, 0) / world.examples.length * 100).toFixed(0)}% ` +
  "(kept and not undone). That is our assumption, not a measurement: real acceptance of unsolicited display suggestions is unknown. " +
  "A low base rate caps the precision any model can reach: even scoring with the hidden truth, the label rate of logged validation exposures at or above a true probability of " +
  ceiling.map((c) => `${c.threshold} is ${c.precision === null ? "n/a" : (c.precision * 100).toFixed(0) + "%"} (n=${c.n})`).join(", ") +
  ", because keeping is noisy (exposure noise, novelty, undo and ratings). " +
  "The generator was not changed to improve these numbers.";
const report: EvaluationReport = {
  format: EVALUATION_FORMAT,
  formatVersion: 1,
  synthetic: true,
  disclaimer: SYNTHETIC_DISCLAIMER,
  createdAt: new Date(now).toISOString(),
  model: { version, algorithm: model.algorithm, trainedOn, datasetVersion, bytes: Buffer.byteLength(artifactJson), sha256: sha256(artifactJson), config: { seed: SEED, minPrecision: chosenRow.minPrecision, hyper: model.hyper } },
  dataset: {
    version: datasetVersion,
    generatorVersion: SYNTHETIC_GENERATOR_VERSION,
    seed: SEED,
    people: PEOPLE,
    examples: world.examples.length,
    dismissedRounds: world.dismissedRounds,
    labelRate: world.examples.reduce((s, e) => s + e.label, 0) / world.examples.length,
    policyShares,
    contentSha256: hash,
    preprocessingVersion,
  },
  split: {
    description:
      `People are split, never examples: 60% training, 20% validation, 20% test (seeded). Training people are split again: ${FIT_SHARE * 100}% "fit" (the engine's components) and ` +
      `${100 - FIT_SHARE * 100}% "calibration" (the engine's stacker and thresholds, its \`validation\` argument). The validation people are used only to choose the precision target; ` +
      "the test people only for this report and the gates, once. The component ablations (content, collaborative, factorization alone) are trained on the fit people, exactly like the hybrid's own components, so the comparison isolates what stacking adds; popularity and rules use all training people." +
      (real.used ? " Real people are split the same way (45/15/20/20) by their per-export random id." : ""),
    people: { fit: people.fit.length, calibration: people.calibration.length, validation: people.validation.length, test: people.test.length },
    examples: { fit: parts.fit.length, calibration: parts.calibration.length, validation: parts.validation.length, test: parts.test.length },
  },
  realData: real,
  quality,
  selection: {
    rule:
      `The hybrid was trained once per precision target (engine \`minPrecision\` ∈ {${MIN_PRECISION_SWEEP.join(", ")}}; ranking is identical, only the per-item suggestion thresholds differ). ` +
      `Rule (set by the integration lead after seeing how few items get a threshold at the engine default, but before this sweep was run): deploy the **lowest** target whose offered items on **validation** people have a synthetic false-recommendation rate ` +
      `(true benefit ≤ 0) ≤ ${MAX_OFFERED_FALSE_REC * 100}% over at least ${MIN_OFFERED_ITEMS} offered items; if none qualifies, keep the engine default ${DEFAULT_MIN_PRECISION}. ` +
      "This is a **product trade-off between reach (how many people get a suggestion) and wrong suggestions**, decided on synthetic data.",
    maxFalseRec: MAX_OFFERED_FALSE_REC,
    minOffers: MIN_OFFERED_ITEMS,
    candidates: sweep,
    chosen: "hybrid",
    chosenMinPrecision: chosenRow.minPrecision,
    qualified: qualifying.length > 0,
    note:
      (qualifying.length
        ? `Chosen: minPrecision ${chosenRow.minPrecision} (\`${version}\`), the lowest qualifying target. In the tables below this model is called "hybrid".`
        : `No target qualified, so the engine default ${DEFAULT_MIN_PRECISION} was kept (\`${version}\`). In the tables below this model is called "hybrid".`) +
      ` ${keepNote}`,
  },
  validation: slimBenchmark(validation, false),
  test: slimBenchmark(test, true),
  realTest,
  overfitting,
  gates: { ...gates, evaluatedOn: `held-out synthetic test people (${test.people}), evaluated once after the choice was made on validation` },
  monitoringReference,
  timingsMs: timings,
};
lap("report");
timings.total = Object.values(timings).reduce((s, v) => s + v, 0);

const t = testResult("hybrid");
log(
  `Test (synthetic): hybrid NDCG@3 ${t.oracle.overall["ndcg@3"]?.toFixed(3)} | popularity ${testResult("popularity").oracle.overall["ndcg@3"]?.toFixed(3)} | rules ${testResult("rules").oracle.overall["ndcg@3"]?.toFixed(3)} | v1 ${testResult("v1 forest").oracle.overall["ndcg@3"]?.toFixed(3)}; AUC ${t.logged.auc?.toFixed(3)}, ECE ${t.logged.calibration.ece.toFixed(3)}; offered to ${((t.policy?.suggestionRate ?? 0) * 100).toFixed(1)}% with false-rec ${t.policy?.falseRecRate === null ? "n/a" : ((t.policy?.falseRecRate ?? 0) * 100).toFixed(1) + "%"}`,
);
for (const g of gates.gates) log(`  gate ${g.passed ? "pass" : "FAIL"}  ${g.id}: ${typeof g.value === "number" ? g.value.toFixed(4) : "n/a"} (threshold ${typeof g.threshold === "number" ? g.threshold.toFixed(4) : "n/a"})${g.note ? ` (${g.note})` : ""}`);
log(`Gates ${gates.passed ? "passed" : "FAILED: this model must not be promoted"}. Total ${(timings.total / 1000).toFixed(1)}s.`);

// ---------------------------------------------------------------------------------------------------------------
// 11. Write
// ---------------------------------------------------------------------------------------------------------------

const metrics = registryMetrics(report);
const previous = readManifest();
const datasetMeta: DatasetMetadata = {
  version: datasetVersion,
  sourcePeriod: realPeriod,
  eligibleRecords: real.used ? real.examples : 0,
  eligibleSubjects: real.used ? real.subjects : 0,
  syntheticRecords: world.examples.length,
  excluded: real.excluded,
  criteria: real.used
    ? { ...CRITERIA, synthetic: { generator: "lib/recommender/synthetic.ts", generatorVersion: SYNTHETIC_GENERATOR_VERSION, seed: SEED, people: PEOPLE } }
    : { generator: "lib/recommender/synthetic.ts", generatorVersion: SYNTHETIC_GENERATOR_VERSION, seed: SEED, people: PEOPLE, split: "people 45/15/20/20 (fit/calibration/validation/test)" },
  preprocessingVersion,
  contentSha256: hash,
  // Keep the original creation time while the dataset is unchanged, so re-running does not churn committed files.
  createdAt: previous?.dataset.version === datasetVersion && previous.dataset.contentSha256 === hash ? previous.dataset.createdAt : now,
};

let artifactPath: string | null = null;
if (WRITE) {
  if (trainedOn === "synthetic") {
    mkdirSync(MODELS_DIR, { recursive: true });
    const file = `${version}.json`;
    const evaluation = `${version}.evaluation.json`;
    // Only one bundled model ships: remove stale synthetic artifacts written by earlier runs of this script.
    for (const f of readdirSync(MODELS_DIR)) if (f.startsWith("hybrid-") && f.endsWith(".json") && f !== file && f !== evaluation) rmSync(join(MODELS_DIR, f));
    writeFileSync(join(MODELS_DIR, file), artifactFile);
    writeFileSync(join(MODELS_DIR, evaluation), `${roundedJson(report)}\n`);
    const manifest: Manifest = { version, file, evaluation, dataset: datasetMeta, metrics };
    writeFileSync(MANIFEST_PATH, `${roundedJson(manifest, 2)}\n`);
    writeFileSync(
      INDEX_PATH,
      `// GENERATED by scripts/recommender/train.ts. Do not edit by hand.
//
// The model bundled with the app: trained on SYNTHETIC data only. Its evaluation (docs/ml-personalisation/v2/EVALUATION.md)
// shows that the pipeline works and recovers structure we wrote into the synthetic generator, not that it helps real people.
// Static JSON imports: no file system access at runtime. The backend validates the model before serving it.
import type { DatasetMetadata } from "../../server/personalisation/pipeline-store";
import type { RecommenderModel } from "../engine/index";
import manifest from "./manifest.json";
import model from "./${file}";

export const BUNDLED_MODEL = model as unknown as RecommenderModel;
export const BUNDLED_DATASET = manifest.dataset as unknown as DatasetMetadata;
export const BUNDLED_METRICS: Record<string, unknown> = manifest.metrics;
`,
    );
    writeFileSync(EVALUATION_MD, renderEvaluation(report));
    log(`Wrote ${relative(ROOT, join(MODELS_DIR, file))}, ${evaluation}, manifest.json, index.ts and ${relative(ROOT, EVALUATION_MD)}`);
  } else {
    // Models trained with real people's data never go into the repository.
    mkdirSync(PRIVATE_MODELS_DIR, { recursive: true });
    const file = join(PRIVATE_MODELS_DIR, `${version}.json`);
    writeFileSync(file, artifactFile);
    writeFileSync(join(PRIVATE_MODELS_DIR, `${version}.evaluation.json`), `${roundedJson(report)}\n`);
    writeFileSync(join(PRIVATE_MODELS_DIR, `${version}.evaluation.md`), renderEvaluation(report));
    artifactPath = relative(process.cwd(), file);
    log(`Wrote ${artifactPath} (+ evaluation): not committed`);
  }
}

if (REGISTER && store && db) {
  if (!WRITE) fail("--register needs the artifact to be written (drop --no-write)");
  store.registerDataset(db, datasetMeta);
  const synthetic = trainedOn === "synthetic";
  store.registerModel(db, {
    version,
    datasetVersion,
    algorithm: model.algorithm,
    trainedOn,
    config: { seed: SEED, minPrecision: chosenRow.minPrecision, hyper: model.hyper, ...(synthetic ? { bundled: true } : {}) },
    metrics,
    // A synthetic-only model ships inside the app (artifactPath null, hashed as JSON.stringify(model), like bootstrapModel).
    artifactPath: synthetic ? null : artifactPath,
    artifactSha256: synthetic ? sha256(artifactJson) : sha256(artifactFile),
    sizeBytes: synthetic ? Buffer.byteLength(artifactJson) : Buffer.byteLength(artifactFile),
    createdAt: now,
    notes: gates.passed ? "gates passed" : `gates failed: ${gates.gates.filter((g) => !g.passed).map((g) => g.id).join(", ")}`,
  });
  log(`Registered dataset ${datasetVersion} and model ${version} as "candidate"${synthetic ? " (bundled artifact: rebuild the app to ship it)" : ""}.`);
}
db?.close();
