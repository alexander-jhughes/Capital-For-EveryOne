// Which model serves suggestions, and loading it safely.
//
// The bundled synthetic model ships inside the app (a static import, no fs). Models trained later are JSON files
// registered in model_versions with a sha256. Loading checks the hash and the engine's own validation; if anything
// is wrong the bundled model is used instead (logged once), so a bad artifact can never take suggestions down.
//
// The engine and the bundled model are injected (`validate`, `bundled`), so this file never imports them.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ModelHeader } from "../../recommender/types";
import type { Database } from "../db/sqlite";
import { activateModel, getActiveModelRecord, getModelRecord, registerDataset, registerModel, type DatasetMetadata, type ModelRecord } from "./pipeline-store";

export interface BundledModel<M extends ModelHeader = ModelHeader> {
  model: M;
  dataset: DatasetMetadata;
  metrics: Record<string, unknown>;
}

export interface LoadedModel<M extends ModelHeader = ModelHeader> {
  model: M;
  record: ModelRecord;
  /** True when the active model couldn't be used and the bundled one is serving instead. */
  fallback: boolean;
}

export interface LoadOptions<M extends ModelHeader> {
  bundled: BundledModel<M>;
  validate: (x: unknown) => boolean;
  /** Defaults to console.warn. Called at most once per distinct message. */
  log?: (message: string) => void;
}

/** Artifacts bigger than this are refused (the bundled model is far smaller). */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The hash recorded for the bundled model: sha256 of JSON.stringify(model). */
export const bundledArtifactSha256 = (model: ModelHeader) => sha256(JSON.stringify(model));

const logged = new Set<string>();
function logOnce(log: ((m: string) => void) | undefined, message: string) {
  if (logged.has(message)) return;
  logged.add(message);
  (log ?? ((m: string) => console.warn(m)))(`[personalisation] ${message}`);
}

/**
 * Registers the bundled model (and its dataset) if it isn't registered yet, and activates it when nothing is active,
 * or when the active model is an older bundled one (whose artifact no longer ships with the app).
 */
export function bootstrapModel<M extends ModelHeader>(db: Database, bundled: BundledModel<M>, now: number = Date.now()): { activated: boolean } {
  const { model, dataset, metrics } = bundled;
  if (model.datasetVersion !== dataset.version) throw new Error(`Bundled model ${model.version} names dataset ${model.datasetVersion}, but the bundled dataset is ${dataset.version}`);
  const json = JSON.stringify(model);
  registerDataset(db, dataset);
  registerModel(db, {
    version: model.version,
    datasetVersion: model.datasetVersion,
    algorithm: model.algorithm,
    trainedOn: model.trainedOn,
    config: { bundled: true },
    metrics,
    artifactPath: null,
    artifactSha256: sha256(json),
    sizeBytes: Buffer.byteLength(json),
    createdAt: dataset.createdAt,
    notes: "Bundled with the app",
  });
  const active = getActiveModelRecord(db);
  if (!active || (active.artifactPath === null && active.version !== model.version)) {
    activateModel(db, model.version, now);
    return { activated: true };
  }
  return { activated: false };
}

const cache = new Map<string, ModelHeader>();
/** Validation results for in-memory (bundled) models, so the fallback path doesn't re-validate on every request. */
let validated = new WeakMap<object, boolean>();

/** For tests. */
export const clearModelCache = () => {
  cache.clear();
  logged.clear();
  validated = new WeakMap();
};

function isValidBundled(model: ModelHeader, validate: (x: unknown) => boolean): boolean {
  let ok = validated.get(model);
  if (ok === undefined) validated.set(model, (ok = validate(model)));
  return ok;
}

function readArtifact<M extends ModelHeader>(record: ModelRecord, bundled: BundledModel<M>): unknown {
  if (record.artifactPath === null) {
    if (record.version !== bundled.model.version) throw new Error("its artifact is no longer bundled with the app");
    if (bundledArtifactSha256(bundled.model) !== record.artifactSha256) throw new Error("the bundled artifact's hash doesn't match the registry");
    return bundled.model;
  }
  const file = isAbsolute(record.artifactPath) ? record.artifactPath : resolve(process.cwd(), record.artifactPath);
  if (statSync(file).size > MAX_ARTIFACT_BYTES) throw new Error("the artifact is too big");
  const bytes = readFileSync(file);
  if (sha256(bytes) !== record.artifactSha256) throw new Error("the artifact's hash doesn't match the registry");
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * The model to serve: the active one if it loads, passes its hash check and validates; else the bundled one.
 * Null only if even the bundled model fails validation or isn't registered (then there are no suggestions).
 */
export function loadActiveModel<M extends ModelHeader>(db: Database, options: LoadOptions<M>): LoadedModel<M> | null {
  const { bundled, validate, log } = options;
  const record = getActiveModelRecord(db);
  if (record) {
    const key = `${record.version}:${record.artifactSha256}`;
    const cached = cache.get(key);
    if (cached) return { model: cached as M, record, fallback: false };
    try {
      const candidate = readArtifact(record, bundled);
      if (!validate(candidate)) throw new Error("it failed validation");
      const model = candidate as M;
      if (model.version !== record.version) throw new Error(`the artifact says it is ${model.version}`);
      cache.set(key, model);
      return { model, record, fallback: false };
    } catch (error) {
      logOnce(log, `active model ${record.version} can't be used (${error instanceof Error ? error.message : "unknown error"}), so the bundled model is serving`);
    }
  }
  if (!isValidBundled(bundled.model, validate)) {
    logOnce(log, `bundled model ${bundled.model.version} failed validation, so there are no suggestions`);
    return null;
  }
  const bundledRecord = getModelRecord(db, bundled.model.version);
  if (!bundledRecord) {
    logOnce(log, `bundled model ${bundled.model.version} isn't registered, so there are no suggestions`);
    return null;
  }
  return { model: bundled.model, record: bundledRecord, fallback: true };
}

const BOOTSTRAP_RETRY_MS = 60_000;

/**
 * The loader the app uses: registers the bundled model on first use of each database (retrying at most once a minute
 * until that works), then loads the active model.
 */
export function createModelLoader<M extends ModelHeader>(options: LoadOptions<M> & { now?: () => number }) {
  const ready = new WeakSet<Database>();
  const failedAt = new WeakMap<Database, number>();
  const now = options.now ?? Date.now;
  return (db: Database): LoadedModel<M> | null => {
    const at = now();
    const last = failedAt.get(db);
    if (!ready.has(db) && (last === undefined || at - last >= BOOTSTRAP_RETRY_MS)) {
      try {
        bootstrapModel(db, options.bundled, at);
        ready.add(db);
      } catch (error) {
        failedAt.set(db, at);
        logOnce(options.log, `couldn't register the bundled model (${error instanceof Error ? error.message : "unknown error"})`);
      }
    }
    return loadActiveModel(db, options);
  };
}
