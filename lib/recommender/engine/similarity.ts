// WS2: similarity between people, for the collaborative ("people with similar answers") component.
//
// Weighted cosine over the profile and settings part of the encoded vector: answers and settings count fully,
// explicit dimensions and signals are down-weighted, history and the view are left out (see FeatureDef
// `similarityWeight`). A person who has told Dial nothing (no answers, default settings, no signals) has a zero
// vector: they are similar to nobody, which is what makes cold start report "insufficient evidence".
import { FEATURE_COUNT, FEATURES } from "./features";

export const SIMILARITY_WEIGHTS: readonly number[] = FEATURES.map((f) => f.similarityWeight);

/** Weighted cosine similarity in [−1, 1] (in [0, 1] for encoded vectors). 0 when either vector is all zeros. */
export function weightedCosine(a: ArrayLike<number>, b: ArrayLike<number>, weights: ArrayLike<number> = SIMILARITY_WEIGHTS): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const w = weights[i];
    if (w === 0) continue;
    ab += w * a[i] * b[i];
    aa += w * a[i] * a[i];
    bb += w * b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * The unit vector the cosine is taken over: sqrt(w) ⊙ x, normalised. Dot products of two such vectors are
 * exactly `weightedCosine`. Returns null for a vector with nothing in it.
 */
export function similarityVector(x: ArrayLike<number>, weights: ArrayLike<number> = SIMILARITY_WEIGHTS, out = new Float64Array(FEATURE_COUNT)): Float64Array | null {
  let norm = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * Math.sqrt(weights[i]);
    out[i] = v;
    norm += v * v;
  }
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < x.length; i++) out[i] *= inv;
  return out;
}
