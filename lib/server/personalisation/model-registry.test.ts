import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite";
import { bootstrapModel, bundledArtifactSha256, clearModelCache, createModelLoader, loadActiveModel } from "./model-registry";
import { activateModel, getActiveModelRecord, getModelRecord, listModels, registerModel } from "./pipeline-store";
import { fakeBundled, fakeModel, fakeValidate, T0, testDb, type FakeModel } from "./test-helpers";

const dirs: string[] = [];
let logs: string[] = [];
const log = (m: string) => logs.push(m);

beforeEach(() => {
  clearModelCache();
  logs = [];
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes a model artifact to a temp file and registers it as a candidate. */
function artifact(db: ReturnType<typeof testDb>, model: FakeModel, opts: { sha?: string; content?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cfe-model-"));
  dirs.push(dir);
  const file = join(dir, `${model.version}.json`);
  const content = opts.content ?? JSON.stringify(model);
  writeFileSync(file, content);
  registerModel(db, {
    version: model.version,
    datasetVersion: model.datasetVersion,
    algorithm: model.algorithm,
    trainedOn: "synthetic+real",
    config: {},
    metrics: {},
    artifactPath: file,
    artifactSha256: opts.sha ?? createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    createdAt: T0,
  });
  return file;
}

describe("bootstrapModel", () => {
  it("registers and activates the bundled model when nothing is active", () => {
    const db = openDatabase(":memory:");
    const bundled = fakeBundled();
    expect(bootstrapModel(db, bundled, T0)).toEqual({ activated: true });
    expect(getActiveModelRecord(db)).toMatchObject({
      version: bundled.model.version,
      artifactPath: null,
      artifactSha256: bundledArtifactSha256(bundled.model),
      trainedOn: "synthetic",
      metrics: bundled.metrics,
    });
    expect(bootstrapModel(db, bundled, T0 + 1)).toEqual({ activated: false });
    expect(listModels(db)).toHaveLength(1);
  });

  it("leaves a trained model alone when it is active", () => {
    const db = testDb();
    const trained = fakeModel("trained-2");
    artifact(db, trained);
    activateModel(db, trained.version, T0 + 1);
    expect(bootstrapModel(db, fakeBundled(), T0 + 2)).toEqual({ activated: false });
    expect(getActiveModelRecord(db)?.version).toBe("trained-2");
  });

  it("replaces an older bundled model with the one shipped now", () => {
    const db = testDb();
    const next = fakeBundled(fakeModel("fake-1.1.0+syn.s2", "syn-fake-2"));
    expect(bootstrapModel(db, next, T0 + 1)).toEqual({ activated: true });
    expect(getActiveModelRecord(db)).toMatchObject({ version: "fake-1.1.0+syn.s2", rollbackTo: fakeModel().version });
  });

  it("refuses a bundled model whose dataset doesn't match", () => {
    const db = openDatabase(":memory:");
    expect(() => bootstrapModel(db, { ...fakeBundled(), dataset: { ...fakeBundled().dataset, version: "other" } }, T0)).toThrow(/names dataset/);
  });
});

describe("loadActiveModel", () => {
  const options = { bundled: fakeBundled(), validate: fakeValidate, log };

  it("serves the bundled model when it is active and its hash matches", () => {
    const loaded = loadActiveModel(testDb(), options);
    expect(loaded).toMatchObject({ fallback: false, record: { version: fakeModel().version } });
    expect(loaded?.model).toEqual(fakeModel());
  });

  it("loads a registered artifact file after checking its hash, and caches it by version", () => {
    const db = testDb();
    const trained = fakeModel("trained-2");
    const file = artifact(db, trained);
    activateModel(db, trained.version, T0 + 1);
    const first = loadActiveModel(db, options);
    expect(first).toMatchObject({ fallback: false, model: trained, record: { version: "trained-2", trainedOn: "synthetic+real" } });
    unlinkSync(file);
    expect(loadActiveModel(db, options)?.model).toBe(first?.model);
    expect(logs).toEqual([]);
  });

  it("falls back to the bundled model, logging once, when the hash doesn't match", () => {
    const db = testDb();
    const trained = fakeModel("trained-2");
    artifact(db, trained, { sha: "0".repeat(64) });
    activateModel(db, trained.version, T0 + 1);
    const loaded = loadActiveModel(db, options);
    expect(loaded).toMatchObject({ fallback: true, record: { version: fakeModel().version } });
    expect(loaded?.model).toEqual(fakeModel());
    loadActiveModel(db, options);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/trained-2 can't be used \(the artifact's hash doesn't match/);
  });

  it("falls back when the artifact fails validation, is missing, or claims another version", () => {
    for (const [name, setup] of [
      ["invalid", (db: ReturnType<typeof testDb>) => artifact(db, { ...fakeModel("m-invalid"), body: { weights: "nope" } } as unknown as FakeModel)],
      [
        "missing",
        (db: ReturnType<typeof testDb>) => {
          unlinkSync(artifact(db, fakeModel("m-missing")));
        },
      ],
      ["other version", (db: ReturnType<typeof testDb>) => artifact(db, fakeModel("m-other"), { content: JSON.stringify(fakeModel("somebody-else")) })],
    ] as const) {
      const db = testDb();
      setup(db);
      const version = name === "invalid" ? "m-invalid" : name === "missing" ? "m-missing" : "m-other";
      activateModel(db, version, T0 + 1);
      expect({ name, loaded: loadActiveModel(db, options) }).toMatchObject({ name, loaded: { fallback: true } });
    }
    expect(logs).toHaveLength(3);
  });

  it("falls back when the bundled record's hash no longer matches the shipped model", () => {
    const db = testDb();
    db.prepare("UPDATE model_versions SET artifact_sha256 = ? WHERE status = 'active'").run("1".repeat(64));
    expect(loadActiveModel(db, options)).toMatchObject({ fallback: true });
  });

  it("returns null when even the bundled model is unusable", () => {
    const db = testDb();
    const broken = { ...fakeBundled(), model: { ...fakeModel(), body: null } as unknown as FakeModel };
    expect(loadActiveModel(db, { bundled: broken, validate: fakeValidate, log })).toBeNull();
    expect(loadActiveModel(openDatabase(":memory:"), options)).toBeNull(); // nothing registered at all
  });
});

describe("createModelLoader", () => {
  it("bootstraps a fresh database on first use", () => {
    const db = openDatabase(":memory:");
    const load = createModelLoader({ bundled: fakeBundled(), validate: fakeValidate, log, now: () => T0 });
    expect(load(db)).toMatchObject({ fallback: false, record: { version: fakeModel().version, activatedAt: T0 } });
    expect(getModelRecord(db, fakeModel().version)?.status).toBe("active");
  });
});
