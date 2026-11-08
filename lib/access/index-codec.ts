// The example index, precomputed at build time so a phone never has to embed ~250 sentences itself.
// Vectors are unit length, stored as int8 (x * 127) in base64: about 100 KB instead of 1 MB of JSON floats.
// The hash ties the file to the exact example list, so a stale index is detected and rebuilt on the device.
import { exampleList, type ExampleIndex, type Label } from "./understand";

export const INDEX_VERSION = 1;
export const MODEL_ID = "all-MiniLM-L6-v2";

export interface IndexFile {
  version: typeof INDEX_VERSION;
  model: typeof MODEL_ID;
  hash: string;
  dims: number;
  labels: Label[];
  vectors: string;
}

/** FNV-1a over the examples and labels. Not security, just "is this the same list?". */
export function examplesHash(): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(exampleList())) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const toBase64 = (bytes: Uint8Array) => (typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(String.fromCharCode(...bytes)));
function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeIndex(index: ExampleIndex): IndexFile {
  const dims = index.vectors[0]?.length ?? 0;
  const bytes = new Int8Array(index.vectors.length * dims);
  index.vectors.forEach((v, i) => v.forEach((x, j) => (bytes[i * dims + j] = Math.max(-127, Math.min(127, Math.round(x * 127))))));
  return { version: INDEX_VERSION, model: MODEL_ID, hash: examplesHash(), dims, labels: index.labels, vectors: toBase64(new Uint8Array(bytes.buffer)) };
}

/** The index, or null if the file is for another model, another example list, or malformed. Never throws. */
export function decodeIndex(file: unknown): ExampleIndex | null {
  try {
    const f = file as IndexFile;
    if (f?.version !== INDEX_VERSION || f.model !== MODEL_ID || f.hash !== examplesHash() || !Array.isArray(f.labels)) return null;
    const bytes = new Int8Array(fromBase64(f.vectors).buffer);
    if (f.dims <= 0 || bytes.length !== f.labels.length * f.dims) return null;
    const vectors = f.labels.map((_, i) => {
      const v = new Float32Array(f.dims);
      let norm = 0;
      for (let j = 0; j < f.dims; j++) norm += (v[j] = bytes[i * f.dims + j] / 127) ** 2;
      const n = Math.sqrt(norm) || 1;
      for (let j = 0; j < f.dims; j++) v[j] /= n;
      return v;
    });
    return { labels: f.labels, vectors };
  } catch {
    return null;
  }
}
