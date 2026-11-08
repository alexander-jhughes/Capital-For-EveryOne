// Benchmark harness: evaluates pluggable scorers and policies on held-out SYNTHETIC people.
//
// (a) oracle, full information: on each held-out person's evaluation snapshot, every eligible item is ranked and judged
//     against the person's hidden truth (relevant = keep probability > 0.5 and true benefit > 0; NDCG gain = max(0, benefit)).
// (b) logged feedback: AUC, rejection AUC and calibration on the held-out people's logged exposures, i.e. only what the
//     biased logging policy happened to show (the realistic, partial view).
// (c) cold-start strata and (d) groups, including age band for fairness only (age is read from the synthetic person,
//     never from the input, and never passed to a model).
// (e) end-to-end policy: what each system would actually offer, judged by the hidden truth.
// (f) latency and artifact size.
// Every number is about the synthetic world we wrote: it shows the pipeline works, not that anything helps real people.
import { isCompatible, ITEM_IDS, type ItemId } from "../catalog";
import { answeredCount, type ProfileAnswers } from "../profile";
import { eligibleItems, keepLogit, loggedFor, oracleTruth, PARAMS, type SyntheticPerson, trueUtility, type World } from "../synthetic";
import { sigmoid } from "../random";
import type { RecommenderInput } from "../types";
import {
  auc,
  calibration,
  type Calibration,
  catalogueCoverage,
  type Disparity,
  disparity,
  falseRecommendationRate,
  groupMeans,
  keptVsBenefit,
  mean,
  ndcgAtK,
  percentiles,
  precisionAtK,
  recallAtK,
  rejectionAuc,
  userCoverage,
} from "./metrics";

/** Same shape as the engine's `Scorer` (CONTRACT.md §7): probabilities per item, any subset of items. */
export type Scorer = (input: RecommenderInput) => Partial<Record<ItemId, number>>;
/** What a system would actually offer this person now: a configuration of items, or nothing. */
export type Policy = (input: RecommenderInput, now: number) => ItemId[] | null;

export interface Contender {
  name: string;
  description?: string;
  scorer: Scorer;
  policy?: Policy;
  /** Artifact size in bytes, if the system has a stored artifact. */
  bytes?: number | null;
}

export interface BenchmarkOptions {
  ks?: number[];
  /** Groups smaller than this are reported but left out of disparity ratios. */
  minGroupSize?: number;
  /** Number of inputs timed per contender. */
  latencySamples?: number;
}

export const DEFAULT_KS = [1, 3, 5];
/** The headline K: suggestions hold up to 4 items and usually 1-3. */
export const HEADLINE_K = 3;

export type MetricRecord = Record<string, number | null>;

export interface LoggedMetrics {
  /** Logged exposures scored. */
  n: number;
  /** Share of logged exposures the contender gave a score for (v1 only knows 8 items). */
  scoredShare: number;
  auc: number | null;
  rejectionAuc: number | null;
  calibration: Calibration;
  aucWarm: number | null;
  aucCold: number | null;
  /** Expected label rate of the logged items vs. mean predicted probability (overall bias). */
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface PolicyMetrics {
  people: number;
  /** Share of people offered anything. */
  suggestionRate: number;
  meanConfigurationSize: number | null;
  offeredItems: number;
  /** Offered items whose true benefit is ≤ 0. */
  falseRecRate: number | null;
  /** Mean true benefit of offered items. */
  benefit: number | null;
  expectedKeptRate: number | null;
  harmfulShareOfKept: number | null;
  /** Mean over ALL people of Σ_offered P(keep)·benefit: value delivered per person (0 when nothing is offered). */
  netBenefitPerPerson: number;
  catalogueCoverage: number;
  /** Fatigue: suggestion rate for people who turned down ≥ 2 items before, and for everyone else. */
  suggestionRateRepeatRejecters: number | null;
  suggestionRateOthers: number | null;
  /** Must be 0: offers of ineligible items or incompatible configurations. */
  policyViolations: number;
}

export interface ContenderResult {
  name: string;
  description: string;
  oracle: {
    overall: MetricRecord;
    strata: Record<string, MetricRecord>;
    groups: Record<string, MetricRecord>;
    /** Per group family (view, voice, ... age), worst over best NDCG@3. */
    disparity: Record<string, Disparity | null>;
    /** Lowest family ratio (the fairness gate reads this). */
    minDisparityRatio: number | null;
  };
  logged: LoggedMetrics;
  policy: PolicyMetrics | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; mean: number | null; policyP95: number | null };
  bytes: number | null;
}

export interface BenchmarkResult {
  people: number;
  loggedExamples: number;
  ks: number[];
  minGroupSize: number;
  /** People per stratum and group. */
  sizes: Record<string, number>;
  contenders: ContenderResult[];
}

// ---------------------------------------------------------------------------------------------------------------
// Ranking and groups
// ---------------------------------------------------------------------------------------------------------------

const finite = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? v : -Infinity);

/** Candidates by score, best first. Unscored items go last; ties keep candidate (catalogue) order. */
export function rankItems(scores: Partial<Record<ItemId, number>>, candidates: readonly ItemId[]): ItemId[] {
  return candidates
    .map((id, i) => ({ id, s: finite(scores[id]), i }))
    .sort((a, b) => (a.s === b.s ? a.i - b.i : a.s > b.s ? -1 : 1))
    .map((x) => x.id);
}

/** "Everything at once" with "just the key facts", and the reverse: answers that point in opposite directions. */
export function hasConflictingAnswers(a: ProfileAnswers): boolean {
  return (a.screenComplexity === "everything" && a.detailLevel === "keyFacts") || (a.screenComplexity === "minimal" && a.detailLevel === "everything");
}

export function usesAccessibilitySettings(input: RecommenderInput): boolean {
  const p = input.preferences;
  return p.textSize >= 125 || p.contrast === "high" || p.motion === "reduced" || p.targets === "large" || p.spacing === "roomy" || input.answers.screenReader === "yes";
}

export function stratumOf(input: RecommenderInput): string {
  if (input.history.length > 0) return "warm (has history)";
  const n = answeredCount(input.answers);
  return n === 0 ? "cold: 0 answers" : n <= 4 ? "cold: 1-4 answers" : "cold: 5+ answers";
}

export const STRATA = ["cold: 0 answers", "cold: 1-4 answers", "cold: 5+ answers", "warm (has history)"] as const;

/**
 * Groups for evaluation, as "family: value". Age band comes from the synthetic person's research data and is used
 * here ONLY to measure; it is never part of the input a model sees.
 */
export function groupsOf(person: Pick<SyntheticPerson, "research">, input: RecommenderInput): string[] {
  const yn = (b: boolean) => (b ? "yes" : "no");
  const rejectedItems = input.history.filter((h) => h.outcome === "rejected").length;
  return [
    `view: ${input.view === "simple" ? "Simple" : "Detailed"}`,
    `voice-first: ${yn(input.answers.inputMode === "voice" || input.preferences.voiceFirst)}`,
    `accessibility settings or screen reader: ${yn(usesAccessibilitySettings(input))}`,
    `new to credit: ${yn(input.answers.creditFamiliarity === "new")}`,
    `repeat rejecter: ${yn(rejectedItems >= 2)}`,
    `undid a suggestion: ${yn(input.history.some((h) => h.outcome === "reverted"))}`,
    `conflicting answers: ${yn(hasConflictingAnswers(input.answers))}`,
    `age band (fairness only): ${person.research.ageBand}`,
  ];
}

export const familyOf = (group: string) => group.slice(0, group.indexOf(":"));

// ---------------------------------------------------------------------------------------------------------------
// Oracle (full information)
// ---------------------------------------------------------------------------------------------------------------

function personOracle(person: SyntheticPerson, input: RecommenderInput, scorer: Scorer, ks: number[]): { metrics: MetricRecord; top: ItemId[] } {
  const truth = oracleTruth(person, input);
  const byItem = new Map(truth.map((t) => [t.item, t]));
  const ranked = rankItems(scorer(input), truth.map((t) => t.item));
  const relevant = new Set(truth.filter((t) => t.relevant).map((t) => t.item));
  const gains = new Map(truth.map((t) => [t.item as string, t.gain]));
  const m: MetricRecord = { candidates: truth.length, relevant: relevant.size };
  for (const k of ks) {
    const top = ranked.slice(0, k).map((id) => byItem.get(id)!);
    m[`precision@${k}`] = precisionAtK(ranked, relevant, k);
    m[`recall@${k}`] = recallAtK(ranked, relevant, k);
    m[`ndcg@${k}`] = ndcgAtK(ranked, gains, k);
    m[`falseRec@${k}`] = falseRecommendationRate(top.map((t) => t.utility));
    m[`benefit@${k}`] = mean(top.map((t) => t.utility));
    const kb = keptVsBenefit(top);
    m[`expectedKept@${k}`] = kb.expectedKeptRate;
    m[`harmfulShareOfKept@${k}`] = kb.harmfulShareOfKept;
  }
  return { metrics: m, top: ranked.slice(0, HEADLINE_K) };
}

function averageRecords(records: readonly MetricRecord[]): MetricRecord {
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) keys.add(k);
  const out: MetricRecord = { people: records.length };
  for (const k of keys) out[k] = mean(records.map((r) => r[k]));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Logged feedback
// ---------------------------------------------------------------------------------------------------------------

function loggedMetrics(world: World, people: readonly number[], scorer: Scorer): LoggedMetrics {
  const logged = loggedFor(world, people);
  const y: number[] = [];
  const p: number[] = [];
  const rej: number[] = [];
  const warm: [number[], number[]] = [[], []];
  const cold: [number[], number[]] = [[], []];
  for (const l of logged) {
    const v = scorer(l.example.input)[l.example.item];
    if (v === undefined || !Number.isFinite(v)) continue;
    const q = Math.min(1, Math.max(0, v));
    y.push(l.example.label);
    p.push(q);
    rej.push(l.outcome === "rejected" ? 1 : 0);
    const bucket = l.example.input.history.length > 0 ? warm : cold;
    bucket[0].push(l.example.label);
    bucket[1].push(q);
  }
  return {
    n: y.length,
    scoredShare: logged.length ? y.length / logged.length : 0,
    auc: auc(y, p),
    rejectionAuc: rejectionAuc(rej, p),
    calibration: calibration(y, p),
    aucWarm: auc(warm[0], warm[1]),
    aucCold: auc(cold[0], cold[1]),
    meanPredicted: mean(p),
    observedRate: mean(y),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// End-to-end policy
// ---------------------------------------------------------------------------------------------------------------

function policyMetrics(world: World, people: readonly number[], policy: Policy): PolicyMetrics {
  const lists: ItemId[][] = [];
  const rows: { keepProbability: number; utility: number }[] = [];
  let violations = 0;
  let net = 0;
  const fatigue = { rr: [0, 0], others: [0, 0] };
  for (const i of people) {
    const person = world.people[i];
    const { input, now } = person.evaluation;
    const offered = policy(input, now) ?? [];
    lists.push(offered);
    const eligible = new Set(eligibleItems(input));
    if (offered.some((id) => !eligible.has(id)) || !isCompatible(offered)) violations++;
    offered.forEach((id, position) => {
      const utility = trueUtility(person, id, input);
      const keepProbability = sigmoid(keepLogit(utility, input, position));
      rows.push({ keepProbability, utility });
      net += keepProbability * utility;
    });
    const f = input.history.filter((h) => h.outcome === "rejected").length >= 2 ? fatigue.rr : fatigue.others;
    f[0]++;
    if (offered.length) f[1]++;
  }
  const nonEmpty = lists.filter((l) => l.length > 0);
  const kb = keptVsBenefit(rows);
  return {
    people: people.length,
    suggestionRate: userCoverage(lists),
    meanConfigurationSize: nonEmpty.length ? mean(nonEmpty.map((l) => l.length)) : null,
    offeredItems: rows.length,
    falseRecRate: falseRecommendationRate(rows.map((r) => r.utility)),
    benefit: kb.meanBenefit,
    expectedKeptRate: kb.expectedKeptRate,
    harmfulShareOfKept: kb.harmfulShareOfKept,
    netBenefitPerPerson: people.length ? net / people.length : 0,
    catalogueCoverage: catalogueCoverage(lists, ITEM_IDS.length),
    suggestionRateRepeatRejecters: fatigue.rr[0] ? fatigue.rr[1] / fatigue.rr[0] : null,
    suggestionRateOthers: fatigue.others[0] ? fatigue.others[1] / fatigue.others[0] : null,
    policyViolations: violations,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------------------------------------------

/** Times calls on fresh copies of the inputs, so per-input caches cannot flatter the numbers. */
function timeCalls(inputs: readonly RecommenderInput[], call: (input: RecommenderInput) => unknown): number[] {
  const copies = inputs.map((x) => structuredClone(x));
  for (const c of copies.slice(0, 5)) call(structuredClone(c)); // warm-up (JIT), not timed
  return copies.map((c) => {
    const t0 = performance.now();
    call(c);
    return performance.now() - t0;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------

export function evaluateContender(world: World, people: readonly number[], c: Contender, options: BenchmarkOptions = {}): ContenderResult {
  const ks = options.ks ?? DEFAULT_KS;
  const minGroupSize = options.minGroupSize ?? 50;
  const perPerson: { record: MetricRecord; stratum: string; groups: string[] }[] = [];
  const tops: ItemId[][] = [];
  for (const i of people) {
    const person = world.people[i];
    const input = person.evaluation.input;
    const { metrics, top } = personOracle(person, input, c.scorer, ks);
    perPerson.push({ record: metrics, stratum: stratumOf(input), groups: groupsOf(person, input) });
    tops.push(top);
  }
  const overall = averageRecords(perPerson.map((p) => p.record));
  overall[`catalogueCoverage@${HEADLINE_K}`] = catalogueCoverage(tops, ITEM_IDS.length);
  const byKey = (key: (p: (typeof perPerson)[number]) => string[]) => {
    const buckets = new Map<string, MetricRecord[]>();
    for (const p of perPerson)
      for (const g of key(p)) {
        const list = buckets.get(g);
        if (list) list.push(p.record);
        else buckets.set(g, [p.record]);
      }
    return Object.fromEntries([...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, rs]) => [g, averageRecords(rs)]));
  };
  const strata = byKey((p) => [p.stratum]);
  const groups = byKey((p) => p.groups);

  const ndcgKey = `ndcg@${HEADLINE_K}`;
  const families = [...new Set(Object.keys(groups).map(familyOf))];
  const disp: Record<string, Disparity | null> = {};
  for (const f of families) {
    const values = groupMeans(perPerson.filter((p) => p.groups.some((g) => familyOf(g) === f)).map((p) => ({ groups: p.groups.filter((g) => familyOf(g) === f), value: p.record[ndcgKey] })));
    disp[f] = disparity(values, minGroupSize);
  }
  const ratios = Object.values(disp)
    .filter((d): d is Disparity => d !== null)
    .map((d) => d.ratio);

  const sampleInputs = people.slice(0, options.latencySamples ?? 300).map((i) => world.people[i].evaluation.input);
  const lat = timeCalls(sampleInputs, c.scorer);
  const pct = percentiles(lat, [50, 95, 99]);
  const policyLat = c.policy ? percentiles(timeCalls(sampleInputs, (x) => c.policy!(x, Date.UTC(2027, 0, 1))), [95]).p95 : null;

  return {
    name: c.name,
    description: c.description ?? "",
    oracle: { overall, strata, groups, disparity: disp, minDisparityRatio: ratios.length ? Math.min(...ratios) : null },
    logged: loggedMetrics(world, people, c.scorer),
    policy: c.policy ? policyMetrics(world, people, c.policy) : null,
    latencyMs: { p50: pct.p50, p95: pct.p95, p99: pct.p99, mean: mean(lat), policyP95: policyLat },
    bytes: c.bytes ?? null,
  };
}

export function runBenchmark(world: World, people: readonly number[], contenders: readonly Contender[], options: BenchmarkOptions = {}): BenchmarkResult {
  const sizes: Record<string, number> = {};
  for (const i of people) {
    const p = world.people[i];
    for (const g of [stratumOf(p.evaluation.input), ...groupsOf(p, p.evaluation.input)]) sizes[g] = (sizes[g] ?? 0) + 1;
  }
  return {
    people: people.length,
    loggedExamples: loggedFor(world, people).length,
    ks: options.ks ?? DEFAULT_KS,
    minGroupSize: options.minGroupSize ?? 50,
    sizes: Object.fromEntries(Object.entries(sizes).sort((a, b) => a[0].localeCompare(b[0]))),
    contenders: contenders.map((c) => evaluateContender(world, people, c, options)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Logging-bias diagnostics (also used for the monitoring baseline)
// ---------------------------------------------------------------------------------------------------------------

/** Label rate by position in the shown configuration and by item, on logged data (feedback-bias monitoring baseline). */
export function acceptanceProfile(world: World, people: readonly number[]): { byPosition: Record<string, { n: number; rate: number }>; byItem: Record<string, { n: number; rate: number }> } {
  const pos = new Map<string, [number, number]>();
  const item = new Map<string, [number, number]>();
  for (const l of loggedFor(world, people)) {
    for (const [m, k] of [
      [pos, String(l.position)],
      [item, l.example.item],
    ] as const) {
      const c = m.get(k) ?? [0, 0];
      c[0]++;
      c[1] += l.example.label;
      m.set(k, c);
    }
  }
  const out = (m: Map<string, [number, number]>) => Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, [n, s]]) => [k, { n, rate: s / n }]));
  return { byPosition: out(pos), byItem: out(item) };
}


/**
 * REFERENCE CEILING, NOT A MODEL: scores with the hidden truth (expected P(keep and not undone)). Only possible in a
 * synthetic world. Shows how much room is left; it can never be deployed.
 */
export function oracleScorer(world: World): Scorer {
  const owner = new WeakMap<RecommenderInput, SyntheticPerson>();
  for (const p of world.people) owner.set(p.evaluation.input, p);
  for (const l of world.logged) owner.set(l.example.input, world.people[l.person]);
  return (input) => {
    const person = owner.get(input);
    if (!person) return {};
    const out: Partial<Record<ItemId, number>> = {};
    for (const id of ITEM_IDS) {
      const u = trueUtility(person, id, input);
      out[id] = sigmoid(keepLogit(u, input)) * (1 - sigmoid(PARAMS.revert.slope * u + PARAMS.revert.bias));
    }
    return out;
  };
}
