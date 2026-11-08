# Dial personalisation v2: the synthetic world

> **Everything here is made up by us.** No real person's data is used. Every relationship in the generator (which hidden
> trait drives which answer, setting, signal and benefit) was written by the team. A model that does well on this data has
> recovered structure we put in. That shows the training and evaluation pipeline works, and that the model *can* learn
> this kind of structure. It does **not** show that the model helps real people, and nothing has been validated with
> real users.

Code: `lib/recommender/synthetic.ts` (generator version 2), tests: `lib/recommender/synthetic.test.ts`.
Default world: seed `20261108`, 20,000 people. The same seed always gives the same world, and person *i* is identical
whatever the world size (each person has their own random stream, seeded by `mixSeed(seed, i)`; `lib/recommender/random.ts`
provides the mulberry32 generator, Box-Muller normals and weighted sampling; `Math.random()` is never used).

## 1. Why a synthetic world, and what it is for

There is no real feedback yet: v2 starts collecting it only after people opt in. To build and test the whole loop
(training, evaluation, fairness checks, versioning, promotion, monitoring) we need data with a **known ground truth**:
for every person and every setting, how much it would actually help. Real data never has that. The generator gives us:

- **logged training examples** exactly like the ones the backend exports (`TrainingExample`, labels per CONTRACT.md §8),
  including the biases real logs have (people only answer what they were shown);
- a **hidden true benefit** per person and item, so evaluation can ask "did the model suggest things that help?" and not
  only "did people click Keep?".

## 2. Hidden traits

Each person has 12 hidden continuous traits, each standard normal. Correlations come from three latent factors
(`access`, `experience`, `appetite`, each N(0, 1)):

trait = Σ_f loading(trait, f) · factor_f + sqrt(1 − Σ_f loading²) · ε, with ε ~ N(0, 1)

| Trait | Meaning (interface taste, not a condition) | access | experience | appetite |
|---|---|---|---|---|
| readingEffort | effort reading small, dense text | 0.75 | | |
| busyTolerance | tolerance for busy screens (low: wants little on screen) | −0.25 | 0.2 | 0.75 |
| visual | prefers charts and pictures over words | | | 0.3 |
| voice | prefers talking over tapping | 0.4 | −0.2 | |
| guidance | wants to be guided step by step | 0.2 | −0.6 | |
| confidence | financial confidence | | 0.8 | |
| motionSensitivity | finds animation distracting | 0.5 | | |
| tapPrecision | taps small targets accurately | −0.6 | | |
| focusPayments | wants upcoming payments first | | −0.3 | |
| focusSpending | wants to see where money goes | | | 0.3 |
| focusBudget | wants progress against a budget | | 0.2 | |
| focusRecent | wants recent transactions first | | | 0.4 |

So corr(a, b) = Σ_f loading(a, f)·loading(b, f): for example readingEffort and motionSensitivity 0.375, readingEffort and
tapPrecision −0.45, guidance and confidence −0.48. These are not one-trait-per-item: most items depend on several traits
and most traits on shared factors.

Other hidden values per person:

- `screenReader` ~ Bernoulli(sigmoid(−4 + 1.3·readingEffort)) (about 4% of people);
- `activity` = exp(0.5·N(0, 1)): how much they use the app (scales signal counts);
- `engagement` = U(0, 1)^1.5: how likely they are to change settings themselves;
- `itemNoise[item]` ~ N(0, 0.35), fixed per person and item: idiosyncratic taste no observable explains.

## 3. Observed "About you" answers

- 20% of people answer nothing (cold start).
- The rest skip each question independently with a per-person probability s ~ U(0.25, 0.40); 15% of them also stop
  partway, after 1 to 4 answers.
- Each given answer (except the screen-reader question, which is factual) is replaced with a *different* option with
  probability 0.10: an answer inconsistent with the traits (about 9% of all given answers).
- Otherwise the answer is read from a noisy trait, n = 0.5·N(0, 1), with fixed cut points:

| Question | Latent value | Options (low → high) and cut points |
|---|---|---|
| creditFamiliarity | confidence + n | new < −0.6 ≤ some ≤ 0.6 < confident |
| budgetingFamiliarity | 0.7·confidence + 0.4·focusBudget + n | same |
| appConfidence | 0.6·confidence − 0.4·readingEffort + n | low < −0.6 ≤ medium ≤ 0.6 < high |
| detailLevel | busyTolerance + n | keyFacts < −0.5 ≤ some ≤ 0.6 < everything |
| inputMode | voice + n | touch < −0.2 ≤ either ≤ 0.9 < voice |
| explanationFormat | visual + n | written < −0.5 ≤ both ≤ 0.5 < visual |
| answerLength | 0.7·busyTolerance + 0.3·confidence + n | short ≤ 0.3 < detailed |
| guidance | guidance + n | independent ≤ 0.2 < guided |
| screenComplexity | busyTolerance + n | minimal < −0.5 ≤ balanced ≤ 0.7 < everything |
| priority | argmax of focusPayments, focusSpending, focusBudget, focusRecent, each + n | payments / spending / budget / transactions |
| screenReader | the hidden screenReader flag | yes / no |

At the default seed: 19.8% answer nothing, 14.8% answer 1-4 questions, 65.4% answer 5 or more.

## 4. Current settings, explicit dimensions, view and signals (before any suggestion)

A person adopts a setting themselves with probability `engagement · sigmoid(2.5·(need − 1))`:

| Setting | need |
|---|---|
| text size (125% if readingEffort < 1.6, 150% if < 2.2, else 200%) | readingEffort |
| stronger contrast | 0.8·readingEffort |
| roomy spacing | 0.5·readingEffort − 0.4·busyTolerance |
| reduced motion | motionSensitivity |
| large targets | −tapPrecision |
| step-by-step explanations | guidance |
| voice first | voice |
| calm density | −busyTolerance |
| hide "recent" or "chart" (50/50) | −busyTolerance − 0.3 |
| the home-focus item of the person's largest focus trait | that focus trait |

Theme (22% dark, 10% light) and onboarding status are random on purpose (irrelevant inputs). Settings are built with the
app's own `applyActions` and passed through `sanitize`.

- **View**: Simple with probability sigmoid(−1.2·busyTolerance − 0.5·confidence + 0.5·guidance − 0.6) (about 44%),
  otherwise Detailed (the app default).
- **Explicit dimensions**: every non-default dimension (`nonDefaultDimensions`), plus each other dimension with
  probability 0.08·engagement (visited the setting and left it at default), plus `view` with probability 0.6 if the view
  is Simple and 0.1 if Detailed.
- **Signals** (counts, capped at 10, only non-zero counts are stored). Rate per person, with softplus(x) = ln(1 + eˣ) and
  a = activity:

| Signal | Rate |
|---|---|
| textLarger | 0.5·a·softplus(1.5·(readingEffort − 0.8)) |
| textSmaller | 0.05 + 0.3·a·softplus(1.5·(−readingEffort − 1)) |
| lessOnScreen | 0.5·a·softplus(1.5·(−busyTolerance − 0.6)) |
| moreDetail | 0.5·a·softplus(1.5·(busyTolerance − 0.6)) |
| moreVisual | 0.5·a·softplus(1.5·(visual + 0.4·focusSpending − 0.8)) |
| voiceSessions | 0.05 + 1.2·a·softplus(1.5·(voice − 0.4)) |
| shorterAnswers | 0.3·a·softplus(1.5·(−busyTolerance − 0.5)) · (1 if voice > 0 else 0.2) |
| undoneChanges | 0.08·a, plus 1 for every suggestion undone with Undo |

  Initial counts ~ Poisson(2·rate); between rounds counts grow by Poisson(rate·gapDays/14).

## 5. True benefit (hidden utility)

utility(item) = base(item) + itemNoise[item]. Negative means the change would make Dial harder to use for that person.
sr = 1 for screen-reader users, else 0.

| Item | base |
|---|---|
| view.simple | 0.25 − 0.8·busyTolerance − 0.25·confidence + 0.2·guidance + 0.3·sr |
| view.detailed | −0.35 + 0.9·busyTolerance + 0.3·confidence − 0.2·guidance |
| density.calm | −0.15 − 0.8·busyTolerance + 0.2·guidance + 0.4·sr, times 0.4 in Simple view (it already shows three sections) |
| textSize.125 | −0.45 + 0.85·readingEffort − 0.15·sr |
| textSize.150 | −1.3 + 0.85·readingEffort |
| contrast.high | −0.6 + 0.65·readingEffort |
| spacing.roomy | −0.4 + 0.35·readingEffort − 0.35·busyTolerance − 0.25·tapPrecision |
| motion.reduced | −0.5 + 0.85·motionSensitivity |
| targets.large | −0.45 − 0.8·tapPrecision + 0.15·readingEffort |
| explanations.stepByStep | −0.3 + 0.75·guidance − 0.3·confidence |
| voiceFirst.on | −0.7 + 0.9·voice + 0.6·sr |
| homeFocus.bill | −0.2 + 0.7·focusPayments − 0.15·confidence |
| homeFocus.chart | −0.45 + 0.5·visual + 0.45·focusSpending − 0.6·sr |
| homeFocus.budget | −0.35 + 0.65·focusBudget + 0.2·visual |
| homeFocus.recent | −0.45 + 0.6·focusRecent + 0.25·busyTolerance |
| homeFocus.insights | −0.4 + 0.4·guidance + 0.35·focusSpending − 0.2·confidence |

For example, Detailed view for someone who wants little on screen (busyTolerance = −1.5) has base utility −1.7.

## 6. From "shown" to a label: keep, undo, rating

For an item shown at position j (0 = first) in a suggestion:

keep logit = 1.6·utility − 0.35 + 0.5·0.5^roundsSeen − 0.3·rejectedRounds − 0.15·j + 0.6·N(0, 1)

- −0.35 is a **status-quo bias** (people prefer to leave things as they are);
- 0.5·0.5^roundsSeen is a **novelty bias** that fades (curious people keep things they don't need on the first try);
- −0.3 per earlier round in which they turned everything down is **fatigue**;
- −0.15 per position is **position bias**;
- roundsSeen and rejectedRounds are read from the person's visible history (`historyStats`).

Then:

- **Undo**: a kept item is undone with probability sigmoid(−2.2·utility − 1.6): 17% at utility 0, 65% at −1, 2% at +1.
  65% of undos are via Undo (adds an `undoneChanges` signal), 35% via Settings (the dimension becomes explicit).
- **Rating** ("Did this make Dial easier to use?"): 35% of rounds with something kept are rated. m = mean utility of the kept
  items + 0.4·N(0, 1); −1 if m < −0.2, +1 if m > 0.4, else 0.
- **"Not now"**: the whole round is dismissed with probability 0.10 + 0.05·min(rejectedRounds, 4). No labels.
- **Label** (CONTRACT.md §8): 1 if kept, not undone and the round not rated −1; 0 if turned down, undone or rated −1;
  dismissed rounds give no example. Resets are not simulated (they would only remove labels).

This is the gap between "clicked Keep" and "actually helped": at the default seed about 40% of kept items have utility ≤ 0,
and about a quarter of label-1 examples still have utility ≤ 0 (novelty, noise, no undo). The overall label rate is
about 27%. **That rate is an assumption we made, not a measurement**: real acceptance of unsolicited display suggestions is
unknown, and a low base rate limits how precise any model can be at useful reach (see EVALUATION.md §10).

After a round: kept items are applied with the app's `applyActions` and their dimension becomes explicit; turned-down
and undone items are recorded in history and never shown again; dismissed items may be shown again later.

## 7. Exposure: a biased logging policy

People only give feedback on what they were shown. Each person has 1, 2, 3 or 4 rounds (weights 0.4/0.3/0.2/0.1), 7 to
34 days apart (starting on a random day in 2026). Each round picks a policy:

- **50% rules**: the "Make it yours" rules (`lib/preferences/recommend.ts`, unchanged) driven by the baseline-only answer
  mapping in `lib/recommender/evaluation/rules.ts`, eligible items only, at most 4, conflicts resolved as the rules do. With
  no relevant answers it falls back to popularity (so only about a quarter of labelled exposures actually come from rules).
- **30% popularity**: 1, 2 or 3 items (weights 0.45/0.35/0.2) sampled in proportion to a fixed, hand-set prior
  (`POPULARITY_PRIOR`: e.g. larger text, calm screen and bill-first 3; much larger text 0.5).
- **20% uniform exploration**: 1 to 3 eligible items uniformly.

Product policy holds in every round: never an item already in effect, never on an explicit dimension, never against an
explicit conflicting setting, never two items on one dimension or a listed conflict, at most 4 items.

The training input of every example is the **point-in-time snapshot** before that round: answers, settings, view,
explicit dimensions, signals and the history of earlier rounds only.

Note on position bias: raw label rates by position mix position bias with selection (larger suggestions come from the
rules policy, which picks better-matched items), so in the raw logs the third position is kept about as often as the
first even though the generator penalises it.
Monitoring treats acceptance by rank as a diagnostic, not a clean causal estimate.

## 8. Research data: age band (fairness evaluation only)

age score = 0.06·readingEffort − 0.04·tapPrecision + sqrt(1 − v)·N(0, 1), where v is the variance of the first two terms
(corr(readingEffort, tapPrecision) = −0.45), cut at the standard-normal quantiles −1.175, −0.468, 0.202, 0.915 into
18-24 (12%), 25-34 (20%), 35-49 (26%), 50-64 (24%), 65+ (18%).

- The age band is **derived downstream of the traits**. Labels depend on traits and the logging process only, so they
  never depend on age band directly. The link is deliberately weak: the largest between-band difference in any trait mean
  is under 0.4 of the within-band standard deviation (tested), and label rates differ by under 6 points across bands (tested).
- It lives on `SyntheticPerson.research` and is read only by the benchmark's group code. It never appears in a
  `RecommenderInput` or `TrainingExample` (tested by walking every input), and the data-quality checks reject any example
  that contains it.

## 9. Ground truth used by evaluation

For a person and a context (`oracleTruth`): every eligible item gets its utility and a noise-free keep probability
sigmoid(keep logit without the noise term, position 0). Because the noise is symmetric, "probability > 0.5" means the same
with or without it.

- **relevant** = keep probability > 0.5 **and** utility > 0;
- **graded gain** for NDCG = max(0, utility).

Each person has one **evaluation snapshot**: the context at the start of a uniformly chosen round k ∈ {0 … rounds}
(k = 0: a first visit with no history; k = rounds: after all their logged rounds). About 63% of snapshots are warm (have
history).

## 10. Splits

`splitPeople` shuffles person indices with a seed and cuts 60/20/20 (train/validation/test). A person's examples are in
exactly one split (tested). The pipeline cuts training people again 75/25 into "fit" and "calibration" (see PIPELINE.md).
The "warm" helpers select people whose evaluation snapshot has history, and examples whose input has history.

## 11. What this can and cannot show

It **can** show that: the pipeline runs end to end and is reproducible; the model learns structure from noisy, partly
missing, biased logs; it beats the baselines on this world; its probabilities are calibrated on held-out logged feedback;
fairness and cold-start reporting work; the gates catch regressions.

It **cannot** show that: real answers relate to real benefit the way we wrote; real people keep, undo or rate suggestions
like this; the model helps any real person; group differences (or their absence) say anything about real groups. The
first real evidence will come from consented feedback, evaluated with the same pipeline (PIPELINE.md), and from user research.

Modelling choices that shape the results and were **not** tuned on test data: the factor loadings, the utility formulas,
the 0.35 person-item noise, the keep/undo/rating parameters, the logging mixture, and the weak age link. The generator was
not changed to make the evaluation numbers look better.
