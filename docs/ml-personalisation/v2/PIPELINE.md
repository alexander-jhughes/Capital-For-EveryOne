# Dial personalisation v2: from feedback to a deployed model

> The only model trained so far was trained and evaluated on **synthetic data** (SYNTHETIC-DATA.md). Its numbers show the
> pipeline works and that the model recovers structure we wrote into the generator. They do not show that it helps real
> people. Real feedback enters training only when the thresholds below are met, and nothing here has been validated with
> real users.

Code: `scripts/recommender/{train,promote,rollback,models,monitor,common}.ts`, `lib/recommender/evaluation/*`,
`lib/recommender/models/*`. Database access goes only through the backend's `lib/server/personalisation/pipeline-store.ts`
(CONTRACT.md §7); the scripts load it only when `--db <path>` is given.

All commands: `node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/recommender/<script>.ts …`

## 1. The loop in ten steps

1. **Consent and context.** A person turns on personalisation (and, separately, collaborative learning). The app sends
   settings, view and explicit dimensions; the backend adds the stored answers, signals and history and calls `recommend()`.
2. **Suggestion and snapshot.** The suggestion, all item scores and the input snapshot are stored with the recommendation
   (point in time, so training never uses today's profile for yesterday's suggestion).
3. **Feedback.** Keep / "No thanks" / "Not now" / partial keep, later undo (Undo or Settings), optional rating.
4. **Settling.** Feedback is used only once it is at least 24 hours old (the undo window).
5. **Retention purge.** Every training run first calls `purgeExpired` (signals 180 days, recommendations and feedback 365
   days, people not seen for 400 days).
6. **Eligible export.** `exportEligibleTrainingData` with `{ requireCollaborativeConsent: true, minAgeHours: 24,
   maxAgeDays: 365, maxExamplesPerSubject: 50 }`: only people with both consents *now*, labels per CONTRACT.md §8, a fresh
   random id per person per export, never the stored subject id, never research data.
7. **Data-quality checks** (§4). Any error stops the run.
8. **Train** the hybrid (engine `trainRecommender`) on synthetic data, plus the real examples if there are enough (§3);
   train component ablations and baselines; choose the precision target on validation people (§6).
9. **Evaluate once on test people, gate, version, register.** Write the artifact and its evaluation; with `--register`,
   record the dataset metadata and the model as a `candidate`. A human runs `promote.ts`, which refuses anything that failed
   a gate. The app loads the active model with a hash and validation check and falls back to the bundled model on any problem.
10. **Monitor** input drift and feedback bias (§9). Roll back (`rollback.ts`) or retrain when warnings persist.

## 2. Splits (people, never examples)

| Part | Share | Used for |
|---|---|---|
| fit | 45% | the engine's components (content, collaborative, factorisation, popularity) |
| calibration | 15% | the engine's stacker and per-item thresholds (`trainRecommender`'s `validation` argument) |
| validation | 20% | choosing the precision target only (§6) |
| test | 20% | the report and the gates, once, after the choice |

Component ablations are trained on the fit people (the same data as the hybrid's own components); popularity and rules on
fit + calibration. Real people are split the same way by their per-export id.

## 3. Minimum samples before real data is used

Real examples are added only if the export has **≥ 200 people** and **≥ 30 labelled examples for every one of the 16
items**. Otherwise the run is synthetic-only and the report says why (e.g. "only 12 eligible people"). The engine needs
≥ 100 calibration examples to fit its stacker; thresholds need ≥ 20 offers at the target precision on calibration data.
Real held-out examples are evaluated on logged feedback only (there is no hidden truth for real people) and reported separately.

## 4. Data-quality checks (`lib/recommender/evaluation/quality.ts`)

Run on every example before training; errors stop the run.

- **Schema**: known item; label 0/1; positive finite weight; source; exactly the six input keys; answers pass
  `isValidAnswers`; preferences equal `sanitize(preferences)`; view; explicit dimensions valid and unique; signal ids
  known, integer counts 0–10; history entries valid and in time order.
- **Product policy**: the item was not already active and not on an explicit dimension.
- **Research data**: any age band (key or value) anywhere in an input is an error.
- **Duplicates**: exact (subject, item, label, input) duplicates are counted (warning).
- **Label balance**: per item, fewer than 30 labelled examples or a rate outside 2–98% is a warning.
- **Split leakage**: any subject in two of train / validation / test is an error.

## 5. Versioning and reproducibility

| Thing | Name | Example |
|---|---|---|
| synthetic dataset | `syn.g<generator>.s<seed>[.n<people>]` | `syn.g2.s20261108` |
| with real data | `<synthetic>+real-<yyyymmdd>-<sha8>` | `syn.g2.s20261108+real-20270115-1a2b3c4d` |
| model | `hybrid-2.0.0+<dataset tag>.mp<precision target>` | `hybrid-2.0.0+syn.g2.s20261108.mp60` |
| preprocessing | `features-<sha12 of FEATURE_IDS>.profile-v<n>` | changes whenever the encoding changes |

- Everything is seeded; the same seed gives the same world, splits and artifact. `train.ts --check` retrains from scratch
  and compares the artifact **byte for byte** with the committed one (exit 1 if different).
- Every dataset has a sha256 over its examples in a canonical form; the dataset itself is never stored, only its metadata
  (`registerDataset`).
- Every artifact has a sha256 (`registerModel`); the app refuses an artifact whose bytes no longer match.
- **Synthetic-only** models are committed: `lib/recommender/models/<version>.json`, `<version>.evaluation.json`,
  `manifest.json` (dataset metadata and registry metrics) and the generated `index.ts` (`BUNDLED_MODEL`, `BUNDLED_DATASET`,
  `BUNDLED_METRICS`, static imports, no file system at runtime). The app registers and activates this bundled model on first use.
- Models trained **with real data** are written to `.data/models/` (git-ignored) with their evaluation, and are **never
  committed**. EVALUATION.md in the repository only ever describes the synthetic bundled model.
- Bump the `hybrid-2.0.0` family version for any change to features, engine or pipeline; the registry refuses to
  re-register a version with a different artifact.

## 6. Choosing the precision target (reach vs wrong suggestions)

The engine suggests an item only above a per-item threshold chosen on calibration data to reach a target precision
(`minPrecision`). Higher targets mean fewer, safer suggestions. The pipeline trains the hybrid for
minPrecision ∈ {0.60, 0.65, 0.70, 0.75} and, **on validation people only**, deploys the **lowest** target whose offered
items have a synthetic false-recommendation rate (true benefit ≤ 0) of at most 15% over at least 20 offered items; if
none qualifies it keeps the engine default 0.75. The integration lead set this rule after seeing how few items get a threshold at the engine default, but before the sweep was run. It is a
product trade-off between reach and wrong suggestions, decided on synthetic data: it must be revisited with real feedback.
The full sweep is in EVALUATION.md §10.

## 7. Promotion gates (`lib/recommender/evaluation/gates.ts`)

Evaluated on test people, once. A failing gate means "do not deploy", never "tune until it passes".

| Gate | Rule |
|---|---|
| beats popularity | oracle NDCG@3 > popularity's |
| beats v1 | oracle NDCG@3 > the v1 random forest's |
| false recommendations | offered-item false-rec rate ≤ the active model's + 0.01 (reported, not gated, when there is no other active model) |
| calibration | ECE (10 bins) on held-out logged feedback ≤ 0.05 |
| fairness | worst-group / best-group NDCG@3 ≥ 0.8 within every group family, including age band (FAIRNESS.md) |
| size | artifact ≤ 2,000,000 bytes |
| latency | p95 of one `recommend()` call ≤ 10 ms |

Gate results are stored in the registry (`metrics.gates`). `promote.ts --db <path> --version <v>` refuses a model whose
gates failed or were never run, a rejected model, and an artifact that is missing, altered or invalid for this engine.

## 8. Promote and roll back

```
train.ts --db .data/personalisation.sqlite --register     # candidate
models.ts --db .data/personalisation.sqlite                # list, with gates and headline metrics
promote.ts --db .data/personalisation.sqlite --version <v> # activate (previous active -> retired, remembered for rollback)
rollback.ts --db .data/personalisation.sqlite              # re-activate the previous model, one step back per run
```

The app re-reads the active model on its next load. If the active artifact is missing, altered or invalid, the app serves
the bundled synthetic model instead (logged once), so a bad artifact cannot take suggestions down.

## 9. Monitoring (`monitor.ts`, `lib/recommender/evaluation/monitoring.ts`)

`monitor.ts --db <path> [--days 30] [--json]` reads `monitoringSnapshot` (aggregates only, no subject ids) and compares it
with the training distribution stored in the active model's metrics (`monitoringReference`). Exit code 2 when there are warnings.

- **Input drift**: population stability index per answer (including "skipped"), view, each active item and each explicit
  dimension. PSI > 0.1 is a moderate shift, > 0.25 a large one. A large shift means the live population no longer looks
  like the training data (for a synthetic-trained model, it never really did: expect drift, and read it as "how different").
- **Feedback bias**: kept rate more than 15 points below the training data's; rank 2 kept more often than rank 1 (ranking or
  position bias); "limited"-evidence suggestions kept more often than "strong" ones; an item kept under 5% of the time;
  two items making up over 80% of suggestions (a self-reinforcing popularity loop); over 30% of ratings unhelpful; undo over
  30% of decisions. Each needs at least 30 cases.
- The model only learns from what it showed. Exploration in the synthetic logs came from the logging mixture; live
  suggestions come from the model alone, so feedback loops are a real risk. Watch the concentration and per-item warnings,
  and prefer retraining with fresh data over tightening thresholds.

## 10. Retention and consent interplay

- Purge runs before every export, so expired data never reaches a dataset.
- Withdrawing collaborative consent excludes a person from every **future** export immediately. Already-trained models keep
  only aggregate parameters (no examples, no subject ids); they are not retrained retroactively, but they age out as new
  models replace them, and feedback older than 365 days is never used.
- Withdrawing personalisation deletes everything for that person, including feedback a future export would have used.
- Datasets are never stored as copies: only metadata (counts, criteria, period, preprocessing version, content hash).
- Research data (age band) is never exported for training.

## 11. Limitations

- The bundled model is synthetic-trained. Its first contact with real people is the first real test; monitor closely.
- Logged evaluation inherits exposure bias; there is no off-policy correction yet (the scores logged with each
  recommendation make inverse-propensity estimates possible later).
- The gates measure synthetic truth; with real data only the logged-feedback gates (calibration) carry over directly.
