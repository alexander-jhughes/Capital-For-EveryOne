# Dial personalisation v2: fairness

> All fairness results so far are on **synthetic people** (SYNTHETIC-DATA.md). The groups, and how they relate to benefit,
> were written by us. The checks show the measurement works and would catch a model that serves one group much worse in
> this world. They say nothing about real groups of people, and nothing has been validated with real users.

## 1. What we measure, and how

For every held-out synthetic test person, each system ranks every eligible item; we compute NDCG@3 against the person's
hidden true benefit (gain = max(0, benefit)) and the false-recommendation rate of the top 3. We then average within groups
and compare the **worst and best group within each family** (`lib/recommender/evaluation/benchmark.ts`):

| Family | Groups | Defined from |
|---|---|---|
| view | Simple, Detailed | current view |
| voice-first | yes, no | answered "Talking", or voice-first is on |
| accessibility settings or screen reader | yes, no | larger text, stronger contrast, reduced motion, bigger buttons or roomy spacing on, or "uses a screen reader" |
| new to credit | yes, no | answered "I'm new to them" |
| repeat rejecter | yes, no | turned down 2 or more suggested items before (fatigue) |
| undid a suggestion | yes, no | undid a kept suggestion before |
| conflicting answers | yes, no | "everything at once" with "just the key facts", or "as little as possible" with "all the detail" |
| age band (fairness only) | 18-24, 25-34, 35-49, 50-64, 65+ | research data, never a model input |

Cold-start strata (0 answers, 1-4, 5+, has history) are reported alongside (EVALUATION.md §5).

- **Disparity ratio** = worst group mean / best group mean within a family, over groups with at least 50 people.
- **Gate**: the lowest family ratio must be ≥ 0.8 (EVALUATION.md §11). Per-group false-recommendation rates are reported
  too, because a model can rank equally well for two groups and still suggest more unhelpful things to one of them.
- End-to-end, the report also shows whether people who turned suggestions down repeatedly are offered fewer (they should be).

Current synthetic results are in EVALUATION.md §6 (generated; do not copy numbers here, they change with every retrain).

## 2. Demographics are never model inputs

The only demographic Dial can hold is an optional **age band**, under a separate `research` consent, stored separately and
used only for aggregate fairness checks. The guarantee is enforced in layers:

1. **Types**: `RecommenderInput` and `TrainingExample` (`lib/recommender/types.ts`) have no field for it; `ResearchAnswers`
   is a separate type in `lib/recommender/profile.ts`.
2. **Backend**: the training export (`exportEligibleTrainingData` in `lib/server/personalisation/pipeline-store.ts`, backend workstream) never reads the research table.
3. **Generator**: the synthetic age band lives on `SyntheticPerson.research`, is derived downstream of the traits (labels
   never depend on it directly) and is never copied into an input. Test: `lib/recommender/synthetic.test.ts`
   ("no age band (key or value) appears in any input or training example").
4. **Harness**: groups read the age band from the synthetic person, never from the input. Test:
   `lib/recommender/evaluation/benchmark.test.ts` ("never passes research data to a scorer") checks every input a scorer receives.
5. **Data-quality checks**: any age band key or value in a training input stops the training run
   (`lib/recommender/evaluation/quality.ts`, tested in `quality.test.ts`).
6. **Artifact**: the bundled model contains no age band key or value (`lib/recommender/models/index.test.ts`).

Not using a characteristic does not make a model fair: other inputs can act as proxies (for example, people who set larger
text may skew older). That is exactly why the age band is *measured*: with real research data, a gap between age bands
would reveal a proxy effect the model learned without ever seeing age.

## 3. Protected characteristics and sensitive data

- Dial never asks about health, disability, income, debt, gender, ethnicity, religion or anything financial about a
  person's situation, and never infers any of them. Recommendations are interface settings only.
- "Do you use a screen reader?" is about a tool, not a condition; accessibility *settings* are the person's own explicit
  choices and are never lowered or overridden.
- Groups such as "accessibility settings" are evaluation slices, not labels attached to a person, and nothing about group
  membership is shown to anyone.
- Real fairness checks will use only people who granted research consent, only in aggregate, and should only report groups
  with enough people (at least 50 per group here) so no individual can be singled out.

## 4. No credit or lending use

Personalisation outputs are display preferences. They are never used, and must never be used, for credit decisions,
limits, pricing, collections, marketing eligibility or any assessment of a person. The engine reads no financial data and
its output cannot express anything but interface settings. Any proposal to use these models, scores or the pseudonymous
data for another purpose needs a new consent and a separate review.

## 5. Limitations

- **Synthetic groups.** We chose how traits relate to groups and to benefit, including a deliberately weak link between
  age band and two traits. Real groups may differ a lot more, or in other ways.
- **Small groups.** Some groups are small (conflicting answers: under 100 test people), so their numbers are noisy.
- **One metric.** Equal NDCG@3 does not mean equal benefit, equal reach or equal harm; read the false-recommendation and
  policy tables too.
- **Intersectional groups** (e.g. new to credit and 65+) are not reported; with real data they will usually be too small.
- **The model only learns from what it shows.** If a group is offered fewer suggestions, it produces less feedback and the
  model can fall further behind for it. Monitoring (PIPELINE.md §9) watches acceptance by item and evidence level, but a
  per-group live check needs research-consented data.
