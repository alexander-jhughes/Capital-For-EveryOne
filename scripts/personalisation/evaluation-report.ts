// Renders docs/ml-personalisation/EVALUATION-v2.md from evaluation results (lib/personalisation/evaluate.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { isValidModel } from "../../lib/personalisation/artifact";
import type { ModelArtifact } from "../../lib/personalisation/artifact";
import {
  type CrossModeStats,
  crossModeStats,
  EVAL_SAMPLES,
  evaluateModel,
  type EvaluationReport,
  type PipelineStats,
  type RepetitionStats,
  scoreTargets,
  servedPopulation,
  simulateRepetition,
  type TargetScore,
} from "../../lib/personalisation/evaluate";
import { generateSynthetic } from "../../lib/personalisation/synthetic";
import { GENERATOR_B_VERSION, generateSyntheticB } from "../../lib/personalisation/synthetic-b";
import { TARGET_IDS, type TargetId } from "../../lib/personalisation/targets";
import { trainModel, V1_CONFIG, V2_CONFIG } from "../../lib/personalisation/train";

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
export function renderSection(title: string, r: EvaluationReport, extras: Partial<BaselineExtras> | undefined, aName: string) {
  const offered = offeredTargets(r.a);
  return `## ${title}

Model \`${r.modelVersion}\`. Offered targets: ${offered.map((id) => `\`${id}\``).join(", ") || "none"}.

### 1. Ranking and calibration (${aName}, people the app can score)

${r.people.aServed} of ${r.people.a} synthetic people. "As reported" = everyone in the sample, as v1's EVALUATION.md measured (includes people who never consented, the older schema and Make it yours ticks, none of which the app ever scores).
ECE = expected calibration error over 10 equal-width bins (0 = "0.7" means exactly 70% kept). Mean AUC ${f(meanOf(r.a, "auc"))}, mean ECE ${f(meanOf(r.a, "ece"))}, mean Brier ${f(meanOf(r.a, "brier"))}.

${rankingTable(r)}

**Reliability** (share who would keep it, and how many people, per band of predicted probability; ${aName}):

${reliabilityTable(r.a)}

### 2. Robustness: tested on generator B

${r.people.bServed} of ${r.people.b} generator B people the app can score. Mean AUC on A ${f(meanOf(r.a, "auc"))} vs on B ${f(meanOf(r.b, "auc"))}${extras?.bReference ? ` (a model trained on B itself reaches ${f(meanOf(extras.bReference, "auc"))})` : ""}. Pooled keep rate of everything offered: A ${pct(pooledKeep(r.a))}, B ${pct(pooledKeep(r.b))}.

${robustnessTable(r, extras?.bReference)}

### 3. Coverage: who actually gets a suggestion

The real \`recommendPreferences()\` with every gate (threshold, floor, reasons, conflicts, overlaps), one suggestion at a time as the provider asks for. Any suggestion at all: **${pct(r.pipelineA.anySuggestion)}** of people in ${aName}, ${pct(r.pipelineB.anySuggestion)} of generator B people.

${coverageTable(r.pipelineA, r.pipelineB, r, extras?.reportedCoverage)}

### 4. Repetition over visits

People from ${aName} who are offered something on their first visit, simulated over 6 visits. After every answer the model is re-evaluated, as the provider does. Between visits there is a 30% chance the person changes one of their own settings (light/dark theme).

${repetitionTable(r.repetition)}

### 5. Cross-mode: Simple vs Detailed view, and talking first

Share of eligible people shown each offered suggestion. In ${aName}:

${crossModeTable(r.crossModeA, offered)}

In generator B:

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

interface Scores {
  a1: Record<TargetId, TargetScore>;
  a2: Record<TargetId, TargetScore>;
  b: Record<TargetId, TargetScore>;
}

export interface GateResult {
  criterion: string;
  pass: boolean;
  detail: string;
}

/** The retraining rule, checked against the numbers. Every criterion must pass. */
export function retrainingGate(v1: Scores, v2: Scores): GateResult[] {
  const samples = [["A as v1 knew it", "a1"], ["A now", "a2"]] as const;
  const auc = samples.map(([name, k]) => {
    const worst = TARGET_IDS.map((id) => ({ id, d: (v2[k][id].auc ?? 0) - (v1[k][id].auc ?? 0) })).sort((x, y) => x.d - y.d)[0];
    const pass = meanOf(v2[k], "auc")! >= meanOf(v1[k], "auc")! && worst.d >= -0.01;
    return { pass, text: `${name}: mean ${f(meanOf(v1[k], "auc"))} → ${f(meanOf(v2[k], "auc"))}, worst target \`${worst.id}\` ${worst.d >= 0 ? "+" : ""}${worst.d.toFixed(4)}` };
  });
  const cal = samples.map(([name, k]) => ({ pass: meanOf(v2[k], "ece")! < meanOf(v1[k], "ece")!, text: `${name}: ${f(meanOf(v1[k], "ece"))} → ${f(meanOf(v2[k], "ece"))}` }));
  const bAuc = meanOf(v2.b, "auc")! > meanOf(v1.b, "auc")!;
  const bKeep = (pooledKeep(v2.b) ?? 0) >= (pooledKeep(v1.b) ?? 0);
  const keep = samples.flatMap(([name, k]) =>
    offeredTargets(v2[k]).map((id) => ({ pass: v2[k][id].keepRate === null || v2[k][id].keepRate! >= 0.8, text: `\`${id}\` on ${name}: ${pct(v2[k][id].keepRate)} of ${v2[k][id].offered}` })),
  );
  return [
    { criterion: "1. Test AUC", pass: auc.every((x) => x.pass), detail: auc.map((x) => x.text).join("; ") },
    { criterion: "2. Calibration (mean ECE)", pass: cal.every((x) => x.pass), detail: cal.map((x) => x.text).join("; ") },
    {
      criterion: "3. Robustness on generator B",
      pass: bAuc && bKeep,
      detail: `mean AUC ${f(meanOf(v1.b, "auc"))} → ${f(meanOf(v2.b, "auc"))}; pooled keep rate ${pct(pooledKeep(v1.b))} → ${pct(pooledKeep(v2.b))}`,
    },
    { criterion: "4. Keep rate ≥ 80% for every offered target", pass: keep.every((x) => x.pass), detail: keep.map((x) => x.text).join("; ") || "nothing offered" },
  ];
}

function comparisonTable(v1: Scores, v2: Scores) {
  const pair = (a: number | null, b: number | null) => `${f(a)} → ${f(b)}`;
  const keep = (s: TargetScore) => (s.threshold === null ? "–" : `${pct(s.keepRate)} (${s.offered})`);
  const rows = TARGET_IDS.map((id) => [
    `\`${id}\``,
    pair(v1.a1[id].auc, v2.a1[id].auc),
    pair(v1.a2[id].auc, v2.a2[id].auc),
    pair(v1.b[id].auc, v2.b[id].auc),
    pair(v1.a1[id].ece, v2.a1[id].ece),
    pair(v1.a2[id].ece, v2.a2[id].ece),
    `${keep(v1.a2[id])} → ${keep(v2.a2[id])}`,
    `${keep(v1.b[id])} → ${keep(v2.b[id])}`,
  ]);
  rows.push([
    "**mean / pooled**",
    pair(meanOf(v1.a1, "auc"), meanOf(v2.a1, "auc")),
    pair(meanOf(v1.a2, "auc"), meanOf(v2.a2, "auc")),
    pair(meanOf(v1.b, "auc"), meanOf(v2.b, "auc")),
    pair(meanOf(v1.a1, "ece"), meanOf(v2.a1, "ece")),
    pair(meanOf(v1.a2, "ece"), meanOf(v2.a2, "ece")),
    `${pct(pooledKeep(v1.a2))} → ${pct(pooledKeep(v2.a2))}`,
    `${pct(pooledKeep(v1.b))} → ${pct(pooledKeep(v2.b))}`,
  ]);
  return table(["Target (v1 → v2)", "AUC, A as v1 knew it", "AUC, A now", "AUC, B", "ECE, A as v1 knew it", "ECE, A now", "Keep rate at threshold, A now (offers)", "Keep rate at threshold, B (offers)"], rows);
}

/** Evaluates the committed model and the v2 candidate, and writes EVALUATION-v2.md. Never writes model.json. */
export function writeEvaluation(modelPath: string, evaluationPath: string) {
  const started = performance.now();
  const shipped: unknown = JSON.parse(readFileSync(modelPath, "utf8"));
  if (!isValidModel(shipped)) throw new Error("model.json is not a valid model for this code");
  const v1: ModelArtifact = shipped;
  const v2 = trainModel(V2_CONFIG).model;
  const a1 = generateSynthetic(EVAL_SAMPLES.a1);
  const a2 = generateSynthetic(EVAL_SAMPLES.a);
  const b = generateSyntheticB(EVAL_SAMPLES.b);
  const [a1s, a2s, bs] = [a1, a2, b].map(servedPopulation);
  const bTrain = generateSyntheticB(EVAL_SAMPLES.bReferenceTrain);

  const baseline = evaluateModel(v1, a1, b, "v1");
  const candidate = evaluateModel(v2, a2, b, "v2");
  const v1Report = trainModel(V1_CONFIG).report;
  const reportedCoverage = Object.fromEntries(TARGET_IDS.flatMap((id) => (v1Report.targets[id].recommendations ? [[id, v1Report.targets[id].recommendations!.coverage]] : [])));
  const v1Scores: Scores = { a1: baseline.a, a2: scoreTargets(v1, a2s), b: baseline.b };
  const v2Scores: Scores = { a1: scoreTargets(v2, a1s), a2: candidate.a, b: candidate.b };
  const gate = retrainingGate(v1Scores, v2Scores);
  const baselineExtras: BaselineExtras = { bReference: scoreTargets(trainModel(V1_CONFIG, bTrain).model, bs), reportedCoverage };
  const passed = gate.every((g) => g.pass);

  const policies = ["noThanks", "notNow", "labels"] as const;
  const systems: [string, ModelArtifact, "v1" | "v2"][] = [
    ["v1 model, v1 rules (before this branch)", v1, "v1"],
    ["v1 model, new rules (what this branch ships)", v1, "v2"],
    ["v2 candidate, new rules", v2, "v2"],
  ];
  const repetitionRows = systems.flatMap(([name, m, behaviour]) =>
    policies.map((policy) => {
      const r = simulateRepetition(m, a2s, { policy, behaviour });
      return [name, { noThanks: "No thanks", notNow: "Not now", labels: "Keeps what they like" }[policy], r.people, f(r.shownPerPerson, 2), pct(r.multiplePerVisit), r.maxPerVisit, pct(r.sameAgain), pct(r.afterTwoNoes)];
    }),
  );
  const cross = (m: ModelArtifact, people: typeof a2s) => {
    const c: CrossModeStats = crossModeStats(m, people);
    return [pct(c.simple.anySuggestion), pct(c.detailed.anySuggestion), pct(c.simpleSwitchedToDetailed.anySuggestion), pct(c.talkingFirstOn.anySuggestion)];
  };

  const md = `# Personalisation model: evaluation v2

> **Generated by \`node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts --evaluate\`. Do not edit by hand.**
> **All data here is SYNTHETIC.** These numbers measure the pipeline against its own assumptions and against a second set of assumptions. They say nothing about real people.

## Decision

**${passed ? "v2 passes the retraining rule." : "v2 does not pass the retraining rule, so `model.json` stays v1"}** (\`${v1.modelVersion}\`${passed ? "" : `; the v2 candidate \`${v2.modelVersion}\` is trained by \`V2_CONFIG\` for this report only`}).

${table(["Criterion", "Result", "Numbers (v1 → v2)"], gate.map((g) => [g.criterion, g.pass ? "pass" : "**fail**", g.detail]))}

What ships on this branch either way: the new repetition rules (one suggestion per visit, Not now holds for the visit, a pause after two No thanks in a row), the evaluation harness, and the new explicit signals and settings as inputs that a future model can use. They are recorded on the device only with consent, and v1 ignores them.

## How this evaluation works

- **Fresh samples, never trained on.** Generator A as v1 knew it (\`synthetic.ts\` version 1, the Phase A baseline sample) and generator A now (version ${EVAL_SAMPLES.a.version}): ${EVAL_SAMPLES.a.people} people each, seed ${EVAL_SAMPLES.a.seed}. Generator B (\`synthetic-b.ts\`, version ${GENERATOR_B_VERSION}): ${EVAL_SAMPLES.b.people} people, seed ${EVAL_SAMPLES.b.seed}.
- **Generator B** was designed separately with different assumptions (latent-factor tastes instead of bundles, bimodal engagement, linear adoption, action counts tied strongly to app use and overdispersed, flatter labels with a status-quo bias, ${pct(EVAL_SAMPLES.b.labelNoise)} label noise, current schema only). It is never used for training, thresholds, calibration or tuning, and was frozen before v2 was designed. The same person wrote both generators, so B tests specific assumptions; it is not independent evidence.
- **People the app can score.** \`PersonalisationProvider\` only scores people who consented, passes their settings through the cookie's \`sanitize()\` (current schema), and never passes Make it yours ticks (\`choices: null\`). Every metric below uses exactly that population unless it says "as reported".
- **Coverage, repetition and cross-mode** run the real \`recommendPreferences()\`, \`recordOutcome()\`, \`reconcile()\`, \`onPrefsEvent()\` and \`forVisit()\`, one suggestion at a time like the provider.

## Retraining rule (fixed before v2 was built)

A new model replaces \`model.json\` only if, on these fresh samples, all of these hold:

1. **Test AUC.** On generator A as v1 knew it, and on the new generator A: mean AUC at least v1's, and no target more than 0.01 below v1.
2. **Calibration.** Mean ECE (after any calibration step) below v1's on both generator A samples.
3. **Robustness.** On generator B: mean AUC above v1's, and the pooled keep rate of everything offered no lower than v1's.
4. **Keep rate.** Every target the new model offers is kept by at least 80% of the people offered it, on both generator A samples.

## v1 vs v2, side by side

${comparisonTable(v1Scores, v2Scores)}

**Repetition** (people from generator A now who are offered something on their first visit, 6 visits, 30% chance per visit of changing their own theme):

${table(["System", "Person always says", "People", "Suggestions over 6 visits (mean)", "2+ in one visit", "Most in one visit", "Same one again after No thanks / Not now", "Shown anything after 2 No thanks in a row"], repetitionRows)}

**Cross-mode** (share of people with any suggestion):

${table(
  ["Model, sample", "Simple view", "Detailed view", "Simple-view people switched to Detailed", "Talking first on"],
  [
    ["v1, A now", ...cross(v1, a2s)],
    ["v2, A now", ...cross(v2, a2s)],
    ["v1, B", ...cross(v1, bs)],
    ["v2, B", ...cross(v2, bs)],
  ],
)}

${renderSection("Baseline (v1)", baseline, baselineExtras, "generator A as v1 knew it")}
### What the baseline shows

${findings(baseline, baselineExtras)}

${renderSection("Candidate (v2, not shipped)", candidate, { bReference: scoreTargets(trainModel(V2_CONFIG, bTrain).model, bs) }, "generator A now")}`;
  writeFileSync(evaluationPath, md);
  console.log(`Evaluated ${v1.modelVersion} against ${v2.modelVersion} in ${((performance.now() - started) / 1000).toFixed(1)}s: ${passed ? "v2 passes" : "v2 does not pass"}. Wrote ${evaluationPath}`);
}
