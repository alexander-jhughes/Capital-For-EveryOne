// Promotion gates. A candidate model is registered with its gate results; promote.ts refuses a model that failed any.
// Gates are evaluated on the held-out TEST people once, after the model was chosen on validation. They never feed back
// into training or model choice: a failing gate means "do not deploy", not "tune until it passes".
import type { ContenderResult } from "./benchmark";

export interface Budgets {
  /** Largest acceptable artifact (JSON bytes). The model runs in the server process, so this is about memory and load time. */
  maxArtifactBytes: number;
  /** p95 latency of one recommend() call (or one scoring call if there is no policy), milliseconds. */
  maxLatencyP95Ms: number;
  /** Expected calibration error on held-out logged feedback. */
  maxEce: number;
  /** Worst-group over best-group oracle NDCG@3, within every group family. */
  minDisparityRatio: number;
  /** False-recommendation rate may exceed the active model's by at most this much. */
  falseRecTolerance: number;
}

export const DEFAULT_BUDGETS: Budgets = { maxArtifactBytes: 2_000_000, maxLatencyP95Ms: 10, maxEce: 0.05, minDisparityRatio: 0.8, falseRecTolerance: 0.01 };

export interface Gate {
  id: string;
  description: string;
  value: number | null;
  threshold: number | null;
  passed: boolean;
  note?: string;
}

export interface GateInput {
  candidate: ContenderResult;
  popularity: ContenderResult;
  v1: ContenderResult;
  /** The currently active model evaluated on the same people, or null when there is none. */
  active: ContenderResult | null;
  /** Why there is no active model to compare with (default: none exists yet). */
  noActiveNote?: string;
  artifactBytes: number;
}

const NDCG = "ndcg@3";

/** False-recommendation rate of what a system actually offers, else of its top 3. */
function falseRec(r: ContenderResult): number | null {
  if (r.policy) return r.policy.falseRecRate;
  return r.oracle.overall["falseRec@3"] ?? null;
}

export function evaluateGates(g: GateInput, budgets: Budgets = DEFAULT_BUDGETS): { passed: boolean; gates: Gate[] } {
  const c = g.candidate;
  const ndcg = (r: ContenderResult) => r.oracle.overall[NDCG] ?? null;
  const gates: Gate[] = [];
  const cmpGreater = (id: string, description: string, ref: ContenderResult) => {
    const v = ndcg(c);
    const t = ndcg(ref);
    gates.push({ id, description, value: v, threshold: t, passed: v !== null && t !== null && v > t });
  };
  cmpGreater("beats_popularity", "Oracle NDCG@3 higher than the popularity baseline", g.popularity);
  cmpGreater("beats_v1", "Oracle NDCG@3 higher than the v1 random forest", g.v1);

  const fr = falseRec(c);
  if (g.active) {
    const ref = falseRec(g.active);
    const limit = ref === null ? null : ref + budgets.falseRecTolerance;
    gates.push({
      id: "false_rec_vs_active",
      description: `False-recommendation rate not worse than the active model's + ${budgets.falseRecTolerance}`,
      value: fr,
      threshold: limit,
      passed: fr === null || limit === null || fr <= limit,
      note: `active model: ${g.active.name}`,
    });
  } else {
    gates.push({
      id: "false_rec_vs_active",
      description: `False-recommendation rate not worse than the active model's + ${budgets.falseRecTolerance}`,
      value: fr,
      threshold: null,
      passed: true,
      note: g.noActiveNote ?? "no active model to compare against (first model): reported, not gated",
    });
  }

  const e = c.logged.calibration.n > 0 ? c.logged.calibration.ece : null;
  gates.push({ id: "calibration", description: `ECE (10 bins) on held-out logged feedback ≤ ${budgets.maxEce}`, value: e, threshold: budgets.maxEce, passed: e !== null && e <= budgets.maxEce });

  const d = c.oracle.minDisparityRatio;
  const worst = Object.entries(c.oracle.disparity)
    .filter(([, v]) => v !== null)
    .sort((a, b) => a[1]!.ratio - b[1]!.ratio)[0];
  gates.push({
    id: "fairness",
    description: `Worst-group / best-group oracle NDCG@3 ≥ ${budgets.minDisparityRatio} in every group family (incl. age band, fairness only)`,
    value: d,
    threshold: budgets.minDisparityRatio,
    passed: d !== null && d >= budgets.minDisparityRatio,
    note: worst ? `lowest: ${worst[0]} (${worst[1]!.worst} vs ${worst[1]!.best})` : undefined,
  });

  gates.push({ id: "size", description: `Artifact ≤ ${budgets.maxArtifactBytes} bytes`, value: g.artifactBytes, threshold: budgets.maxArtifactBytes, passed: g.artifactBytes <= budgets.maxArtifactBytes });

  const lat = c.latencyMs.policyP95 ?? c.latencyMs.p95;
  gates.push({
    id: "latency",
    description: `p95 latency ≤ ${budgets.maxLatencyP95Ms} ms per ${c.latencyMs.policyP95 !== null ? "recommend()" : "scoring"} call`,
    value: lat,
    threshold: budgets.maxLatencyP95Ms,
    passed: lat !== null && lat <= budgets.maxLatencyP95Ms,
  });
  return { passed: gates.every((x) => x.passed), gates };
}
