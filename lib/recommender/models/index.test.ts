// The bundled model, dataset and metrics must be exactly what the backend's model registry accepts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bootstrapModel, bundledArtifactSha256, clearModelCache, loadActiveModel } from "../../server/personalisation/model-registry";
import { getActiveModelRecord, openDatabase } from "../../server/personalisation/pipeline-store";
import { isValidRecommenderModel, recommend } from "../engine/index";
import { AGE_BANDS } from "../profile";
import { DEFAULT_PREFS } from "../../preferences/schema";
import { BUNDLED_DATASET, BUNDLED_METRICS, BUNDLED_MODEL } from "./index";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./manifest.json", import.meta.url)), "utf8")) as { version: string; file: string };

describe("bundled model", () => {
  it("is a valid, synthetic-only engine artifact whose dataset matches", () => {
    expect(isValidRecommenderModel(BUNDLED_MODEL)).toBe(true);
    expect(BUNDLED_MODEL.trainedOn).toBe("synthetic");
    expect(BUNDLED_MODEL.version).toBe(manifest.version);
    expect(BUNDLED_MODEL.datasetVersion).toBe(BUNDLED_DATASET.version);
  });

  it("has DatasetMetadata the registry accepts: 64-hex hash, integer counts, epoch-ms createdAt, no real records", () => {
    expect(BUNDLED_DATASET.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const n of [BUNDLED_DATASET.eligibleRecords, BUNDLED_DATASET.eligibleSubjects, BUNDLED_DATASET.syntheticRecords]) expect(Number.isInteger(n) && n >= 0).toBe(true);
    expect(BUNDLED_DATASET.eligibleRecords).toBe(0);
    expect(BUNDLED_DATASET.eligibleSubjects).toBe(0);
    expect(BUNDLED_DATASET.sourcePeriod).toEqual({ from: null, to: null });
    expect(Number.isInteger(BUNDLED_DATASET.createdAt) && BUNDLED_DATASET.createdAt > Date.UTC(2026, 0, 1)).toBe(true);
  });

  it("carries headline metrics, passed gates, the synthetic disclaimer and a monitoring reference", () => {
    const m = BUNDLED_METRICS as { synthetic: boolean; disclaimer: string; gates: { passed: boolean }; monitoringReference: { inputs: { snapshots: number } } };
    expect(m.synthetic).toBe(true);
    expect(m.disclaimer).toMatch(/SYNTHETIC/);
    expect(m.disclaimer).toMatch(/NOT show that any model helps real people/);
    expect(m.gates.passed).toBe(true);
    expect(m.monitoringReference.inputs.snapshots).toBeGreaterThan(1000);
  });

  it("contains no research data", () => {
    const json = JSON.stringify(BUNDLED_MODEL);
    expect(json).not.toMatch(/"(ageBand|age|research)":/);
    for (const b of AGE_BANDS) expect(json).not.toContain(`"${b}"`);
  });

  it("is accepted by bootstrapModel on an in-memory database and then served", () => {
    clearModelCache();
    const db = openDatabase(":memory:");
    try {
      const bundled = { model: BUNDLED_MODEL, dataset: BUNDLED_DATASET, metrics: BUNDLED_METRICS };
      expect(bootstrapModel(db, bundled, Date.UTC(2026, 10, 8))).toEqual({ activated: true });
      const active = getActiveModelRecord(db)!;
      expect(active.version).toBe(BUNDLED_MODEL.version);
      expect(active.artifactPath).toBeNull();
      expect(active.artifactSha256).toBe(bundledArtifactSha256(BUNDLED_MODEL));
      expect(bootstrapModel(db, bundled)).toEqual({ activated: false }); // idempotent
      const loaded = loadActiveModel(db, { bundled, validate: isValidRecommenderModel, log: () => {} });
      expect(loaded?.fallback).toBe(false);
      expect(loaded?.model.version).toBe(BUNDLED_MODEL.version);
      const r = recommend(loaded!.model, { answers: {}, preferences: DEFAULT_PREFS, view: "complex", explicit: [], signals: {}, history: [] }, { now: Date.UTC(2026, 10, 8) });
      expect(r.modelVersion).toBe(BUNDLED_MODEL.version);
    } finally {
      db.close();
    }
  });
});
