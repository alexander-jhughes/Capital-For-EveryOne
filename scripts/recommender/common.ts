// Shared helpers for the recommender pipeline scripts (train, promote, rollback, models, monitor).
// The database is only ever touched through the backend's pipeline store (lib/server/personalisation/pipeline-store.ts),
// loaded lazily so the scripts run without a database unless `--db <path>` is given.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatasetMetadata, ModelRecord } from "../../lib/server/personalisation/pipeline-store";

export type Store = typeof import("../../lib/server/personalisation/pipeline-store");

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MODELS_DIR = join(ROOT, "lib", "recommender", "models");
export const MANIFEST_PATH = join(MODELS_DIR, "manifest.json");
export const INDEX_PATH = join(MODELS_DIR, "index.ts");
/** Models trained with real data never go into the repository. */
export const PRIVATE_MODELS_DIR = join(ROOT, ".data", "models");
export const EVALUATION_MD = join(ROOT, "docs", "ml-personalisation", "v2", "EVALUATION.md");

export interface Args {
  flags: Set<string>;
  values: Map<string, string>;
}

/** `--name value` and `--flag` (a flag is any option not followed by a value). */
export function parseArgs(argv: string[], valued: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    const name = a.slice(2);
    if (valued.includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      values.set(name, v);
    } else flags.add(name);
  }
  return { flags, values };
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Loads the backend's pipeline store. Only called when --db is given. */
export async function loadStore(): Promise<Store> {
  const url = pathToFileURL(join(ROOT, "lib", "server", "personalisation", "pipeline-store.ts")).href;
  return (await import(url)) as Store;
}

export async function openStore(path: string): Promise<{ store: Store; db: ReturnType<Store["openDatabase"]> }> {
  const store = await loadStore();
  return { store, db: store.openDatabase(path) };
}

/** What lib/recommender/models/index.ts bundles: written by train.ts. */
export interface Manifest {
  version: string;
  file: string;
  evaluation: string;
  dataset: DatasetMetadata;
  metrics: Record<string, unknown>;
}

export function readManifest(): Manifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** The artifact behind a registry record: a file (hash-checked) or, for artifactPath null, the bundled model. */
export function readArtifact(record: Pick<ModelRecord, "version" | "artifactPath" | "artifactSha256">): unknown {
  if (record.artifactPath === null) {
    const m = readManifest();
    if (!m || m.version !== record.version) throw new Error(`${record.version} is registered as bundled, but the bundled model is ${m?.version ?? "missing"}`);
    const model = JSON.parse(readFileSync(join(MODELS_DIR, m.file), "utf8"));
    if (sha256(JSON.stringify(model)) !== record.artifactSha256) throw new Error(`bundled artifact hash does not match the registry for ${record.version}`);
    return model;
  }
  const file = isAbsolute(record.artifactPath) ? record.artifactPath : resolve(process.cwd(), record.artifactPath);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== record.artifactSha256) throw new Error(`artifact hash does not match the registry for ${record.version}`);
  return JSON.parse(bytes.toString("utf8"));
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export const fmt = (v: unknown, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "n/a");
export const iso = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : "-");
