// Renders docs/ml-personalisation/EVALUATION-v2.md from evaluation results (lib/personalisation/evaluate.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { isValidModel } from "../../lib/personalisation/artifact";
import {
  type CrossModeStats,
  EVAL_SAMPLES,
  evaluateModel,
  type EvaluationReport,
  type PipelineStats,
  type RepetitionStats,
  scoreTargets,
  servedPopulation,
  type TargetScore,
} from "../../lib/personalisation/evaluate";
import { generateSynthetic } from "../../lib/personalisation/synthetic";
import { GENERATOR_B_VERSION, generateSyntheticB } from "../../lib/personalisation/synthetic-b";
import { TARGET_IDS, type TargetId } from "../../lib/personalisation/targets";
import { DEFAULT_CONFIG, trainModel } from "../../lib/personalisation/train";

const f = (v: number | null | undefined, digits = 3) => (v === null || v === undefined ? "n/a" : v.toFixed(digits));
const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(digits)}%`);
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: (string | number)[][]) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const offeredTargets = (s: Record<TargetId, TargetScore>) => TARGET_IDS.filter((id) => s[id].threshold !== null);
/** Keep rate over every offer of every target pooled together. */
export const pooledKeep = (s: Record<TargetId, TargetScore>) => {
  let offered = 0;
  let kept = 0;
  for (const id of TARGET_IDS)
    if (s[id].keepRate !== null) {
      offered += s[id].offered;
      kept += s[id].keepRate! * s[id].offered;
    }
  return offered ? kept / offered : null;
};
export const meanOf = (s: Record<TargetId, TargetScore>, k: "auc" | "ece" | "brier") => mean(TARGET_IDS.map((id) => s[id][k]));

export interface BaselineExtras {
  /** Same pipeline trained on generator B: how well B can be learned at all (an upper reference, never shipped). */
  bReference: Record<TargetId, TargetScore>;
  /** v1's own EVALUATION.md numbers on its test split (all synthetic people). */
  reportedCoverage: Partial<Record<TargetId, number>>;
}

function rankingTable(r: EvaluationReport) {
  return table(
    ["Target", "Eligible", "Base rate", "AUC", "Brier", "ECE", "AUC (as reported)", "ECE (as reported)"],
    TARGET_IDS.map((id) => {
      const s = r.a[id];
      const rep = r.aAsReported[id];
      return [`\`${id}\``, s.eligible, pct(s.baseRate), f(s.auc), f(s.brier), f(s.ece), f(rep.auc), f(rep.ece)];
    }),
  );
}

function reliabilityTable(s: Record<TargetId, TargetScore>) {
  const bins = s[TARGET_IDS[0]].reliability;
  return table(
    ["Target", ...bins.map((b) => `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`)],
    TARGET_IDS.map((id) => [`\`${id}\``, ...s[id].reliability.map((b) => (b.n ? `${pct(b.observed, 0)} (${b.n})` : "·"))]),
  );
}

function robustnessTable(r: EvaluationReport, bRef?: Record<TargetId, TargetScore>) {
  return table(
    ["Target", "AUC on A", "AUC on B", ...(bRef ? ["AUC on B, reference trained on B"] : []), "ECE on A", "ECE on B", "Keep rate at threshold, A (offers)", "Keep rate at threshold, B (offers)", "B base rate"],
    TARGET_IDS.map((id) => {
      const a = r.a[id];
      const b = r.b[id];
      const at = (s: TargetScore) => (s.threshold === null ? "not offered" : `${pct(s.keepRate)} (${s.offered})`);
      return [`\`${id}\``, f(a.auc), f(b.auc), ...(bRef ? [f(bRef[id].auc)] : []), f(a.ece), f(b.ece), at(a), at(b), pct(b.baseRate)];
    }),
  );
}

function coverageTable(a: PipelineStats, b: PipelineStats, r: EvaluationReport, reported?: Partial<Record<TargetId, number>>) {
  return table(
    ["Target", "Threshold", ...(reported ? ["v1 EVALUATION.md: offered to"] : []), "A: shown as the Home card", "A: kept when shown", "B: shown as the Home card", "B: kept when shown"],
    TARGET_IDS.map((id) => [
      `\`${id}\``,
      r.a[id].threshold === null ? "none" : f(r.a[id].threshold, 2),
      ...(reported ? [reported[id] === undefined ? "0" : pct(reported[id])] : []),
      `${pct(a.byTarget[id].rate, 2)} (${a.byTarget[id].shown} of ${a.byTarget[id].eligible})`,
      pct(a.byTarget[id].keptWhenShown),
      `${pct(b.byTarget[id].rate, 2)} (${b.byTarget[id].shown} of ${b.byTarget[id].eligible})`,
      pct(b.byTarget[id].keptWhenShown),
    ]),
  );
}

function repetitionTable(rs: RepetitionStats[]) {
  const label: Record<RepetitionStats["policy"], string> = { noThanks: "Always says No thanks", notNow: "Always says Not now", labels: "Keeps what they like, else No thanks or Not now (50/50)" };
  return table(
    ["Person", "People", `Suggestions shown over ${rs[0]?.visits ?? 0} visits (mean)`, "2+ suggestions in one visit", "Most in one visit", "Same suggestion shown again after No thanks / Not now", "Shown anything after 2 No thanks in a row"],
    rs.map((s) => [label[s.policy], s.people, f(s.shownPerPerson, 2), pct(s.multiplePerVisit), s.maxPerVisit, pct(s.sameAgain), pct(s.afterTwoNoes)]),
  );
}

function crossModeTable(c: CrossModeStats, offered: TargetId[]) {
  const groups: [string, PipelineStats][] = [
    ["Simple view", c.simple],
    ["Detailed view", c.detailed],
    ["Simple-view people, if they switched to Detailed", c.simpleSwitchedToDetailed],
    ["Detailed-view people, if they switched to Simple", c.detailedSwitchedToSimple],
    ["Talking to Dial first is on", c.talkingFirstOn],
  ];
  return table(
    ["Group", "People", "Any suggestion", ...offered.map((id) => `\`${id}\` (of eligible)`)],
    groups.map(([name, s]) => [name, s.people, pct(s.anySuggestion), ...offered.map((id) => pct(s.byTarget[id].rate, 2))]),
  );
}

/** One full section ("Baseline (v1)" or "Candidate (v2)"). */
export function renderSection(title: string, r: EvaluationReport, extras?: Partial<BaselineExtras>) {
  const offered = offeredTargets(r.a);
  return `## ${title}

Model \`${r.modelVersion}\`. Offered targets: ${offered.map((id) => `\`${id}\``).join(", ") || "none"}.

### 1. Ranking and calibration (generator A, people the app can score)

${r.people.aServed} of ${r.people.a} synthetic people. "As reported" = everyone in the sample, as v1's EVALUATION.md measured (includes people who never consented, the older schema and Make it yours ticks, none of which the app ever scores).
ECE = expected calibration error over 10 equal-width bins (0 = "0.7" means exactly 70% kept). Mean AUC ${f(meanOf(r.a, "auc"))}, mean ECE ${f(meanOf(r.a, "ece"))}, mean Brier ${f(meanOf(r.a, "brier"))}.

${rankingTable(r)}

**Reliability** (share who would keep it, and how many people, per band of predicted probability; generator A):

${reliabilityTable(r.a)}

### 2. Robustness: trained on generator A, tested on generator B

${r.people.bServed} of ${r.people.b} generator B people the app can score. Mean AUC on A ${f(meanOf(r.a, "auc"))} vs on B ${f(meanOf(r.b, "auc"))}${extras?.bReference ? ` (a model trained on B itself reaches ${f(meanOf(extras.bReference, "auc"))})` : ""}. Pooled keep rate of everything offered: A ${pct(pooledKeep(r.a))}, B ${pct(pooledKeep(r.b))}.

${robustnessTable(r, extras?.bReference)}

### 3. Coverage: who actually gets a suggestion

The real \`recommendPreferences()\` with every gate (threshold, floor, reasons, conflicts, overlaps), one suggestion at a time as the provider asks for. Any suggestion at all: **${pct(r.pipelineA.anySuggestion)}** of generator A people, ${pct(r.pipelineB.anySuggestion)} of generator B people.

${coverageTable(r.pipelineA, r.pipelineB, r, extras?.reportedCoverage)}

### 4. Repetition over visits

Generator A people who are offered something on their first visit, simulated over 6 visits. After every answer the model is re-evaluated, as the provider does. Between visits there is a 30% chance the person changes one of their own settings (light/dark theme).

${repetitionTable(r.repetition)}

### 5. Cross-mode: Simple vs Detailed view, and talking first

Share of eligible people shown each offered suggestion. Generator A:

${crossModeTable(r.crossModeA, offered)}

Generator B:

${crossModeTable(r.crossModeB, offered)}
`;
}

/** Plain-English findings for a model, computed from the numbers so they never drift from the tables. */
export function findings(r: EvaluationReport, extras: Partial<BaselineExtras> = {}) {
  const offered = offeredTargets(r.a);
  const shownA = offered.reduce((n, id) => n + r.pipelineA.byTarget[id].shown, 0);
  const top = [...offered].sort((x, y) => r.pipelineA.byTarget[y].shown - r.pipelineA.byTarget[x].shown)[0];
  const rep = Object.fromEntries(r.repetition.map((s) => [s.policy, s])) as Record<RepetitionStats["policy"], RepetitionStats>;
  const maxP = Math.max(...TARGET_IDS.flatMap((id) => r.a[id].reliability.filter((b) => b.n > 0).map((b) => b.hi)));
  const lines = [
    `**Served vs reported.** ${offered
      .map((id) => `\`${id}\` reaches ${pct(r.pipelineA.byTarget[id].rate, 2)} of eligible people${extras.reportedCoverage?.[id] !== undefined ? ` (EVALUATION.md: ${pct(extras.reportedCoverage[id])})` : ""}`)
      .join("; ")}. The gap is the population: the app only scores people who consented, on the current schema, without Make it yours ticks.`,
    `**Calibration.** Mean ECE ${f(meanOf(r.a, "ece"))} on generator A and ${f(meanOf(r.b, "ece"))} on generator B. No prediction on A reaches ${maxP.toFixed(1)}: the forest squeezes probabilities towards the base rate, so thresholds sit in a narrow band.`,
    `**Robustness.** Mean AUC falls from ${f(meanOf(r.a, "auc"))} (A) to ${f(meanOf(r.b, "auc"))} (B)${extras.bReference ? `; the same pipeline trained on B itself only reaches ${f(meanOf(extras.bReference, "auc"))}, so B is hard to learn from these inputs at all` : ""}. The bigger problem is the keep rate of what is offered: ${pct(pooledKeep(r.a))} on A but ${pct(pooledKeep(r.b))} on B. The 80% promise holds only under generator A's assumptions.`,
    `**Coverage.** ${pct(r.pipelineA.anySuggestion)} of people the app can score ever see a suggestion; ${shownA ? pct(r.pipelineA.byTarget[top].shown / shownA, 0) : "0%"} of what is shown is \`${top}\`. ${TARGET_IDS.length - offered.length} of ${TARGET_IDS.length} settings are never offered.`,
    `**Repetition.** ${pct(rep.noThanks.sameAgain, 0)} of people who always say No thanks see the same suggestion again after they change any setting (it may come back once per change until the second no). People who always say Not now see ${f(rep.notNow.shownPerPerson, 1)} suggestions over ${rep.notNow.visits} visits. Most in one visit: ${Math.max(...r.repetition.map((s) => s.maxPerVisit))}.`,
    `**Cross-mode.** Any suggestion: ${pct(r.crossModeA.simple.anySuggestion)} in Simple view vs ${pct(r.crossModeA.detailed.anySuggestion)} in Detailed view (generator A).${offered
      .filter((id) => r.crossModeA.simple.byTarget[id].rate > 0 && r.crossModeA.simpleSwitchedToDetailed.byTarget[id].rate === 0)
      .map((id) => ` \`${id}\` disappears entirely when the same people switch to Detailed.`)
      .join("")} With talking first on: ${pct(r.crossModeA.talkingFirstOn.anySuggestion)}.`,
  ];
  return lines.map((l) => `- ${l}`).join("\n");
}

/** Evaluates the committed model and writes EVALUATION-v2.md. Never writes model.json. */
export function writeEvaluation(modelPath: string, evaluationPath: string) {
  const started = performance.now();
  const committed: unknown = JSON.parse(readFileSync(modelPath, "utf8"));
  if (!isValidModel(committed)) throw new Error("model.json is not a valid model for this code");
  const a = generateSynthetic(EVAL_SAMPLES.a);
  const b = generateSyntheticB(EVAL_SAMPLES.b);
  const report = evaluateModel(committed, a, b);
  const bReference = scoreTargets(trainModel(DEFAULT_CONFIG, generateSyntheticB(EVAL_SAMPLES.bReferenceTrain)).model, servedPopulation(b));
  const v1Report = trainModel(DEFAULT_CONFIG).report;
  const reportedCoverage = Object.fromEntries(TARGET_IDS.flatMap((id) => (v1Report.targets[id].recommendations ? [[id, v1Report.targets[id].recommendations!.coverage]] : [])));
  const md = `# Personalisation model: evaluation v2

> **Generated by \`node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts --evaluate\`. Do not edit by hand.**
> **All data here is SYNTHETIC.** These numbers measure the pipeline against its own assumptions and against a second set of assumptions. They say nothing about real people.

## How this evaluation works

- **Fresh samples, never trained on.** Generator A (\`synthetic.ts\`, the one the model is trained on): ${EVAL_SAMPLES.a.people} people, seed ${EVAL_SAMPLES.a.seed}. Generator B (\`synthetic-b.ts\`, version ${GENERATOR_B_VERSION}): ${EVAL_SAMPLES.b.people} people, seed ${EVAL_SAMPLES.b.seed}.
- **Generator B** was designed separately with different assumptions (latent-factor tastes instead of bundles, bimodal engagement, linear adoption, action counts tied strongly to app use and overdispersed, flatter labels with a status-quo bias, ${pct(EVAL_SAMPLES.b.labelNoise)} label noise, current schema only). It is never used for training, thresholds, calibration or tuning, and was frozen before v2 was designed. The same person wrote both generators, so B tests specific assumptions; it is not independent evidence.
- **People the app can score.** \`PersonalisationProvider\` only scores people who consented, passes their settings through the cookie's \`sanitize()\` (current schema), and never passes Make it yours ticks (\`choices: null\`). Every metric below uses exactly that population unless it says "as reported".
- **Coverage, repetition and cross-mode** run the real \`recommendPreferences()\`, \`recordOutcome()\`, \`reconcile()\` and \`onPrefsEvent()\`, one suggestion at a time like the provider.

## Retraining rule (fixed before v2 was built)

A new model replaces \`model.json\` only if, on these fresh samples, all of these hold:

1. **Test AUC.** On generator A as v1 knew it, and on the new generator A: mean AUC at least v1's, and no target more than 0.01 below v1.
2. **Calibration.** Mean ECE (after any calibration step) below v1's on both generator A samples.
3. **Robustness.** On generator B: mean AUC above v1's, and the pooled keep rate of everything offered no lower than v1's.
4. **Keep rate.** Every target the new model offers is kept by at least 80% of the people offered it, on both generator A samples.

${renderSection("Baseline (v1)", report, { bReference, reportedCoverage })}
### What the baseline shows

${findings(report, { bReference, reportedCoverage })}
`;
  writeFileSync(evaluationPath, md);
  console.log(`Evaluated ${report.modelVersion} in ${((performance.now() - started) / 1000).toFixed(1)}s. Wrote ${evaluationPath}`);
}
