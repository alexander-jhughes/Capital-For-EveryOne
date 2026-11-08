# Dial personalisation v2: contracts and ownership

Status: **agreed by the integration lead before parallel work started.** Branch `feat/ml-collaborative-personalisation`, based on PR #13 head `12b3745`.
A change to anything in this file is a contract change: raise it with the integration lead, don't work around it.

## 1. Baseline audit (what exists on `12b3745`)

| Question | Answer |
|---|---|
| Database | **None.** README: "No database, no auth: seeded data and a fixed demo date". |
| Backend persistence | None. Only `POST /api/ask` (stateless, Gemini or templates). Purchases, payments and Spend Pause live in browser storage. |
| Authentication / user ids | None. One seeded demo account. No user identifier exists. |
| Migrations | None. |
| Preferences | Cookie `cfe-prefs` (`lib/preferences/schema.ts`), view cookie `cfe-mode`, session undo history in memory. |
| ML (v1, PR #10 + #12) | On-device random forest (`lib/personalisation`), 8 binary display targets, synthetic data only, consent in `localStorage` `cfe-personalisation`, one suggestion card on Home, 209 KB model fetched after consent. No profile, no collaborative learning, no feedback leaves the device. |
| Rules fallback | "Make it yours" (`lib/preferences/recommend.ts`): published rule table, not ML. **Must keep working unchanged.** |
| Hosting | No deployment config in the repo (`next start` locally). |

## 2. Decisions

1. **Database: SQLite through Node's built-in `node:sqlite`** (Node 24.22 here; no flag, no warning). No new npm dependency, no service,
   no cost. Real SQL: foreign keys, indexes, partial unique indexes, CHECK constraints, transactions. Loaded with
   `process.getBuiltinModule("node:sqlite")` so no bundler has to resolve it. File: `PERSONALISATION_DB_PATH`, default
   `.data/personalisation.sqlite` (git-ignored). Tests use `:memory:`.
   - Limitation: needs a persistent disk (a VM, a container with a volume, or `next start` on a laptop). Serverless
     hosts with ephemeral disks need a hosted Postgres instead. The data-access layer (`lib/server/personalisation`) is the
     only code that touches SQL, so that swap is contained. A hosted database is a new service and possibly a cost:
     it needs the product owner's approval first.
   - SQLite has no row-level security. **Access control is enforced in the data-access layer**: every personal query
     goes through a repository bound to the authenticated subject (`forSubject(db, subjectId)`), and no API accepts a
     user id from the client. Tests prove cross-subject isolation.
2. **Identity: a pseudonymous subject id**, 128 random bits, in an HttpOnly, SameSite=Lax, HMAC-signed cookie
   (`cfe-pid`, path `/api/personalisation`). It is created only when the person turns personalisation on, and it is not
   linked to the card account or anything financial. Secret: `PERSONALISATION_SECRET` (32+ chars), else a random secret
   generated once into the data directory.
3. **Inference runs in Dial's own server process** (`POST /api/personalisation/recommendations`): no third party, no
   Gemini, no model download to the browser (v1 shipped 209 KB to the client). The engine is pure TypeScript with no I/O,
   so it can also run on the device later.
4. **v1 stays as the evaluated baseline.** Its engine files and tests are kept. The v1 on-device card and its
   `localStorage` state are replaced by v2 in the UI. v1 consent is **not** carried over, because v2 stores data on the
   server: the person is asked again.
5. **Gemini is never used** for scoring, similarity, ranking, feedback or inference. Nothing from personalisation is
   sent to `/api/ask`.

## 3. Consent model (three separate, optional consents)

| Consent | Default | What it allows | Withdrawing it |
|---|---|---|---|
| `personalisation` | off | Store the "About you" answers, settings snapshot, signals, suggestions and feedback under a pseudonymous id, and get suggestions | Deletes **everything** for that subject (cascade) and the cookie |
| `collaborative` | off; requires `personalisation` | This person's feedback may be included, de-identified, in future training datasets | Excluded from every future dataset immediately. Already-trained models keep only aggregate parameters |
| `research` | off; requires `personalisation` | Store an optional age band, used **only** for aggregate fairness checks, never to recommend | Deletes the age band |

No cookie, no row and no model work happens before `personalisation` is granted.

## 4. Configuration space (`lib/recommender/catalog.ts`)

16 items over 10 dimensions, all of which exist in the app. One value per dimension, listed conflicts
(`view.detailed` with `density.calm`), at most 4 changes per suggestion. Never suggested: lowering an accessibility
setting, theme, anything on a dimension the person set themselves (`explicit`). Answer length (`answerStyle`) is
waiting for `feat/dial-intelligence` to land.

## 5. Profile (`lib/recommender/profile.ts`)

11 optional questions in three sections (money and apps, how you like to use Dial, accessibility: screen reader only).
Accessibility *settings* are not re-asked: they live in Display and voice and are explicit. `ResearchAnswers` (age band)
is a separate type and never part of `RecommenderInput`.

## 6. Ownership (no two workstreams write the same file)

| Workstream | Owner | Files (create/modify only these) |
|---|---|---|
| WS1 architecture, contracts | Integration lead | `lib/recommender/{catalog,profile,types,random}.ts`, `docs/ml-personalisation/v2/CONTRACT.md`, `docs/ml-personalisation/v2/ARCHITECTURE.md` |
| WS2+3 profiling, features, hybrid engine | Agent "engine" | `lib/recommender/engine/**` (incl. tests) |
| WS4 database, backend, APIs | Agent "backend" | `lib/server/**` (migrations are TypeScript modules in `lib/server/db/migrations`, so nothing reads files at runtime), `app/api/personalisation/**`, `docs/ml-personalisation/v2/{DATABASE,API}.md` |
| WS5 synthetic data, training, evaluation, fairness, versioning | Agent "training" | `lib/recommender/synthetic.ts`, `lib/recommender/evaluation/**`, `lib/recommender/models/**`, `scripts/recommender/**`, `docs/ml-personalisation/v2/{EVALUATION,SYNTHETIC-DATA,FAIRNESS,PIPELINE}.md` (+ tests) |
| WS6 application integration, QA | Integration lead | `lib/personalisation/{provider.tsx,controller.ts,client.ts}`, `components/personalise/{ml-suggestion,suggestions-settings,about-you}.tsx`, `app/(dial)/account/personalise/about-you/page.tsx`, one swap in `components/settings/display-settings.tsx`, `.gitignore` |

Nobody edits: `lib/ai`, `app/api/ask`, `lib/finance`, `lib/payments`, `lib/spend-pause`, `lib/state`, Pay/Spend Pause
screens, `package.json`, `package-lock.json`, `lib/preferences/**`, the v1 engine files in `lib/personalisation`
(except the WS6 files above). No git commands that change state (commit, checkout, stash, reset): the lead commits.

## 7. Interfaces between workstreams

### Engine (WS2+3) → everyone: `lib/recommender/engine/index.ts`

```ts
export type RecommenderModel = ModelHeader & { /* engine-specific body */ };
export function isValidRecommenderModel(x: unknown): x is RecommenderModel;
export function recommend(model: RecommenderModel, input: RecommenderInput, options?: RecommendOptions): RecommendationResult;
export function scoreItems(model: RecommenderModel, input: RecommenderInput): ItemScore[]; // all items, no eligibility filtering
export function trainRecommender(train: TrainingExample[], validation: TrainingExample[], options: TrainOptions): RecommenderModel;
export interface TrainOptions { seed: number; version: string; datasetVersion: string; trainedOn: "synthetic" | "synthetic+real"; /* hyper-parameters with defaults */ }
// For benchmarking each part on its own:
export type Scorer = (input: RecommenderInput) => Partial<Record<ItemId, number>>; // probabilities
export function trainComponentScorers(train: TrainingExample[], options: TrainOptions): { content: Scorer; collaborative: Scorer; factorization: Scorer; popularity: Scorer };
export const FEATURE_IDS: readonly string[];
export function encode(input: RecommenderInput): number[];
```

### Backend (WS4) → training (WS5): `lib/server/personalisation/pipeline-store.ts`

```ts
export function openDatabase(path?: string): Database;               // runs migrations
export function exportEligibleTrainingData(db, criteria: EligibilityCriteria, now: number): EligibleExport;
export function purgeExpired(db, now: number): Record<string, number>;
export function registerDataset(db, meta: DatasetMetadata): void;
export function registerModel(db, record: ModelRecordInput): void;   // status "candidate"
export function activateModel(db, version: string, now: number): void; // previous active -> retired, rollback_to = previous
export function rollbackModel(db, now: number): string;              // re-activates rollback_to, returns its version
export function getActiveModelRecord(db): ModelRecord | null;
export function listModels(db): ModelRecord[];
export function monitoringSnapshot(db, since: number): MonitoringSnapshot; // aggregates only, no subject ids
```

### Training (WS5) → backend (WS4): `lib/recommender/models/index.ts`

```ts
export const BUNDLED_MODEL: RecommenderModel;           // committed, synthetic-only, static import (no fs at runtime)
export const BUNDLED_DATASET: DatasetMetadata;           // metadata of the synthetic dataset it was trained on
export const BUNDLED_METRICS: Record<string, unknown>;  // headline evaluation numbers for model_versions.metrics
```
Until WS5 commits a trained model, WS4 tests use a model trained in-test on a tiny fixture.

### Backend (WS4) → integration (WS6): HTTP under `/api/personalisation` (JSON only, `Cache-Control: no-store`)

| Method and path | Body | Response |
|---|---|---|
| `GET /` | | `{ available, consent: {personalisation, collaborative, research}, profile: {answers, answered} \| null, research: {ageBand?} \| null, model: {version, trainedOn} \| null }`. Never creates a session. |
| `PUT /consent` | `{ personalisation?, collaborative?, research? }` booleans | same as `GET /`. Granting personalisation sets the cookie; withdrawing it deletes everything and clears it. 409 if collaborative/research without personalisation. |
| `PUT /profile` | `{ answers }` | `{ answers, answered }`. 400 on any unknown question or value. |
| `PUT /research` | `{ ageBand? }` | `{ ageBand? }`. 403 without research consent. Missing `ageBand` deletes it. |
| `POST /signals` | `{ signals: [{ id: SignalId, source: SignalSource }] }` (max 20) | `202 { accepted }`. Daily cap per subject. |
| `POST /recommendations` | `{ preferences, view, explicit: Dimension[] }` | `{ recommendation: { id, modelVersion, trainedOn, configuration, alternatives, explanation, warnings } \| null, status, warnings }`. Stores the settings snapshot. Re-uses an open, identical recommendation from the last 24 hours. |
| `POST /recommendations/:id/feedback` | `{ outcome: FeedbackOutcome, items?: ItemId[], via?: "card" \| "undo" \| "settings" \| "reset" }` | `{ ok: true }`. 404 if not this subject's. `items` must belong to that recommendation. |
| `POST /recommendations/:id/rating` | `{ satisfaction: -1 \| 0 \| 1 }` | `{ ok: true }` ("Did this make Dial easier to use?") |
| `GET /export` | | everything stored about this subject, as JSON |
| `DELETE /` | | `{ deleted: true }`, clears the cookie |
| `GET /model` | | public: active model `{ version, algorithm, trainedOn, createdAt, metrics }` |

Errors: `{ error: string }` with 400 (validation), 401 (no session), 403 (no consent), 404, 409, 413 (body over 16 KB),
415 (not JSON), 429 (rate limit), 503 (database unavailable: the app carries on without suggestions).
Mutations check `Origin`/`Sec-Fetch-Site` against the host.

### Voice / Dial layer → ML (for the voice developer, `feat/dial-intelligence`)

```ts
const { noteSignal, noteVoiceOpened, recommendation } = usePersonalisation();
noteSignal("shorterAnswers", "voice"); // structured, allowlisted ids only (SIGNAL_IDS). Ignored without consent.
```
Accepted: allowlisted signal ids with a source. Never accepted: audio, transcripts, questions, answers, transactions,
anything inferred. Display changes kept through Voice Mode are counted automatically from the preferences events
(`source: "voice"`). The recommendation is **executed only by the trusted preview → "Keep it" path**
(`StylePreviewProvider.startRequest`), never by the model.

## 8. Eligibility and labels for training

- Only subjects with `personalisation` **and** `collaborative` consent granted at export time.
- Only feedback at least 24 hours old (the undo window settles), at most 365 days old, at most 50 examples per subject.
- Labels per item: `accepted`/`modified` kept item and not reverted (via undo or settings) and not rated -1 → 1.
  `rejected`, `modified` removed item, `reverted` (not via reset), rated -1 → 0. `dismissed` ("Not now") and resets → no label.
- The input is the snapshot stored with the recommendation (point in time), never today's profile.
- Exported examples carry a per-export random id, never the stored subject id. Datasets are not stored as copies:
  only their metadata (counts, criteria, period, content hash).

## 9. Retention

Signals 180 days. Recommendations and feedback 365 days. Subjects not seen for 400 days are deleted. Purge runs at most
hourly on API use and at the start of every training run.
