# ML personalisation engine

A small, trained machine-learning model that works in the background. It looks at the display settings a person has **explicitly** chosen, and (with their consent) at counts of explicit display actions, and predicts which *other* presentation settings they might like. Dial can then **ask**: "Would you like me to make the text larger?" The person can say yes, no, or ignore it. **The model never changes the interface by itself.**

> **Status: prototype, trained on synthetic data only.** It is a working, tested ML pipeline. It has not been validated on real people, and it does not learn from real users (see [Limitations](#limitations)).
> **Integration:** wired into the adaptive UI behind explicit consent and verified end to end in a real browser. See [Demo path](#demo-path) and [Integration on the adaptive UI](#integration-on-the-adaptive-ui-agreed).

- Generated metrics and example predictions: [`EVALUATION.md`](./EVALUATION.md)
- Re-measurement as the app uses it, generator B robustness, coverage, repetition, cross-mode, and the v2 candidate vs v1: [`EVALUATION-v2.md`](./EVALUATION-v2.md) (see [Evaluation v2](#evaluation-v2-re-measured-and-a-v2-candidate))
- Code: `lib/personalisation/` · Training script: `scripts/personalisation/train.ts` · Browser check: `scripts/test-ml-browser.mjs`

---

## Demo path

Everything below is a real inference from the trained model: nothing is seeded or faked, and the same steps are what `scripts/test-ml-browser.mjs` drives in Chromium against `npx next build && npx next start -p 3600`.

**Calmer home screen (works in Simple and Detailed view, at any text size).**

1. On Home, answer the "Make it yours" invitation ("Not now" is enough). The suggestion card never competes with it.
2. Go to **Display and voice**. Under **Suggestions from Dial**, choose **On**. (The 204 KB model is fetched now, not before.)
3. Under **Home screen**, untick one section: "Recent transactions" in Detailed view, "Dial noticed" in Simple view.
4. Go **Home**. The **Suggested for you** card says: *A calmer home screen. You hid a section on your home screen, so Dial suggests a calmer home screen that shows only the first three sections.* (0.79 in Simple view, 0.65 in Detailed; threshold 0.60.)
5. **Preview it**: Home drops to three sections and the preview bar appears. **Keep it** saves it (`cfe-prefs` cookie, `layout.density: "calm"`) and the card does not return. **Go back** or **No thanks** records a no and the card does not return either; **Not now** holds it until a setting changes.

**Talking to Dial first (Simple view).**

1. Suggestions **On** as above. Under **Buttons**, choose **Bigger**.
2. Tap the **Dial** button three times (close it each time). Each tap counts one "opened Voice Mode"; nothing said is recorded.
3. Go **Home**: *Talking to Dial first. You've talked to Dial 3 times, so Dial suggests a Talk to Dial button at the top of your home screen.* (0.68; threshold 0.65.) Preview it adds the Talk to Dial button.

**Turning suggestions off** (Display and voice) deletes the `cfe-personalisation` key in `localStorage`; display settings are untouched.

Why these two and not "larger text": a setting is only ever offered while it is **off**, and larger text counts as on from 125%. So the person who made the text bigger twice already has it, and the model is only asked about larger text for someone back at 100% (after a reset or after making it smaller), where the synthetic evidence is thinner (0.56 to 0.65 against a 0.65 threshold). None of the thresholds or gates were changed to make the demo work; they are the ones chosen on validation data in [Training](#training). The three demo inputs are the first examples in `examples.ts`, pinned by `infer.test.ts`.

## Contents

1. [How it fits in](#how-it-fits-in)
2. [Why a random forest](#why-a-random-forest)
3. [Inputs and privacy](#inputs-and-privacy)
4. [Synthetic training data](#synthetic-training-data)
5. [Training](#training)
6. [Evaluation](#evaluation) · [Evaluation v2](#evaluation-v2-re-measured-and-a-v2-candidate)
7. [Inference](#inference)
8. [Integration on the adaptive UI (agreed)](#integration-on-the-adaptive-ui-agreed)
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
      PersonalisationResult { preferences[{ title, summary, reasons, actions, confidence }], offer, modelVersion }
                            ▼
      "Suggested for you" card on Home  ──►  Preview it: PreferencesProvider.startPreview(actions) → Keep it / Go back
                                        ──►  No thanks / Not now: recordOutcome() so it isn't repeated
```

**Where it runs: in the browser, on the device.** Inference is a pure TypeScript function (measured at about 0.006 ms per call, after a one-off ~3 ms model check). The trained model is a JSON file loaded with a dynamic `import()`, so the bundler splits it out of the first page load: in the browser run it is a separate chunk that is requested only after consent. I chose this over a server route because:

- preferences already live in the browser (cookie plus `sessionStorage`), so nothing has to leave the device;
- the app has no database or user accounts to store server-side profiles in;
- it keeps working offline and with no API key, like the rest of the app;
- there's no new endpoint to secure or rate-limit.

**Separate from Groq.** The Groq assistant (`lib/ai`, `POST /api/ask`) answers financial questions. This engine only predicts how the interface should look. The two share no code, data or endpoints: the engine never sees questions or answers, and the assistant never sees personalisation data.

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
| Added for v2 (5, appended) | answer style (brief/standard) · listen mode (tap/hold/continuous) · tapped Read aloud · tapped Simple · tapped Detailed | the same rules. The shipped v1 model reads only the first 28; a format-2 model reads all 33. `speechInput` (where speech becomes text) is a privacy choice and is **never** an input |

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
| Says No thanks twice in a row (any suggestions) | Nothing is suggested (`status: "paused"`) until they change a setting themselves (a kept Settings or Voice change, or tapping the view switch). |
| Answers any suggestion (Keep it, Go back, No thanks, Not now) | Nothing else is suggested for the rest of the visit. A visit shows **at most one** suggestion (`controller.forVisit`, `sessionStorage`, no timestamps). |
| Taps Not now | Held for the visit, and after that until their settings change. |
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

The model only ever sees steps 2 to 4. It is never given the tastes or the formulas.

**Generator decision to know about:** the first version tied action counts strongly to settings engagement. That made the people who still had a setting *off* (the only ones who can be offered it) almost silent, and the model could rarely be confident. Weakening that link (step 4) was a modelling assumption about real behaviour. It was not tuned on test data, but it does shape the results.

**Splits:** 20,000 people, shuffled with a seed, then split into 60% train, 20% validation (threshold selection only) and 20% test (reporting only). Each person is in exactly one split. For each target, only people with that setting **off** are used, because those are the only people who could be offered it. Without this, "already has 150% text" would trivially predict "likes larger text" and inflate every metric.

## Training

`trainModel()` in `lib/personalisation/train.ts` is pure and deterministic:

1. Generate synthetic people and turn them into features with **the same `extractFeatures()` used at inference** (no train/serve skew).
2. For each of the 8 targets: train a 30-tree forest (bootstrap samples, Gini, max depth 5, min leaf 30, 6 of 28 features per split). For comparison, also train a stump and a single deep tree.
3. **Choose a threshold on validation data:** the lowest of 0.60, 0.65 … 0.95 at which at least 80% of people offered the suggestion would keep it, with at least 20 offers. **If none qualifies, the target gets no threshold and is never offered.**
4. Evaluate everything on the untouched test set and write `model.json` and `EVALUATION.md`.

Hyperparameters were compared on **validation** AUC (feature subsets of 6/10/15, depth 5 to 7, min leaf 15 to 30). All were within 0.002 of each other, so the smallest model was kept.

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
- **It is deliberately cautious.** Only 3 of 8 settings clear the 80% bar, and those are offered to 1 to 7% of eligible people. **Recall is low (5 to 21%) by design**: a suggestion nobody wanted costs more than a missed one, because the person can always change settings themselves. The other 5 settings exist in the code and are reported, but the model withholds them (`not_reliable`) until better data says otherwise.
- Motion and contrast are hardest because, in the generator, their tastes leave weak traces in the other signals. That's a property of the synthetic data, not a finding about people.
- **What the numbers do not say:** nothing here measures real people. There has been no study, pilot or collection of real accept/reject answers. `EVALUATION.md` section 4 states this next to the tables.

### Example predictions

From `lib/personalisation/examples.ts`. Full inputs are in `EVALUATION.md`.

| Person | Result |
|---|---|
| **Demo path:** hid one home screen section, Simple view | **Offers a calmer home screen (0.79).** "You hid a section on your home screen; You asked for less on screen once; You use Simple view" |
| **Demo path:** hid one home screen section, Detailed view | **Offers a calmer home screen (0.65).** |
| **Demo path:** bigger buttons, opened Dial three times, Simple view | **Offers talking first (0.68).** |
| Text at 150%, made text bigger ×3, asked for less on screen ×3 (**the brief's example**) | `no_recommendation`. Calm layout scores 0.53, below its 0.60 threshold. In the synthetic data, people who ask for less usually also hide something, so this exact pattern is thin evidence. |
| Same, and also **hid a section** | **Offers a calmer home screen (0.78).** "You hid a section on your home screen; You asked for less on screen 3 times; You use Simple view" |
| Bigger buttons, talked to Dial ×6 | **Offers talking first (0.68).** "You've talked to Dial 6 times; You chose bigger buttons; You use Simple view" |
| Ticked larger text / contrast / less info, kept standard look, made text bigger ×2 | **Offers larger text (0.71).** "You made the text bigger twice; In "Make it yours" you ticked "Larger text"; …" |
| Asked for less ×4 *and* more detail ×4 | Calm layout withheld: `conflicting_signals` |
| Nothing changed | `insufficient_data` |
| Talks to Dial, on the redesign schema (no voice-first setting) | voice-first and step-by-step withheld: `not_supported` |
| Not asked about personalisation yet | `needs_consent` (nothing predicted) |

## Evaluation v2: re-measured, and a v2 candidate

Run `train.ts --evaluate` to regenerate [`EVALUATION-v2.md`](./EVALUATION-v2.md). It measures models **as the app uses them**: only people who consented, current schema through `sanitize()`, no Make it yours ticks, the full inference pipeline, one suggestion at a time. It uses fresh samples that were never trained on.

**What it found about v1** (the shipped model):

- **Served coverage is far below the reported numbers.** Larger text reaches 0.14% of eligible people, not the 1.5% in `EVALUATION.md`. Most of v1's confident larger-text predictions come from Make it yours ticks, which the provider never passes. 6.0% of people ever see a suggestion, and 87% of those suggestions are the calmer home screen.
- **Calibration is decent under its own assumptions** (mean ECE 0.035), but probabilities are squeezed: nothing on A goes above 0.9.
- **It is not robust to different assumptions.** On generator B, which is designed differently and never trained on, mean AUC drops from 0.680 to 0.559, and the keep rate of what it offers falls from 84% to 56%. Under the broader generator A v2 it also offers talking-first to people who keep it only 62% of the time. **The 80% promise is a property of generator A, not of the model.**
- **It is view-dependent.** 9.4% of Simple-view people get a suggestion, against 0.4% in Detailed view. Talking-first disappears entirely when the same people switch to Detailed.
- **Repetition:** after any setting change, a declined suggestion comes back once (REJECTION_LIMIT). Accepting one suggestion could immediately show another in the same visit.

**What changed.** These ship regardless of the model:
- the repetition rules in the table above;
- the harness;
- generator B;
- generator A version 2, which keeps version 1 intact and randomises its uncertain assumptions per person;
- the five new inputs and the provider calls that record them;
- isotonic calibration, fitted on validation only, with thresholds chosen on calibrated validation probabilities;
- training on the served population.

**Decision: v1 stays.** The v2 candidate (`V2_CONFIG`) improves AUC and calibration on generator A v2 (mean AUC 0.619 to 0.632, every target better; ECE 0.044 to 0.018) and in Detailed view. It fails the rule that was fixed before v2 was built:
- on generator A as v1 knew it, `paymentsProminent` AUC is 0.011 lower and mean ECE is worse (0.035 to 0.056);
- on B, its pooled keep rate is slightly lower (56.5% to 55.4%);
- its one offered target keeps 76.5% (below 80%) on generator A v2.

`DEFAULT_CONFIG` therefore stays `V1_CONFIG`, which reproduces `model.json` byte for byte (`--check`). To ship a future candidate, it must pass the same rule. Then set `DEFAULT_CONFIG = V2_CONFIG`, retrain and commit.

## Inference

`recommendPreferences(input, state, model, options?)` in `lib/personalisation/infer.ts`. It is pure, synchronous and **never throws**.

1. Consent: not granted → `needs_consent` / `disabled`.
2. Model missing or fails `isValidModel()` (format, version, exact feature order, every tree index in range, no cycles, probabilities in [0, 1]) → `unavailable`.
3. No preferences, or nothing beyond the defaults → `insufficient_data`.
4. For each setting, it is withheld if: already on · not in this app's schema · no trained threshold · rejected (same settings, or twice) · ignored (same settings) · conflicting explicit signals · probability not finite · below `max(threshold, 0.6)` · **no reason based on something the person did**.
5. Calm layout and chart-at-top both reshape the home screen, so only the more confident one is offered.
6. At most 3 suggestions are returned, most confident first, with one combined question for Dial. Each carries a one-sentence `summary` for the card: its strongest reason, then what Dial suggests ("You hid a section on your home screen, so Dial suggests a calmer home screen that shows only the first three sections.").

Measured on a laptop (Node 24): about 0.006 ms per call on the full recommendation path. The model is structurally validated once per loaded model (about 3 ms) and then cached. The test allows 2 ms per call.

## Integration on the adaptive UI (agreed)

Wired into the adaptive UI (PR #9), following the contract agreed with the frontend lead.

**Consent.** A "Suggestions from Dial" section in Display and voice (`/account/settings#suggestions`) with an Off/On switch. It is off by default and is the only place to turn it on.
- ML state lives in `localStorage` under `cfe-personalisation`. It is never part of `Preferences`, the `cfe-prefs` cookie or Make it yours.
- Off deletes the key. Display settings are left alone.
- "Reset suggestions" forgets counts and answers but keeps consent.
- The display "Reset to default" resets display settings only.
- The 204 KB model is fetched with a dynamic `import()` **only after consent**. `scripts/test-ml-browser.mjs` recognises the model chunk by its content and checks it is never requested before "On" and is requested after.

**Signals.** `PreferencesProvider` tags every change with a `ChangeSource` and, after a change is kept, undone or reset, emits a `PrefsEvent` (`lib/preferences/events.ts`). Previews emit nothing and don't touch undo history. `lib/personalisation/controller.ts` counts:
- only kept changes from `settings` or `voice`;
- taps that open Voice Mode, as a count. Nothing said is recorded.

`style` (Make it yours), `ml`, `other` (the default), view switches and resets are never counted.

**Lifecycle.**
- The Home card (`components/personalise/ml-suggestion.tsx`, "Suggested for you") shows one suggestion in both Simple and Detailed view: the setting's name, the one-sentence reason in plain sight, a short line saying it was worked out on this device and changes nothing by itself, then **Preview it** (primary), **No thanks**, **Not now**. The full reasons, the privacy wording and a "Turn suggestions off" link sit behind "Why am I seeing this?". It appears only when consent is on, Make it yours has been done or skipped, no preview is active, and the model returned `ok`.
- **Preview it** uses the existing preview bar (`StylePreviewProvider.startRequest`, `source: "ml"`).
- **Keep it** saves the change. **Go back** and **No thanks** count as a no. **Not now** holds the suggestion until settings change.
- Undoing, resetting or changing back a kept suggestion counts as a no (`reconcile`).

**Fallback.** If the model is missing, invalid or blocked, there's no card and Settings says "Suggestions aren't available right now". Make it yours (`recommend.ts`) is unchanged and works whatever ML is doing.

**Boundaries.**
- `lib/ai`, `lib/assistant`, `app/api` and `lib/finance` never import this module.
- `liveState()` (sent with `/api/ask`) carries only Spend Pause, purchases and payments.
- Ask Dial uses only `noteVoiceOpened()`.

All of this is covered by `lib/personalisation/integration.test.ts` (unit level, with a stand-in for the providers) and by `scripts/test-ml-browser.mjs` (the real production build in Chromium: both views, 100% and 150% text, phone and desktop widths, plus the `/api/ask` request body and the storage key).

```bash
npx next build
node scripts/test-ml-browser.mjs --shots=/tmp/ml-shots   # starts next start -p 3600 itself; --shots is optional
```

## Reproducing the model

Requires Node 22.15+ or 24 (runs TypeScript natively). No extra packages.

```bash
# Train, then write lib/personalisation/model.json and docs/ml-personalisation/EVALUATION.md (~5 s)
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts

# Check the committed model is exactly what training produces (exit 1 if not)
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts --check

# Evaluate the committed model and the v2 candidate; writes docs/ml-personalisation/EVALUATION-v2.md (~15-30 s), never model.json
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts --evaluate

# Tests (training, evaluation, inference, privacy, performance): part of the normal suite
npm test
```

`ts-resolve.mjs` is a 15-line Node resolve hook, so the script can import the same extensionless `lib/` modules the app uses. I didn't add an `npm run` alias, because that needs a `package.json` change (awaiting approval).

To change the model, edit `DEFAULT_CONFIG` (`train.ts`; currently `V1_CONFIG`) or the generator (and bump `SYNTHETIC_GENERATOR_VERSION`; version 1 must stay reproducible), re-run the script, and commit both outputs. `train.test.ts` fails if `model.json` and the code drift apart. Features are append-only: format-1 models read the first 28 (`artifact.ts` `FORMAT_FEATURES`).

## Limitations

- **Synthetic data proves the pipeline, not the predictions.** The generator encodes my assumptions about how display tastes show up in behaviour, so the model largely learns those assumptions back. It has not been validated with real people: no study, no pilot, no real accept/reject data. Before anyone relies on it, it needs real, consented outcome data, i.e. the accept/reject answers this engine records, collected with clear consent and an approved retention policy, plus a re-evaluation.
- **Cautious by design, so it rarely speaks.** It covers 1 to 7% of eligible people for 3 settings and never suggests the other 5. The brief's exact example (larger text and less on screen, with nothing hidden) is withheld at 0.53. In a short demo only two suggestions are reachable (see [Demo path](#demo-path)); larger text is not, because it is already on from 125%.
- **It does not learn from real users.** The model is trained offline and shipped fixed. It adapts to a person only through their changing settings and counts, and through remembering their noes. Retraining from real outcomes would be a separate, consented pipeline.
- **Thin evidence can be enough.** One hidden section (plus the count of hiding it) clears the calm-layout threshold. That follows from the synthetic data, where hiding anything is a strong marker of the "calm" taste. Whether one real person hiding one section wants a calmer screen is exactly the kind of thing that has not been tested.
- **Feature set is fixed.** If `lib/preferences/schema.ts` gains settings, `features.ts` must be updated and the model retrained. `isValidModel` refuses a model whose feature list doesn't match.
- **Probabilities are only roughly calibrated.** Brier beats the baseline, but there is no separate calibration step, so read "0.7" as "fairly confident", not exactly 70%.
- **Explanations are based on contributions.** They show which of the person's own actions pushed the prediction up. They are not causal claims.
- **Make it yours ticks are not used** (agreed, to keep the rules flow independent). The model sees settings, view and the counted actions only.
- **View matters.** Switching to Detailed changes a model input, so a suggestion offered in Simple view may be withheld in Detailed view.
- **One-time re-offer after this update.** The "unchanged settings" fingerprint now includes answer style and listen mode, so a suggestion someone declined **once** before the update may be offered once more. Two noes still block it for good.
- **Voice-first use.** The suggestion card is on Home only, so people who mostly use Voice Mode see it only when they visit Home. Offering suggestions inside Voice Mode would be a frontend change.
- **New inputs are recorded but unused by v1.** Read aloud and view-switch counts, answer style and listen mode are kept on the device with consent, so a future model can use them. Withdrawing consent deletes them.
- **Model size** is 204 KB of JSON (lazy-loaded, compresses well). It could be shrunk further by quantising thresholds or pruning low-value trees if needed.

## Files

The engine files below are new. The integration also makes small, agreed changes to frontend files: `lib/preferences/provider.tsx`, `components/personalise/style-preview.tsx`, `components/settings/display-settings.tsx`, `components/home/home-screen.tsx`, `components/voice/voice-mode.tsx`, `components/assistant/ask-dial.tsx` and `app/(dial)/layout.tsx`.

| File | Purpose |
|---|---|
| `lib/personalisation/features.ts` | Allowlisted feature extraction, reason wording, fingerprint |
| `lib/personalisation/targets.ts` | The 8 predicted settings, their `UiAction`-shaped changes, Dial's questions and the "so Dial suggests ..." phrases |
| `lib/personalisation/forest.ts` | CART / random forest training, prediction, contributions, tree validation |
| `lib/personalisation/synthetic.ts` | Seeded synthetic data generator and splits |
| `lib/personalisation/metrics.ts` | AUC, precision/recall/F1, Brier, keep rate, ECE and reliability |
| `lib/personalisation/calibration.ts` | Isotonic calibration (fit on validation, monotone knots, validation of the JSON) |
| `lib/personalisation/synthetic-b.ts` | Generator B: a differently designed population, for robustness testing only |
| `lib/personalisation/evaluate.ts` | Evaluation harness: served population, calibration, coverage, repetition, cross-mode |
| `scripts/personalisation/evaluation-report.ts` | Writes `EVALUATION-v2.md`, including the retraining rule check |
| `lib/personalisation/train.ts` | Training and evaluation pipeline |
| `lib/personalisation/artifact.ts` | Model file format and validation |
| `lib/personalisation/model.json` | **The trained model** |
| `lib/personalisation/infer.ts` | Background inference, the one-sentence summary and the result contract |
| `lib/personalisation/state.ts` | Consent, signals, outcomes, reset, storage |
| `lib/personalisation/index.ts` | Public entry point (lazy model loading) |
| `lib/personalisation/examples.ts` | Example people for docs and tests, the three demo paths first |
| `lib/personalisation/controller.ts` | Events → signals, `reconcile`, card visibility |
| `lib/personalisation/provider.tsx` | React provider: consent, storage, lazy model, evaluation |
| `lib/preferences/events.ts` | `ChangeSource` and `PrefsEvent` emitted by the preferences provider |
| `components/personalise/ml-suggestion.tsx` | The "Suggested for you" card on Home |
| `lib/personalisation/*.test.ts` | About 100 tests, including `integration.test.ts` and the pinned demo paths |
| `scripts/personalisation/train.ts`, `ts-resolve.mjs` | Reproducible training script |
| `scripts/test-ml-browser.mjs` | End-to-end check in Chromium against the production build |
| `docs/ml-personalisation/README.md`, `EVALUATION.md` | This document and the generated report |
