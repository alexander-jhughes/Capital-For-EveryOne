// Loads the on-device understanding model in the browser, once, and only when Dial is opened.
// Everything is served from this app (public/models, public/ort): no request leaves for a third party, and it keeps
// working offline once loaded. If anything fails (old browser, no WebAssembly, low memory), Dial simply carries on
// with its precise rules and the cloud model, exactly as before.
import { decodeIndex, MODEL_ID } from "./index-codec";
import { buildIndex, type Embed, type ExampleIndex } from "./understand";

export interface Brain {
  embed: Embed;
  index: ExampleIndex;
}

export type BrainStatus = "idle" | "loading" | "ready" | "unavailable";

let loading: Promise<Brain | null> | null = null;
let status: BrainStatus = "idle";
const listeners = new Set<(s: BrainStatus) => void>();
const setStatus = (s: BrainStatus) => {
  status = s;
  listeners.forEach((l) => l(s));
};

export const brainStatus = () => status;
export function onBrainStatus(l: (s: BrainStatus) => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

async function load(): Promise<Brain | null> {
  if (typeof window === "undefined" || typeof WebAssembly === "undefined") return null;
  setStatus("loading");
  const t = await import("@huggingface/transformers");
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  t.env.localModelPath = "/models/";
  const wasm = t.env.backends.onnx.wasm;
  if (wasm) {
    // Our own copy of the ONNX runtime (scripts/access/copy-runtime.mjs), single-threaded so it needs no special headers.
    wasm.wasmPaths = { mjs: "/ort/ort-wasm-simd-threaded.mjs", wasm: "/ort/ort-wasm-simd-threaded.wasm" };
    wasm.numThreads = 1;
  }
  const extractor = await t.pipeline("feature-extraction", MODEL_ID, { dtype: "q8", device: "wasm" });
  const embed: Embed = async (texts) => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const [n, d] = out.dims as [number, number];
    const data = out.data as Float32Array;
    return Array.from({ length: n }, (_, i) => data.slice(i * d, (i + 1) * d));
  };
  let index: ExampleIndex | null = null;
  try {
    const res = await fetch("/models/access-index.json");
    if (res.ok) index = decodeIndex(await res.json());
  } catch {}
  // A stale or missing index is rebuilt here: slower the first time, never wrong.
  index ??= await buildIndex(embed);
  return { embed, index };
}

/** Starts loading (if not already) and resolves the brain, or null if this browser can't run it. */
export function loadBrain(): Promise<Brain | null> {
  loading ??= load()
    .then((b) => {
      setStatus(b ? "ready" : "unavailable");
      return b;
    })
    .catch(() => {
      // Logged without details: an error here could carry a file path, and nothing about the person is involved.
      console.warn("[access] on-device understanding is unavailable in this browser");
      setStatus("unavailable");
      return null;
    });
  return loading;
}

/** The brain if it is ready within `ms`, else null (the caller carries on with the rules and keeps loading). */
export async function brainWithin(ms: number): Promise<Brain | null> {
  return Promise.race([loadBrain(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
