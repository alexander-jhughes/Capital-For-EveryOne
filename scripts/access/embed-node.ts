// Node embedder for tests and the evaluation script: the same model and settings the browser uses (lib/access/embed.ts),
// loaded from public/models so it never touches the network.
import { fileURLToPath } from "node:url";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Embed } from "../../lib/access/understand";

let extractor: Promise<FeatureExtractionPipeline> | null = null;

export function nodeEmbed(): Embed {
  env.allowRemoteModels = false;
  env.localModelPath = fileURLToPath(new URL("../../public/models/", import.meta.url));
  extractor ??= pipeline("feature-extraction", "all-MiniLM-L6-v2", { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
  return async (texts) => {
    const out = await (await extractor!)(texts, { pooling: "mean", normalize: true });
    const [n, d] = out.dims as [number, number];
    const data = out.data as Float32Array;
    return Array.from({ length: n }, (_, i) => data.slice(i * d, (i + 1) * d));
  };
}
