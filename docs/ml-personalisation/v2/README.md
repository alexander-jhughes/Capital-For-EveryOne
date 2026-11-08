# Dial personalisation v2: collaborative, database-backed suggestions

Dial suggests a small, compatible set of display changes, such as Simple view, a calmer home screen or larger text.
The suggestions are based on what helped people who gave similar, optional answers. The person previews, keeps, partly
keeps, turns down or puts off each suggestion, and can undo it later. Their feedback can (with separate consent) train
future model versions.

> **Synthetic only.** The model is trained and evaluated on synthetic people we generated. The results show the pipeline
> works and the model recovers structure we wrote into the generator. They do **not** show that it helps real people.

| Read | For |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | v1 audit, approaches compared, architecture diagram, feedback loop |
| [CONTRACT.md](CONTRACT.md) | Decisions, consent model, configuration space, ownership, interfaces between parts |
| [DATABASE.md](DATABASE.md) | Schema, migrations, access control, retention, deletion |
| [API.md](API.md) | `/api/personalisation` endpoints |
| [SYNTHETIC-DATA.md](SYNTHETIC-DATA.md) | How the synthetic people and their feedback are generated |
| [EVALUATION.md](EVALUATION.md) | Generated report: baselines, cold start, groups, calibration, latency, gates |
| [FAIRNESS.md](FAIRNESS.md) | Groups checked, demographic safeguards |
| [PIPELINE.md](PIPELINE.md) | Training, quality checks, versioning, promotion, rollback, monitoring |

## Run it

```bash
npm run build && npm start      # creates .data/personalisation.sqlite on first use (git-ignored)
```

Optional environment variables:
- `PERSONALISATION_DB_PATH`: where the SQLite file lives.
- `PERSONALISATION_SECRET`: 32+ characters, signs the pseudonymous cookie. If it isn't set, a random secret is generated into the data directory.

Training and model operations use Node 24 and need no extra packages:

```bash
R="node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs"
$R scripts/recommender/train.ts --check                          # retrain; byte-for-byte check against the committed model
$R scripts/recommender/train.ts --db .data/personalisation.sqlite --register   # + eligible real feedback, register a candidate
$R scripts/recommender/models.ts   --db .data/personalisation.sqlite
$R scripts/recommender/promote.ts  --db .data/personalisation.sqlite --version <version>
$R scripts/recommender/rollback.ts --db .data/personalisation.sqlite
$R scripts/recommender/monitor.ts  --db .data/personalisation.sqlite
```

## Headline numbers (synthetic test people, reported once)

| System | NDCG@3 | Notes |
|---|---|---|
| **Hybrid (deployed)** | **0.548** | Logged AUC 0.720, calibration error 0.013, 52 KB, `recommend()` p95 about 0.1 ms |
| Factorisation alone | 0.546 | Stacking adds very little to ranking; it mainly gives calibrated probabilities |
| Content-based alone | 0.544 | |
| Collaborative alone | 0.434 | |
| Rules ("Make it yours") | 0.417 | |
| Popularity | 0.391 | |
| v1 random forest | 0.369 | Can't see the new profile answers |

What is actually offered depends on the precision target, which was chosen on validation people only (sweep in EVALUATION.md):
- The deployed model offers something to about 10% of people.
- About 13% of what it offers wouldn't help that person, against 48% for the rules.
- Because the rules reach far more people, their total expected benefit per person is higher.
- Cold start: NDCG@3 is 0.477 with no answers and 0.563 with 5 or more.
- The worst/best group ratio is at least 0.90 in every group family, including age band, which is never a model input.

## Known limitations

- **Synthetic data only.** Benefit to real people is unproven. It needs a consented pilot that measures task success directly.
- **Low reach.** Only 5 of the 16 settings currently qualify to be suggested. Most suggestions are a single change, usually Simple view, and combinations are rare.
- **Single server.** SQLite needs one server process on a persistent disk. Serverless hosting would need hosted Postgres, which needs approval.
- **In-memory rate limits.** Before a session exists, they trust `X-Forwarded-For`. Put the app behind a proxy that sets that header.
- **One browser per identity.** The pseudonymous identity is per browser, so there is no cross-device sync without real accounts.
