// The evaluation record written next to every trained model (JSON) and its readable form (EVALUATION.md).
// Pure: the training script gathers the numbers, this file only shapes and renders them.
import { AGE_BANDS } from "../profile";
import type { BenchmarkResult, ContenderResult, MetricRecord } from "./benchmark";
import { STRATA } from "./benchmark";
import type { Gate } from "./gates";
import type { MonitoringReference } from "./monitoring";
import type { QualityReport } from "./quality";

export const EVALUATION_FORMAT = "cfe-recommender-evaluation";

export const SYNTHETIC_DISCLAIMER =
  "All evaluation data is SYNTHETIC. The generator's relationships (which hidden trait drives which answer, setting, signal and benefit) were written by us. " +
  "These results show that the pipeline works and that the models can recover structure we put into the data. They do NOT show that any model helps real people, " +
  "and nothing here has been validated with real users.";

/** One candidate of the precision-target sweep, measured on validation people only. */
export interface SweepRow {
  minPrecision: number;
  version: string;
  itemsWithThreshold: number;
  people: number;
  offeredPeople: number;
  suggestionRate: number;
  meanConfigurationSize: number | null;
  offeredItems: number;
  falseRecRate: number | null;
  benefit: number | null;
  expectedKeptRate: number | null;
  /** Label rate of logged validation exposures whose probability clears the item's threshold. */
  labelPrecision: number | null;
  labelPrecisionN: number;
  qualifies: boolean;
}

export interface EvaluationReport {
  format: typeof EVALUATION_FORMAT;
  formatVersion: 1;
  synthetic: true;
  disclaimer: string;
  createdAt: string;
  model: { version: string; algorithm: string; trainedOn: "synthetic" | "synthetic+real"; datasetVersion: string; bytes: number; sha256: string; config: Record<string, unknown> } | null;
  dataset: {
    version: string;
    generatorVersion: number;
    seed: number;
    people: number;
    examples: number;
    dismissedRounds: number;
    labelRate: number;
    policyShares: Record<string, number>;
    contentSha256: string;
    preprocessingVersion: string;
  };
  split: {
    description: string;
    people: Record<"fit" | "calibration" | "validation" | "test", number>;
    examples: Record<"fit" | "calibration" | "validation" | "test", number>;
  };
  realData: { used: boolean; reason: string; subjects: number; examples: number; excluded: Record<string, number> };
  quality: QualityReport;
  selection: {
    /** Plain-English selection rule. */
    rule: string;
    maxFalseRec: number;
    minOffers: number;
    candidates: SweepRow[];
    /** Name of the deployed model in the benchmark tables, or null when no model was trained. */
    chosen: string | null;
    chosenMinPrecision: number | null;
    /** False when no candidate qualified and the default was kept. */
    qualified: boolean;
    note: string;
  };
  validation: BenchmarkResult;
  test: BenchmarkResult;
  /** Real held-out feedback (logged only: no hidden truth exists for real people). */
  realTest: { n: number; auc: number | null; ece: number | null; brier: number | null } | null;
  overfitting: { name: string; train: { ndcg3: number | null; auc: number | null }; validation: { ndcg3: number | null; auc: number | null }; test: { ndcg3: number | null; auc: number | null } }[];
  gates: { passed: boolean; gates: Gate[]; evaluatedOn: string };
  monitoringReference: MonitoringReference;
  timingsMs: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(d));
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(d)}%`);
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: (string | number)[][]) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const bold = (s: string) => `**${s}**`;

function find(b: BenchmarkResult, name: string): ContenderResult | undefined {
  return b.contenders.find((c) => c.name === name);
}

function overallTable(b: BenchmarkResult, chosen: string | null): string {
  return table(
    ["System", "P@1", "P@3", "P@5", "R@3", "NDCG@1", "NDCG@3", "NDCG@5", "False rec @3", "Benefit @3", "Expected kept @3", "Kept but no help @3", "Catalogue coverage @3"],
    b.contenders.map((c) => {
      const o = c.oracle.overall;
      const name = c.name === chosen ? bold(c.name) : c.name;
      return [
        name,
        f(o["precision@1"]),
        f(o["precision@3"]),
        f(o["precision@5"]),
        f(o["recall@3"]),
        f(o["ndcg@1"]),
        c.name === chosen ? bold(f(o["ndcg@3"])) : f(o["ndcg@3"]),
        f(o["ndcg@5"]),
        pct(o["falseRec@3"]),
        f(o["benefit@3"]),
        pct(o["expectedKept@3"]),
        pct(o["harmfulShareOfKept@3"]),
        pct(o["catalogueCoverage@3"], 0),
      ];
    }),
  );
}

function loggedTable(b: BenchmarkResult): string {
  return table(
    ["System", "Exposures scored", "AUC (label)", "AUC cold", "AUC warm", "Rejection AUC", "ECE", "Brier", "Log loss", "Mean predicted", "Observed rate"],
    b.contenders.map((c) => {
      const l = c.logged;
      return [c.name, `${l.n} (${pct(l.scoredShare, 0)})`, f(l.auc), f(l.aucCold), f(l.aucWarm), f(l.rejectionAuc), f(l.calibration.ece), f(l.calibration.brier), f(l.calibration.logLoss), f(l.meanPredicted), f(l.observedRate)];
    }),
  );
}

function reliabilityTable(c: ContenderResult): string {
  return table(
    ["Predicted", "Exposures", "Mean predicted", "Observed label rate", "Gap"],
    c.logged.calibration.bins.map((bin) => [
      `${bin.lo.toFixed(1)}-${bin.hi.toFixed(1)}`,
      bin.n,
      f(bin.meanPredicted),
      f(bin.observedRate),
      bin.meanPredicted === null ? "n/a" : f(Math.abs(bin.meanPredicted - bin.observedRate!)),
    ]),
  );
}

function strataTable(b: BenchmarkResult): string {
  return table(
    ["System", ...STRATA.map((s) => `${s} (n=${b.sizes[s] ?? 0})`)],
    b.contenders.map((c) => [c.name, ...STRATA.map((s) => f(c.oracle.strata[s]?.["ndcg@3"]))]),
  );
}

function groupTable(b: BenchmarkResult, names: string[]): string {
  const groups = Object.keys(b.sizes).filter((g) => !(STRATA as readonly string[]).includes(g));
  const order = (g: string) => {
    const age = AGE_BANDS.findIndex((a) => g.endsWith(`: ${a}`));
    return age >= 0 ? `z${age}` : g;
  };
  groups.sort((a, b2) => order(a).localeCompare(order(b2)));
  const cs = names.map((n) => find(b, n)).filter((c): c is ContenderResult => !!c);
  return table(
    ["Group", "People", ...cs.flatMap((c) => [`${c.name} NDCG@3`, `${c.name} false rec @3`])],
    groups.map((g) => [g, b.sizes[g], ...cs.flatMap((c) => [f(c.oracle.groups[g]?.["ndcg@3"]), pct(c.oracle.groups[g]?.["falseRec@3"])])]),
  );
}

function disparityTable(b: BenchmarkResult, names: string[]): string {
  const cs = names.map((n) => find(b, n)).filter((c): c is ContenderResult => !!c);
  const families = [...new Set(cs.flatMap((c) => Object.keys(c.oracle.disparity)))].sort();
  return table(
    ["Group family", ...cs.map((c) => `${c.name}: worst/best (worst group)`)],
    families.map((fam) => [
      fam,
      ...cs.map((c) => {
        const d = c.oracle.disparity[fam];
        return d ? `${f(d.ratio)} (${d.worst.slice(fam.length + 2)})` : "n/a";
      }),
    ]),
  );
}

function policyTable(b: BenchmarkResult): string {
  const cs = b.contenders.filter((c) => c.policy);
  return table(
    ["System", "Offered to", "Mean size", "Items offered", "False rec (offered)", "Benefit (offered)", "Expected kept", "Kept but no help", "Net benefit / person", "Coverage", "Offered to repeat rejecters / others", "Policy violations"],
    cs.map((c) => {
      const p = c.policy!;
      return [
        c.name,
        pct(p.suggestionRate),
        f(p.meanConfigurationSize, 2),
        p.offeredItems,
        pct(p.falseRecRate),
        f(p.benefit),
        pct(p.expectedKeptRate),
        pct(p.harmfulShareOfKept),
        f(p.netBenefitPerPerson, 4),
        pct(p.catalogueCoverage, 0),
        `${pct(p.suggestionRateRepeatRejecters)} / ${pct(p.suggestionRateOthers)}`,
        p.policyViolations,
      ];
    }),
  );
}

function beforeAfter(b: BenchmarkResult, chosen: string | null): string {
  const names = ["v1 forest", "rules", "popularity", ...(chosen ? [chosen] : [])];
  const cs = names.map((n) => find(b, n)).filter((c): c is ContenderResult => !!c);
  const m = (c: ContenderResult, k: string) => c.oracle.overall[k];
  return table(
    ["System", "NDCG@3", "P@3", "False rec @3", "Benefit @3", "AUC (logged)", "ECE", "Items it can suggest", "Offered to", "False rec (offered)"],
    cs.map((c) => [
      c.name === chosen ? bold(c.name) : c.name,
      f(m(c, "ndcg@3")),
      f(m(c, "precision@3")),
      pct(m(c, "falseRec@3")),
      f(m(c, "benefit@3")),
      f(c.logged.auc),
      f(c.logged.calibration.ece),
      c.name === "v1 forest" ? "8 of 16" : "16 of 16",
      c.policy ? pct(c.policy.suggestionRate) : "n/a",
      c.policy ? pct(c.policy.falseRecRate) : "n/a",
    ]),
  );
}

function latencyTable(b: BenchmarkResult): string {
  return table(
    ["System", "Scoring p50 (ms)", "p95", "p99", "recommend() p95", "Artifact"],
    b.contenders.map((c) => [c.name, f(c.latencyMs.p50, 4), f(c.latencyMs.p95, 4), f(c.latencyMs.p99, 4), f(c.latencyMs.policyP95, 4), c.bytes === null ? "n/a" : `${(c.bytes / 1024).toFixed(1)} KB`]),
  );
}

const metric = (r: MetricRecord | undefined, k: string) => (r ? r[k] : null);

/** Plain statements computed from the numbers, including the unflattering ones. */
export function findings(r: EvaluationReport): string[] {
  const t = r.test;
  const h = r.selection.chosen ? find(t, r.selection.chosen) : undefined;
  if (!h) return [];
  const n3 = (c: ContenderResult | undefined) => (c ? (c.oracle.overall["ndcg@3"] ?? null) : null);
  const out: string[] = [];
  const [pop, rules, v1, random] = ["popularity", "rules", "v1 forest", "random"].map((n) => find(t, n));
  out.push(
    `Ranking (oracle NDCG@3, test): hybrid ${f(n3(h))}; rules ${f(n3(rules))}, popularity ${f(n3(pop))}, v1 forest ${f(n3(v1))}, random ${f(n3(random))}; hidden-truth ceiling 1.000. ` +
      "The model recovers part of the structure we wrote into the generator, and much is left.",
  );
  const comps = ["content", "collaborative", "factorization"].map((n) => find(t, n)).filter((c): c is ContenderResult => !!c);
  const better = comps.filter((c) => (n3(c) ?? -1) >= (n3(h) ?? 0));
  if (better.length)
    out.push(
      `**Stacking does not improve ranking here**: ${better.map((c) => `${c.name} alone ${f(n3(c))}`).join(", ")} ≥ hybrid ${f(n3(h))} on test NDCG@3, ` +
        `with the components trained on the same people as the hybrid's own. ECE: hybrid ${f(h.logged.calibration.ece)}, ${better.map((c) => `${c.name} ${f(c.logged.calibration.ece)}`).join(", ")}. ` +
        "What the hybrid adds is the calibrated stacker that the per-item suggestion thresholds and evidence levels are built on, not better ordering.",
    );
  else {
    const best = comps.reduce((a, b) => ((n3(b) ?? -1) > (n3(a) ?? -1) ? b : a));
    const margin = (n3(h) ?? 0) - (n3(best) ?? 0);
    out.push(
      margin < 0.01
        ? `The hybrid ranks only **marginally** better than its best component alone (${best.name} ${f(n3(best))} vs hybrid ${f(n3(h))}, components trained on the same people; ` +
            `all: ${comps.map((c) => `${c.name} ${f(n3(c))}`).join(", ")}). The case for stacking rests on the calibrated probabilities that suggestion thresholds and evidence levels need, not on ranking.`
        : `The hybrid ranks better than each component alone (${comps.map((c) => `${c.name} ${f(n3(c))}`).join(", ")}; components trained on the same people).`,
    );
  }
  if (h.policy && rules?.policy) {
    const hp = h.policy;
    const rp = rules.policy;
    out.push(
      `Suggestions actually offered: the hybrid offers something to ${pct(hp.suggestionRate)} of test people, and ${pct(hp.falseRecRate)} of the items it offers would not help (true benefit ≤ 0); ` +
        `the rules offer to ${pct(rp.suggestionRate)} with ${pct(rp.falseRecRate)} not helping.` +
        (rp.netBenefitPerPerson > hp.netBenefitPerPerson
          ? ` Because the rules reach far more people, their expected benefit per person overall (${f(rp.netBenefitPerPerson, 4)}) is higher than the hybrid's (${f(hp.netBenefitPerPerson, 4)}): ` +
            "the hybrid is right far more often but helps fewer people in total. That is the reach / wrong-suggestion trade-off in §10."
          : ` The hybrid's expected benefit per person overall (${f(hp.netBenefitPerPerson, 4)}) is also higher than the rules' (${f(rp.netBenefitPerPerson, 4)}).`),
    );
  }
  const off = h.logged.calibration.bins.filter((b) => b.n >= 30 && b.meanPredicted !== null && Math.abs(b.meanPredicted - b.observedRate!) > 0.05);
  out.push(
    `Calibration on held-out logged feedback: ECE ${f(h.logged.calibration.ece)}.` +
      (off.length
        ? ` But ${off.map((b) => `the ${b.lo.toFixed(1)}-${b.hi.toFixed(1)} bin (n=${b.n}) predicts ${f(b.meanPredicted)} against an observed ${f(b.observedRate)}`).join("; ")}: ` +
          "the highest probabilities are overconfident, and that is where suggestion thresholds sit."
        : " No bin with at least 30 exposures is off by more than 0.05."),
  );
  const strata = Object.entries(h.oracle.strata).map(([k, v]) => [k, v["ndcg@3"] ?? null] as const);
  if (strata.length) {
    const lo = strata.reduce((a, b) => ((b[1] ?? 9) < (a[1] ?? 9) ? b : a));
    const hi = strata.reduce((a, b) => ((b[1] ?? -9) > (a[1] ?? -9) ? b : a));
    out.push(`Cold start: NDCG@3 ranges from ${f(lo[1])} (${lo[0]}) to ${f(hi[1])} (${hi[0]}).`);
  }
  const worst = Object.entries(h.oracle.disparity)
    .filter(([, d]) => d !== null)
    .sort((a, b) => a[1]!.ratio - b[1]!.ratio)[0];
  if (worst)
    out.push(
      `Groups: the lowest worst/best NDCG@3 ratio within a family is ${f(worst[1]!.ratio)} (${worst[1]!.worst} vs ${worst[1]!.best}); ` +
        `the age-band ratio is ${f(h.oracle.disparity["age band (fairness only)"]?.ratio)}. These are synthetic groups (see FAIRNESS.md).`,
    );
  const o = r.overfitting.find((x) => x.name === h.name);
  if (o) out.push(`Overfitting: hybrid AUC train ${f(o.train.auc)} / validation ${f(o.validation.auc)} / test ${f(o.test.auc)}; NDCG@3 ${f(o.train.ndcg3)} / ${f(o.validation.ndcg3)} / ${f(o.test.ndcg3)}.`);
  return out;
}

/** Renders EVALUATION.md. Deterministic except for timings and latency, which are measured. */
export function renderEvaluation(r: EvaluationReport): string {
  const chosen = r.selection.chosen;
  const t = r.test;
  const best = chosen ? find(t, chosen) : undefined;
  const gateRows = r.gates.gates.map((g) => [g.passed ? "pass" : bold("FAIL"), g.description, typeof g.value === "number" ? f(g.value, 4) : "n/a", typeof g.threshold === "number" ? f(g.threshold, 4) : "n/a", g.note ?? ""]);
  const headline = best
    ? `${chosen}: oracle NDCG@3 ${f(metric(best.oracle.overall, "ndcg@3"))} (popularity ${f(metric(find(t, "popularity")?.oracle.overall, "ndcg@3"))}, rules ${f(metric(find(t, "rules")?.oracle.overall, "ndcg@3"))}, v1 forest ${f(metric(find(t, "v1 forest")?.oracle.overall, "ndcg@3"))}, hidden-truth ceiling 1.000); logged AUC ${f(best.logged.auc)}, ECE ${f(best.logged.calibration.ece)}.`
    : "No trained model in this run: baselines only.";
  const families = [...(chosen ? [chosen] : []), "content", "collaborative", "factorization", "popularity", "rules", "v1 forest"].filter((n) => find(t, n));
  const q = r.quality;

  return `# Dial personalisation v2: evaluation report

> **Generated by \`scripts/recommender/train.ts\`. Do not edit by hand.**
>
> **${r.disclaimer}**

- Model: ${r.model ? `\`${r.model.version}\` (${r.model.algorithm}), trained on **${r.model.trainedOn}** data, ${(r.model.bytes / 1024).toFixed(1)} KB, sha256 \`${r.model.sha256.slice(0, 16)}…\`` : "none"}
- Dataset: \`${r.dataset.version}\`: synthetic generator v${r.dataset.generatorVersion}, seed ${r.dataset.seed}, ${r.dataset.people} people, ${r.dataset.examples} labelled exposures (${pct(r.dataset.labelRate)} positive), ${r.dataset.dismissedRounds} "Not now" rounds without labels. Content sha256 \`${r.dataset.contentSha256.slice(0, 16)}…\`, preprocessing \`${r.dataset.preprocessingVersion}\`.
- Real data: ${r.realData.used ? `**used**: ${r.realData.subjects} people, ${r.realData.examples} examples` : `not used (${r.realData.reason})`}
- Headline (test people, reported once): ${headline}
- Promotion gates: ${r.gates.passed ? "**all passed**" : "**FAILED** (see §11): this model must not be promoted"}.
- Generated ${r.createdAt}. Timings: ${Object.entries(r.timingsMs)
    .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
    .join(", ")}.

## Findings

${findings(r)
  .map((x) => `- ${x}`)
  .join("\n")}

How to read this: the **oracle** numbers judge each system's ranking of every eligible item against each held-out synthetic person's hidden truth (relevant = would keep it with probability > 0.5 *and* it truly helps; NDCG gain = max(0, true benefit)). The **logged** numbers use only what the biased logging policy happened to show, as real feedback would. "False rec" = recommended items whose true benefit is ≤ 0. "Kept but no help" = share of expected keeps that are items which do not help (the gap between clicking Keep and being helped).

## 1. Data and splits

${r.split.description}

${table(
  ["Part", "People", "Examples"],
  (["fit", "calibration", "validation", "test"] as const).map((k) => [k, r.split.people[k], r.split.examples[k]]),
)}

Logging policy mixture in the data: ${Object.entries(r.dataset.policyShares)
    .map(([k, v]) => `${k} ${pct(v)}`)
    .join(", ")} of labelled exposures.

**Data-quality checks** (every example, before training): ${q.ok ? "passed" : "**FAILED**"}. ${q.examples} examples from ${q.subjects} subjects; invalid ${Object.values(q.invalid).reduce((s, v) => s + v, 0)}; exact duplicates ${q.duplicates}; split leakage ${q.leakage ? JSON.stringify(q.leakage) : "n/a"}; research data in inputs: none allowed (checked).${q.errors.length ? `\nErrors: ${q.errors.join("; ")}` : ""}${q.warnings.length ? `\nWarnings: ${q.warnings.join("; ")}` : ""}

${table(
  ["Item", "Labelled", "Positive rate"],
  Object.entries(q.labelBalance).map(([id, b]) => [`\`${id}\``, b.n, pct(b.rate)]),
)}

## 2. Overall ranking quality, oracle (test people)

${overallTable(t, chosen)}

The hidden-truth ceiling (\`oracle\`) scores with the generator's own truth: NDCG 1.0 by construction. It can never be deployed; it shows how much room is left. Its false-recommendation rate is not 0 because many people have fewer than 3 eligible items that help.

## 3. Logged feedback: discrimination and calibration (test people's logged exposures)

${loggedTable(t)}

AUC uses the label (kept and not undone and not rated unhelpful). Rejection AUC ranks explicit "No thanks" above kept items by 1 − P(keep). v1 can only score the 8 items it was built for, so it is judged on fewer exposures.
${r.realTest ? `\nReal held-out feedback: ${r.realTest.n} examples, AUC ${f(r.realTest.auc)}, ECE ${f(r.realTest.ece)}, Brier ${f(r.realTest.brier)}.` : ""}

## 4. Calibration: reliability table${best ? ` (${chosen}, test)` : ""}

${best ? reliabilityTable(best) : "n/a"}

## 5. Cold start (test people, oracle NDCG@3)

${strataTable(t)}

## 6. Groups and fairness (test people)

Age band is **research data used only to measure fairness**: it is read from the synthetic person and is never part of any model input (tested in \`lib/recommender/synthetic.test.ts\` and \`lib/recommender/evaluation/benchmark.test.ts\`). The fairness gate compares the worst and best group within each family.

### Worst-group / best-group NDCG@3 within each family

${disparityTable(t, families)}

### Per group

${groupTable(t, families.filter((n) => n !== "content" && n !== "collaborative" && n !== "factorization"))}

## 7. End-to-end policy (what each system would actually offer, test people)

${policyTable(t)}

"Offered to repeat rejecters / others" shows fatigue behaviour: people who turned down 2 or more items before should be offered less. Policy violations (ineligible items or incompatible configurations) must be 0. The v1 policy is the real v1 \`recommendPreferences\`, limited to items the v2 product policy allows.

## 8. Before and after: v1 forest and the rules vs the new model (test people)

${beforeAfter(t, chosen)}

## 9. Overfitting: train vs validation vs test

${table(
  ["System", "Train NDCG@3", "Validation NDCG@3", "Test NDCG@3", "Train AUC", "Validation AUC", "Test AUC"],
  r.overfitting.map((o) => [o.name, f(o.train.ndcg3), f(o.validation.ndcg3), f(o.test.ndcg3), f(o.train.auc), f(o.validation.auc), f(o.test.auc)]),
)}

## 10. Model selection: the precision target (validation people only)

${r.selection.rule}

${table(
  [
    "minPrecision",
    "Items with a threshold",
    "People offered a suggestion",
    "Mean configuration size",
    "Items offered",
    "Label precision at threshold (logged exposures)",
    "False rec (offered, true benefit ≤ 0)",
    "Benefit (offered)",
    "Expected kept (offered)",
    `Qualifies (false rec ≤ ${pct(r.selection.maxFalseRec, 0)}, ≥ ${r.selection.minOffers} offers)`,
  ],
  r.selection.candidates.map((c) => [
    c.minPrecision === r.selection.chosenMinPrecision ? bold(c.minPrecision.toFixed(2)) : c.minPrecision.toFixed(2),
    `${c.itemsWithThreshold} of 16`,
    `${c.offeredPeople} of ${c.people} (${pct(c.suggestionRate)})`,
    f(c.meanConfigurationSize, 2),
    c.offeredItems,
    `${pct(c.labelPrecision)} (n=${c.labelPrecisionN})`,
    pct(c.falseRecRate),
    f(c.benefit),
    pct(c.expectedKeptRate),
    c.qualifies ? "yes" : "no",
  ]),
)}

${r.selection.note}

Validation results for every system (selection set):

${overallTable(r.validation, chosen)}

## 11. Promotion gates (${r.gates.evaluatedOn})

${table(["Result", "Gate", "Value", "Threshold", "Note"], gateRows)}

## 12. Latency and size

${latencyTable(t)}

Latency is measured in this process on this machine (Node ${typeof process !== "undefined" ? process.version : ""}), on fresh copies of the inputs. It varies between runs; everything else in this report is deterministic for a given seed.

## 13. Limitations

- **Synthetic only.** Every number above comes from a world we wrote (docs/ml-personalisation/v2/SYNTHETIC-DATA.md). A model that does well here has recovered structure we put in. Real people may relate answers, settings and benefit very differently, or not at all.
- The "true benefit" is our construct. Real benefit can only be estimated from behaviour (kept, undone, ratings), which is noisy and biased by what was shown.
- The logged evaluation inherits the logging policy's exposure bias (rules, popularity, a little exploration); no off-policy correction is applied.
- Fairness is measured on synthetic groups with a deliberately weak link between age band and traits. It says nothing about real disparities.
- See docs/ml-personalisation/v2/FAIRNESS.md and PIPELINE.md.
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Stored forms
// ---------------------------------------------------------------------------------------------------------------

const KEEP_IN_GROUPS = ["people", "candidates", "relevant", "precision@3", "recall@3", "ndcg@3", "falseRec@3", "benefit@3", "expectedKept@3", "harmfulShareOfKept@3"];

function slimRecord(r: MetricRecord): MetricRecord {
  const out: MetricRecord = {};
  for (const k of KEEP_IN_GROUPS) if (k in r) out[k] = r[k];
  return out;
}

/** Keeps the stored evaluation small: per-group and per-stratum records carry the headline metrics only. */
export function slimBenchmark(b: BenchmarkResult, keepGroups: boolean): BenchmarkResult {
  return {
    ...b,
    contenders: b.contenders.map((c) => ({
      ...c,
      oracle: {
        ...c.oracle,
        strata: Object.fromEntries(Object.entries(c.oracle.strata).map(([k, v]) => [k, slimRecord(v)])),
        groups: keepGroups ? Object.fromEntries(Object.entries(c.oracle.groups).map(([k, v]) => [k, slimRecord(v)])) : {},
      },
    })),
  };
}

/** Rounds every number (6 decimals) so stored JSON is compact and stable. */
export const roundedJson = (x: unknown, space?: number) => JSON.stringify(x, (_k, v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v), space);

/**
 * Headline numbers for the model registry (model_versions.metrics) and BUNDLED_METRICS. promote.ts reads `gates`,
 * monitor.ts reads `monitoringReference`.
 */
export function registryMetrics(r: EvaluationReport): Record<string, unknown> {
  const t = r.test;
  const chosen = r.selection.chosen;
  const c = chosen ? find(t, chosen) : undefined;
  const base = (name: string) => {
    const b = find(t, name);
    return b ? { ndcg3: b.oracle.overall["ndcg@3"], falseRec3: b.oracle.overall["falseRec@3"], loggedAuc: b.logged.auc, ece: b.logged.calibration.ece } : null;
  };
  return {
    synthetic: r.model?.trainedOn !== "synthetic+real",
    disclaimer: r.disclaimer,
    evaluatedOn: `held-out synthetic test people (${t.people}), reported once; model chosen on validation people only`,
    headline: c
      ? {
          ndcg3: c.oracle.overall["ndcg@3"],
          precision3: c.oracle.overall["precision@3"],
          recall3: c.oracle.overall["recall@3"],
          falseRec3: c.oracle.overall["falseRec@3"],
          benefit3: c.oracle.overall["benefit@3"],
          loggedAuc: c.logged.auc,
          rejectionAuc: c.logged.rejectionAuc,
          ece: c.logged.calibration.ece,
          brier: c.logged.calibration.brier,
          minDisparityRatio: c.oracle.minDisparityRatio,
          suggestionRate: c.policy?.suggestionRate ?? null,
          offeredFalseRecRate: c.policy?.falseRecRate ?? null,
          latencyP95Ms: c.latencyMs.policyP95 ?? c.latencyMs.p95,
        }
      : null,
    baselines: { popularity: base("popularity"), rules: base("rules"), v1Forest: base("v1 forest") },
    gates: { passed: r.gates.passed, evaluatedOn: r.gates.evaluatedOn, failed: r.gates.gates.filter((g) => !g.passed).map((g) => g.id), gates: r.gates.gates.map((g) => ({ id: g.id, passed: g.passed, value: g.value, threshold: g.threshold })) },
    monitoringReference: r.monitoringReference,
  };
}
