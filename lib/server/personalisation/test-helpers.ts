// Fixtures for the lib/server tests: a fake model, a fake engine and an in-memory database.
// The real engine and bundled model are injected in production (app-deps.ts), so no test needs them.
import { CATALOG, configurationActions, isActive, ITEM_IDS, type ItemId } from "../../recommender/catalog";
import type { Configuration, ItemScore, ModelHeader, RecommendationResult, RecommenderInput } from "../../recommender/types";
import { DEFAULT_PREFS, type Preferences } from "../../preferences/schema";
import { openDatabase, type Database } from "../db/sqlite";
import { bootstrapModel, type BundledModel } from "./model-registry";
import type { DatasetMetadata } from "./pipeline-store";

/** 2026-11-08 12:00 UTC. */
export const T0 = Date.UTC(2026, 10, 8, 12);
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export interface FakeModel extends ModelHeader {
  body: { weights: number[] };
}

export const fakeModel = (version = "fake-1.0.0+syn.s1", datasetVersion = "syn-fake-1"): FakeModel => ({
  format: "cfe-recommender",
  formatVersion: 1,
  version,
  algorithm: "fake-hybrid",
  trainedOn: "synthetic",
  datasetVersion,
  featureIds: ["f0", "f1"],
  items: [...ITEM_IDS],
  body: { weights: [0.5, -0.25] },
});

export const fakeValidate = (x: unknown): boolean => {
  const m = x as FakeModel | null;
  return typeof m === "object" && m !== null && m.format === "cfe-recommender" && m.formatVersion === 1 && Array.isArray(m.body?.weights);
};

export const fakeDataset = (version = "syn-fake-1", createdAt = T0 - 30 * DAY): DatasetMetadata => ({
  version,
  sourcePeriod: { from: null, to: null },
  eligibleRecords: 0,
  eligibleSubjects: 0,
  syntheticRecords: 5000,
  excluded: {},
  criteria: { synthetic: true, seed: 1 },
  preprocessingVersion: "features-1",
  contentSha256: "a".repeat(64),
  createdAt,
});

export const fakeBundled = (model: FakeModel = fakeModel()): BundledModel<FakeModel> => ({
  model,
  dataset: fakeDataset(model.datasetVersion),
  metrics: { auc: 0.71, synthetic: true },
});

/** Order in which the fake engine suggests things. */
const ORDER: ItemId[] = ["textSize.125", "contrast.high", "spacing.roomy", "motion.reduced", "targets.large"];

const configuration = (items: ItemId[], confidence = 0.7): Configuration => ({
  items,
  ...configurationActions(items),
  title: items.map((i) => CATALOG[i].title).join(" and "),
  offer: `Would you like ${items.map((i) => CATALOG[i].title.toLowerCase()).join(" and ")}?`,
  confidence,
  evidence: "moderate",
});

/** A deterministic stand-in for the engine: suggests the first two eligible items, offers the third as an alternative. */
export function fakeRecommend(model: FakeModel, input: RecommenderInput): RecommendationResult {
  const blocked = new Set(input.history.filter((h) => h.outcome !== "accepted").map((h) => h.item));
  const eligible = ORDER.filter((i) => !isActive(i, input.preferences, input.view) && !input.explicit.includes(CATALOG[i].dimension) && !blocked.has(i));
  const scores: ItemScore[] = [...eligible, ...ITEM_IDS.filter((i) => !eligible.includes(i))].map((item, rank) => ({
    item,
    probability: Math.max(0.05, 0.9 - rank * 0.05),
    evidence: "moderate",
    support: 12,
    components: { content: 0.5, collaborative: 0.5, factorization: 0.5, prior: 0.5 },
    reasons: [],
  }));
  const base = { modelVersion: model.version, trainedOn: model.trainedOn, scores, withheld: [], warnings: [{ code: "synthetic_only" as const, text: "Trained on simulated people only." }] };
  if (eligible.length === 0)
    return { ...base, status: "no_recommendation", configuration: null, alternatives: [], explanation: { summary: "Nothing to suggest.", reasons: [] } };
  return {
    ...base,
    status: "ok",
    configuration: configuration(eligible.slice(0, 2)),
    alternatives: eligible.length > 2 ? [configuration(eligible.slice(2, 3), 0.6)] : [],
    explanation: { summary: "People with similar answers kept these.", reasons: ["You said: Just the key facts"] },
  };
}

/** A migrated in-memory database with the fake bundled model registered and active. */
export function testDb(now = T0, bundled: BundledModel<FakeModel> = fakeBundled()): Database {
  const db = openDatabase(":memory:", { now });
  bootstrapModel(db, bundled, now);
  return db;
}

export const prefs = (over: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFS, ...over, layout: { ...DEFAULT_PREFS.layout, ...over.layout } });

/** Every row in every personal table for one subject id, by table. */
export function rowsFor(db: Database, subjectId: string): Record<string, number> {
  const tables = ["user_profiles", "user_research", "user_preferences", "interaction_signals", "recommendations", "recommendation_feedback", "consent_events"];
  const out: Record<string, number> = {
    subjects: (db.prepare("SELECT COUNT(*) AS n FROM subjects WHERE id = ?").get(subjectId) as { n: number }).n,
  };
  for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE subject_id = ?`).get(subjectId) as { n: number }).n;
  return out;
}
