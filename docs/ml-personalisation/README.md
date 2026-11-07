# ML personalisation engine

A small, trained machine-learning model that works in the background. It looks at the display settings a person has **explicitly** chosen, and (with their consent) at counts of explicit display actions, and predicts which *other* presentation settings they might like. Dial can then **ask**: "Would you like me to make the text larger?" The person can say yes, no, or ignore it. **The model never changes the interface by itself.**

> **Status: prototype, trained on synthetic data only.** It is a working, tested ML pipeline. It has not been validated on real people (see [Limitations](#limitations)).
> **Integration: proposed contract, not wired in.** No frontend, Gemini backend, shared-state or package files were changed. The [contract](#frontend-integration-contract-proposed) needs agreement with the frontend lead.

- Generated metrics and example predictions: [`EVALUATION.md`](./EVALUATION.md)
- Code: `lib/personalisation/` · Training script: `scripts/personalisation/train.ts`

---

## Contents

1. [How it fits in](#how-it-fits-in)
2. [Why a random forest](#why-a-random-forest)
3. [Inputs and privacy](#inputs-and-privacy)
4. [Synthetic training data](#synthetic-training-data)
5. [Training](#training)
6. [Evaluation](#evaluation)
7. [Inference](#inference)
8. [Frontend integration contract (proposed)](#frontend-integration-contract-proposed)
9. [Reproducing the model](#reproducing-the-model)
10. [Limitations](#limitations)
11. [Files](#files)

---

## How it fits in

```
 explicit settings (cfe-prefs)      "Make it yours" ticks      action counts (on device, consented)
            │                               │                              │
            └───────────────┬───────────────┴──────────────────────────────┘
                            ▼
                 feature extraction (allowlist, 28 numbers)          lib/personalisation/features.ts
                            ▼
          random forest per setting: P(person keeps it if offered)   lib/personalisation/forest.ts + model.json
                            ▼
   gates: consent · already on · supported · trained threshold ·     lib/personalisation/infer.ts
          rejected before · conflicting signals · explainable
                            ▼
      PersonalisationResult { preferences[], confidence, reasons, offer, modelVersion }
                            ▼
      Dial asks  ──►  yes: PreferencesProvider.startPreview(actions) → keep / undo (existing flow)
                 ──►  no / ignore: recordOutcome() so it isn't repeated
```

**Where it runs: in the browser, on the device.** Inference is a pure TypeScript function (measured at about 0.006 ms per call, after a one-off ~3 ms model check). The trained model is a JSON file loaded with a dynamic `import()`, so the bundler can split it out of the first page load (not yet observed in a build, because no page imports the engine until the frontend wires it in). I chose this over a server route because:

- preferences already live in the browser (cookie plus `sessionStorage`), so nothing has to leave the device;
- the app has no database or user accounts to store server-side profiles in;
- it keeps working offline and with no API key, like the rest of the app;
- there's no new endpoint to secure or rate-limit.

**Separate from Gemini.** The Gemini assistant (`lib/ai`, `POST /api/ask`) answers financial questions. This engine only predicts how the interface should look. The two share no code, data or endpoints: the engine never sees questions or answers, and the assistant never sees personalisation data.

## Why a random forest

I compared three supervised classifiers, all trained on the same data (see [Evaluation](#evaluation)):

| Option | Strength | Weakness here | Result |
|---|---|---|---|
| Decision stump (1 split) | Trivially explainable | Can only use one signal at a time | Baseline only |
| Single decision tree (CART, depth 8) | Explainable path | High variance: train/test AUC gap up to 0.074 | Lower test AUC on every target |
| **Random forest (30 trees, depth 5)** | Best test AUC and Brier on every target; train/test gap ≤ 0.035; vote average gives a usable probability | Less transparent than one tree | **Chosen** |

Why it suits this problem:

- **Small, mixed, partly missing inputs.** Trees handle settings, ticks and counts together without scaling, and they learn to treat "missing" (encoded as -1) as information.
- **Interactions.** "Hid a section" *and* "asked for less" means more than either alone. Trees capture this without hand-written rules.
- **Explainable.** Each prediction splits exactly into a per-feature contribution: follow every tree's path and credit each change in probability to the feature that was split on (the "tree interpreter" method). The reasons people see come from this, filtered to things they actually did.
- **No dependency.** Training and inference are about 200 lines of TypeScript (`forest.ts`). The repo has no ML library and package changes need approval. A Python/scikit-learn pipeline would add a second toolchain for a 200 KB artifact.

Logistic regression would also be viable. Trees were preferred because of the interactions and the missing-value handling above.

## Inputs and privacy

The model reads **only** these 28 features (`lib/personalisation/features.ts`). Everything else passed in is ignored, and a test passes transactions, balances, age and spending in and checks the output is identical.

| Group | Features | Source |
|---|---|---|
| Explicit settings (13) | text size, contrast, spacing, motion, theme, button size, calm density, step-by-step, voice-first, bill at top, chart on home, number of hidden sections, Simple/Detailed view | `Preferences` from `lib/preferences/schema.ts` and the view cookie |
| "Make it yours" ticks (9) | the nine checkboxes, or *missing* if never done | PR #9's `CHOICES` |
| Action counts (6) | made text bigger · made text smaller · opened Voice Mode · asked for less on screen · asked for more detail · undid a display change | counted on the device, **only after consent**, capped at 10, no timestamps or content |

**What it never does**

- It never uses transactions, spending, balances, payments or anything from `lib/finance` / `lib/ai`.
- It never infers or labels disability, neurodivergence, health, age or vulnerability. The targets are **interface settings**. The hidden variables in the synthetic data are interface *tastes* ("likes a calm screen"), never conditions. A test bans diagnostic, age and vulnerability wording from every title, question and reason.
- It keeps no hidden score. The result contains suggestions, their confidence, and reasons a person can read, nothing else. A test pins the exact result shape.
- It never makes financial decisions or touches account data. The only possible outputs are allowlisted `UiAction` shapes that the existing preferences reducer already accepts.
- It never applies anything. It returns suggestions, and the frontend previews one only after the person says yes.

**Control**

| Person does | Effect |
|---|---|
| Hasn't been asked | `status: "needs_consent"`. Nothing is counted or predicted. |
| Says no / turns it off | `setConsent(state, false)` **deletes** every count and answer. `status: "disabled"`. |
| Says no to a suggestion | Not offered again while their settings are unchanged. Never offered again after 2 noes. |
| Ignores a suggestion | Held back until their settings change. |
| Resets personalisation | `resetPersonalisation()` / `clearState()` forget everything and keep the on/off choice. |

State is stored in `localStorage` under `cfe-personalisation`, with every read and write in `try/catch`. It is sanitised on load. It is never sent anywhere.

## Synthetic training data

**No real person's data exists for this, so every training row is synthetic** (`lib/personalisation/synthetic.ts`, generator version 1, seed `20261107`).

How a synthetic person is made:

1. **Hidden tastes.** Nine numbers in [0, 1]: `readable, calm, visual, guided, talk, still, contrast, billFirst, detail`. Each is drawn from a mixture of 7 loose bundles (for example "likes calm screens and the bill up front", or "no strong preference" at 30%), plus Gaussian noise (σ = 0.18). These describe tastes in how an interface looks, not who someone is.
2. **Settings they saved.** Each person gets an *engagement* level (many people never open settings). A setting is on with probability `engagement × sigmoid(9 × (taste − 0.6))`. Theme is random on purpose (an irrelevant feature). 30% of people use the older redesign schema, with no step-by-step or voice-first settings.
3. **"Make it yours".** 45% did it. Each box is ticked with probability `0.03 + 0.9 × sigmoid(8 × (taste − 0.6))`.
4. **Action counts.** 60% consented. Counts are Poisson, with rates rising with the related taste. They depend only weakly on engagement, because people ask Dial for bigger text in a session without ever saving a setting. "Undid a change" is pure noise.
5. **Labels.** "Would keep setting X if offered" ~ Bernoulli(`sigmoid(10 × (taste − 0.55))`), then 5% of labels are flipped to model people changing their minds.

The model only ever sees steps 2–4. It is never given the tastes or the formulas.

**Generator decision to know about:** the first version tied action counts strongly to settings engagement. That made the people who still had a setting *off* (the only ones who can be offered it) almost silent, and the model could rarely be confident. Weakening that link (step 4) was a modelling assumption about real behaviour. It was not tuned on test data, but it does shape the results.

**Splits:** 20,000 people, shuffled with a seed, then split into 60% train, 20% validation (threshold selection only) and 20% test (reporting only). Each person is in exactly one split. For each target, only people with that setting **off** are used, because those are the only people who could be offered it. Without this, "already has 150% text" would trivially predict "likes larger text" and inflate every metric.

## Training

`trainModel()` in `lib/personalisation/train.ts` is pure and deterministic:

1. Generate synthetic people and turn them into features with **the same `extractFeatures()` used at inference** (no train/serve skew).
2. For each of the 8 targets: train a 30-tree forest (bootstrap samples, Gini, max depth 5, min leaf 30, 6 of 28 features per split). For comparison, also train a stump and a single deep tree.
3. **Choose a threshold on validation data:** the lowest of 0.60, 0.65 … 0.95 at which at least 80% of people offered the suggestion would keep it, with at least 20 offers. **If none qualifies, the target gets no threshold and is never offered.**
4. Evaluate everything on the untouched test set and write `model.json` and `EVALUATION.md`.

Hyperparameters were compared on **validation** AUC (feature subsets of 6/10/15, depth 5–7, min leaf 15–30). All were within 0.002 of each other, so the smallest model was kept.

## Evaluation

Full tables are in [`EVALUATION.md`](./EVALUATION.md). Test set, eligible people only:

| Target | Test AUC: stump → single tree → **forest** | Brier: majority → **forest** | Offered? (validation-chosen threshold) | Test: kept by |
|---|---|---|---|---|
| Larger text | 0.602 → 0.691 → **0.711** | 0.185 → **0.159** | yes, ≥ 0.65 | 92.7% of 55 |
| Calmer home screen | 0.593 → 0.770 → **0.783** | 0.204 → **0.158** | yes, ≥ 0.60 | 85.4% of 253 |
| Talking to Dial first | 0.639 → 0.693 → **0.714** | 0.153 → **0.130** | yes, ≥ 0.65 | 87.5% of 32 |
| Chart near the top | 0.670 → 0.686 → **0.709** | 0.180 → **0.159** | no | n/a |
| Step-by-step | 0.637 → 0.692 → **0.716** | 0.196 → **0.174** | no | n/a |
| Next payment at the top | 0.552 → 0.650 → **0.670** | 0.190 → **0.177** | no | n/a |
| Stronger contrast | 0.550 → 0.596 → **0.617** | 0.157 → **0.149** | no | n/a |
| Less animation | 0.538 → 0.584 → **0.597** | 0.166 → **0.162** | no | n/a |

How to read this:

- **The forest beats every baseline on every target**, for both ranking (AUC) and probability quality (Brier).
- **No meaningful overfitting.** Forest train-minus-test AUC is between −0.013 and 0.035. The single tree's is up to 0.074.
- **It is deliberately cautious.** Only 3 of 8 settings clear the 80% bar, and those are offered to 1–7% of eligible people. **Recall is low (5–21%) by design**: a suggestion nobody wanted costs more than a missed one, because the person can always change settings themselves. The other 5 settings exist in the code and are reported, but the model withholds them (`not_reliable`) until better data says otherwise.
- Motion and contrast are hardest because, in the generator, their tastes leave weak traces in the other signals. That's a property of the synthetic data, not a finding about people.

### Example predictions

From `lib/personalisation/examples.ts`. Full inputs are in `EVALUATION.md`.

| Person | Result |
|---|---|
| Text at 150%, made text bigger ×3, asked for less on screen ×3 (**the brief's example**) | `no_recommendation`. Calm layout scores 0.53, below its 0.60 threshold. In the synthetic data, people who ask for less usually also hide something, so this exact pattern is thin evidence. |
| Same, and also **hid a section** | **Offers a calmer home screen (0.78).** "You hid a section on your home screen; You asked for less on screen 3 times; You use Simple view" |
| Bigger buttons, talked to Dial ×6 | **Offers talking first (0.68).** "You've talked to Dial 6 times; You chose bigger buttons; You use Simple view" |
| Ticked larger text / contrast / less info, kept standard look, made text bigger ×2 | **Offers larger text (0.71).** "You made the text bigger twice; In "Make it yours" you ticked "Larger text"; …" |
| Asked for less ×4 *and* more detail ×4 | Calm layout withheld: `conflicting_signals` |
| Nothing changed | `insufficient_data` |
| Talks to Dial, on the redesign schema (no voice-first setting) | voice-first and step-by-step withheld: `not_supported` |
| Not asked about personalisation yet | `needs_consent` (nothing predicted) |

## Inference

`recommendPreferences(input, state, model, options?)` in `lib/personalisation/infer.ts`. It is pure, synchronous and **never throws**.

1. Consent: not granted → `needs_consent` / `disabled`.
2. Model missing or fails `isValidModel()` (format, version, exact feature order, every tree index in range, no cycles, probabilities in [0, 1]) → `unavailable`.
3. No preferences, or nothing beyond the defaults → `insufficient_data`.
4. For each setting, it is withheld if: already on · not in this app's schema · no trained threshold · rejected (same settings, or twice) · ignored (same settings) · conflicting explicit signals · probability not finite · below `max(threshold, 0.6)` · **no reason based on something the person did**.
5. Calm layout and chart-at-top both reshape the home screen, so only the more confident one is offered.
6. At most 3 suggestions are returned, most confident first, with one combined question for Dial.

Measured on a laptop (Node 24): about 0.006 ms per call on the full recommendation path. The model is structurally validated once per loaded model (about 3 ms) and then cached. The test allows 2 ms per call.

## Frontend integration contract (proposed)

**Not yet agreed with the frontend lead, and nothing in their files was changed.** Everything below is a proposal to review together.

```ts
import {
  getPersonalisation, loadState, saveState, setConsent, recordSignal, recordOutcome,
  resetPersonalisation, signalForAction, type PersonalisationResult,
} from "@/lib/personalisation";

interface PersonalisationInput {
  preferences?: PreferenceSnapshot | null; // pass `prefs` from usePreferences() as-is (either schema)
  view?: "simple" | "complex" | null;      // from useMode()
  choices?: readonly string[] | null;      // "Make it yours" ticks; null if never done
}

interface PersonalisationResult {
  status: "ok" | "no_recommendation" | "needs_consent" | "disabled" | "insufficient_data" | "unavailable";
  recommendedLayout: "calm" | "visual" | "voice" | null; // matches "Make it yours" style ids
  preferences: {
    target: TargetId;          // stable id for accept/reject
    title: string;             // "Larger text"
    offer: string;             // "Would you like me to make the text larger?"
    actions: SuggestedAction[];// UiAction-shaped, pass to startPreview()
    confidence: number;        // 0-1
    reasons: string[];         // never empty
  }[];
  confidence: number | null;
  reasons: string[];
  offer: string | null;        // one question for the whole set
  withheld: { target: TargetId; reason: WithheldReason }[];
  fingerprint: string | null;  // pass back to recordOutcome()
  modelVersion: string | null;
  trainedOn: "synthetic" | null;
}
```

Suggested wiring, for the frontend lead to decide:

| Where | What |
|---|---|
| Display and voice settings, and "Make it yours" | A plain on/off "Let Dial suggest display changes" control → `setConsent()`. Off deletes data. A "Reset suggestions" button → `resetPersonalisation()`. |
| `PreferencesProvider.apply` / voice previews the person keeps | `recordSignal(state, signalForAction(action, prefsBefore))` |
| Opening Voice Mode / switching to Detailed / Undo | `recordSignal(state, "voiceSessions" \| "moreDetail" \| "undoneChanges")` |
| Home, after load or after a preference change (debounced) | `getPersonalisation({ preferences: prefs, view: mode, choices }, state)` |
| `status === "ok"` | Dial asks `result.offer` and shows `reasons` under "Why am I seeing this?". Yes → `startPreview(rec.actions)`, then the existing keep/undo flow, then `recordOutcome(…, "accepted")`. No → `"rejected"`. Dismissed → `"ignored"`. |
| Any other status | Show nothing. The adaptive UI works exactly as today. |

Rules that matter:

1. **Don't count accepted ML suggestions as signals.** Call `recordOutcome` instead, so the model doesn't learn from itself.
2. "Make it yours" ticks aren't stored today (only the resulting style is). Passing them improves suggestions, but storing them is the frontend's decision.
3. `stepByStep` and `voiceFirst` suggestions need PR #9's schema. On the redesign schema they are automatically `not_supported`.
4. Show that suggestions come from a model trained on synthetic data while this is a prototype (`trainedOn`).

## Reproducing the model

Requires Node 22.15+ or 24 (runs TypeScript natively). No extra packages.

```bash
# Train, then write lib/personalisation/model.json and docs/ml-personalisation/EVALUATION.md (~5 s)
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts

# Check the committed model is exactly what training produces (exit 1 if not)
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts --check

# Tests (training, evaluation, inference, privacy, performance): part of the normal suite
npm test
```

`ts-resolve.mjs` is a 15-line Node resolve hook, so the script can import the same extensionless `lib/` modules the app uses. I didn't add an `npm run` alias, because that needs a `package.json` change (awaiting approval).

To change the model, edit `DEFAULT_CONFIG` (`train.ts`) or the generator (and bump `SYNTHETIC_GENERATOR_VERSION`), re-run the script, and commit both outputs. `train.test.ts` fails if `model.json` and the code drift apart.

## Limitations

- **Synthetic data proves the pipeline, not the predictions.** The generator encodes my assumptions about how display tastes show up in behaviour, so the model largely learns those assumptions back. Before anyone relies on it, it needs real, consented outcome data, i.e. the accept/reject answers this engine records, collected with clear consent and an approved retention policy, plus a re-evaluation.
- **Cautious by design, so it rarely speaks.** It covers 1–7% of eligible people for 3 settings and never suggests the other 5. The brief's exact example (larger text and less on screen, with nothing hidden) is withheld at 0.53.
- **No per-person online learning.** The model is trained offline. It adapts to a person only through their changing settings and counts, and through remembering their noes. Retraining from real outcomes would be a separate, consented pipeline.
- **Feature set is fixed.** If `lib/preferences/schema.ts` gains settings, `features.ts` must be updated and the model retrained. `isValidModel` refuses a model whose feature list doesn't match.
- **Probabilities are only roughly calibrated.** Brier beats the baseline, but there is no separate calibration step, so read "0.7" as "fairly confident", not exactly 70%.
- **Explanations are based on contributions.** They show which of the person's own actions pushed the prediction up. They are not causal claims.
- **Signal collection isn't wired.** Until the frontend calls `recordSignal`, only explicit settings and ticks are available, so there will be fewer suggestions.
- **Model size** is 204 KB of JSON (lazy-loaded, compresses well). It could be shrunk further by quantising thresholds or pruning low-value trees if needed.

## Files

All new. No existing file was modified.

| File | Purpose |
|---|---|
| `lib/personalisation/features.ts` | Allowlisted feature extraction, reason wording, fingerprint |
| `lib/personalisation/targets.ts` | The 8 predicted settings, their `UiAction`-shaped changes and Dial's questions |
| `lib/personalisation/forest.ts` | CART / random forest training, prediction, contributions, tree validation |
| `lib/personalisation/synthetic.ts` | Seeded synthetic data generator and splits |
| `lib/personalisation/metrics.ts` | AUC, precision/recall/F1, Brier, keep rate |
| `lib/personalisation/train.ts` | Training and evaluation pipeline |
| `lib/personalisation/artifact.ts` | Model file format and validation |
| `lib/personalisation/model.json` | **The trained model** |
| `lib/personalisation/infer.ts` | Background inference and the result contract |
| `lib/personalisation/state.ts` | Consent, signals, outcomes, reset, storage |
| `lib/personalisation/index.ts` | Public entry point (lazy model loading) |
| `lib/personalisation/examples.ts` | Example people for docs and tests |
| `lib/personalisation/*.test.ts` | 69 tests |
| `scripts/personalisation/train.ts`, `ts-resolve.mjs` | Reproducible training script |
| `docs/ml-personalisation/README.md`, `EVALUATION.md` | This document and the generated report |
