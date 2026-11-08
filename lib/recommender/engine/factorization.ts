// Component 3: hybrid matrix factorisation (LightFM-style).
//
// A person is the sum of the embeddings of their features; an item is its own embedding plus the embeddings of its
// catalog tags (so items that change similar things share what is learned about them). Plus biases:
//   score(x, i) = b_i + Σ_f x_f·b_f + ⟨Σ_f x_f·V_f, E_i + Σ_{t ∈ tags(i)} T_t⟩,   P(keep) = σ(score)
// Logistic loss, L2, seeded Adagrad SGD, early stopping on a held-out set of training subjects.
import { CATALOG, ITEM_IDS, ITEM_TAGS } from "../catalog";
import { normal, rng, shuffle } from "../random";
import { ITEM_COUNT, type PreparedExample, splitSubjects } from "./data";
import { FEATURE_COUNT } from "./features";
import { logLoss, safeLogit, sigmoid } from "./math";

export interface FactorizationParams {
  factors: number;
  /** ITEM_TAGS at training time, in order (tagEmb rows). */
  tags: string[];
  featureBias: number[];
  /** [feature][factor] */
  featureEmb: number[][];
  itemBias: number[];
  /** [item][factor] */
  itemEmb: number[][];
  /** [tag][factor] */
  tagEmb: number[][];
}

export interface FactorizationOptions {
  factors: number;
  epochs: number;
  learningRate: number;
  l2: number;
  patience: number;
  holdout: number;
  initScale: number;
}

const TAG_INDEX = ITEM_IDS.map((id) => CATALOG[id].tags.map((t) => ITEM_TAGS.indexOf(t)));

interface State {
  k: number;
  bf: Float64Array;
  v: Float64Array;
  bi: Float64Array;
  e: Float64Array;
  t: Float64Array;
}

const cloneState = (s: State): State => ({ k: s.k, bf: s.bf.slice(), v: s.v.slice(), bi: s.bi.slice(), e: s.e.slice(), t: s.t.slice() });

function predict(s: State, ex: PreparedExample, u: Float64Array, q: Float64Array): number {
  const k = s.k;
  u.fill(0);
  let z = s.bi[ex.item];
  for (let a = 0; a < ex.x.idx.length; a++) {
    const f = ex.x.idx[a];
    const xv = ex.x.val[a];
    z += s.bf[f] * xv;
    for (let d = 0; d < k; d++) u[d] += xv * s.v[f * k + d];
  }
  for (let d = 0; d < k; d++) q[d] = s.e[ex.item * k + d];
  for (const t of TAG_INDEX[ex.item]) for (let d = 0; d < k; d++) q[d] += s.t[t * k + d];
  for (let d = 0; d < k; d++) z += u[d] * q[d];
  return z;
}

export function trainFactorization(
  examples: readonly PreparedExample[],
  priorRate: readonly number[],
  options: FactorizationOptions,
  seed: number,
): FactorizationParams {
  const r = rng(seed);
  const k = options.factors;
  const s: State = {
    k,
    bf: new Float64Array(FEATURE_COUNT),
    v: Float64Array.from({ length: FEATURE_COUNT * k }, () => normal(r) * options.initScale),
    bi: Float64Array.from(priorRate.map(safeLogit)),
    e: Float64Array.from({ length: ITEM_COUNT * k }, () => normal(r) * options.initScale),
    t: Float64Array.from({ length: ITEM_TAGS.length * k }, () => normal(r) * options.initScale),
  };
  const g2: State = { k, bf: new Float64Array(s.bf.length), v: new Float64Array(s.v.length), bi: new Float64Array(s.bi.length), e: new Float64Array(s.e.length), t: new Float64Array(s.t.length) };

  const { a: fit, b: held } = options.holdout > 0 ? splitSubjects(examples, options.holdout, r) : { a: [...examples], b: [] };
  const order = fit.map((_, i) => i);
  const u = new Float64Array(k);
  const q = new Float64Array(k);
  const lr = options.learningRate;
  const l2 = options.l2;
  const eps = 1e-8;
  const step = (param: Float64Array, acc: Float64Array, i: number, grad: number) => {
    acc[i] += grad * grad;
    param[i] -= (lr * grad) / Math.sqrt(acc[i] + eps);
  };

  const heldLoss = (st: State) => {
    const p: number[] = [];
    const y: number[] = [];
    const w: number[] = [];
    for (const ex of held) {
      p.push(sigmoid(predict(st, ex, u, q)));
      y.push(ex.y);
      w.push(ex.w);
    }
    return logLoss(p, y, w);
  };

  let best = cloneState(s);
  let bestLoss = held.length ? heldLoss(s) : Infinity;
  let bad = 0;
  const gu = new Float64Array(k);
  for (let epoch = 0; epoch < options.epochs; epoch++) {
    shuffle(r, order);
    for (const idx of order) {
      const ex = fit[idx];
      const z = predict(s, ex, u, q);
      const gz = ex.w * (sigmoid(z) - ex.y);
      step(s.bi, g2.bi, ex.item, gz);
      // Gradients w.r.t. the item side use u; w.r.t. the person side use q (computed before any update).
      for (let d = 0; d < k; d++) gu[d] = gz * u[d];
      for (let a = 0; a < ex.x.idx.length; a++) {
        const f = ex.x.idx[a];
        const xv = ex.x.val[a];
        step(s.bf, g2.bf, f, gz * xv + l2 * s.bf[f]);
        for (let d = 0; d < k; d++) step(s.v, g2.v, f * k + d, gz * xv * q[d] + l2 * s.v[f * k + d]);
      }
      for (let d = 0; d < k; d++) step(s.e, g2.e, ex.item * k + d, gu[d] + l2 * s.e[ex.item * k + d]);
      for (const t of TAG_INDEX[ex.item]) for (let d = 0; d < k; d++) step(s.t, g2.t, t * k + d, gu[d] + l2 * s.t[t * k + d]);
    }
    if (held.length === 0) {
      best = cloneState(s);
      continue;
    }
    const loss = heldLoss(s);
    if (loss < bestLoss - 1e-5) {
      bestLoss = loss;
      best = cloneState(s);
      bad = 0;
    } else if (++bad >= options.patience) break;
  }

  const rows = (a: Float64Array, n: number) => Array.from({ length: n }, (_, i) => Array.from(a.subarray(i * k, i * k + k)));
  return {
    factors: k,
    tags: [...ITEM_TAGS],
    featureBias: Array.from(best.bf),
    featureEmb: rows(best.v, FEATURE_COUNT),
    itemBias: Array.from(best.bi),
    itemEmb: rows(best.e, ITEM_COUNT),
    tagEmb: rows(best.t, ITEM_TAGS.length),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------------------------------------------

export interface PreparedFactorization {
  k: number;
  bf: Float64Array;
  v: Float64Array;
  bi: Float64Array;
  /** Item representations: E_i + Σ tag embeddings, [item][factor]. */
  q: Float64Array;
}

export function prepareFactorization(p: FactorizationParams): PreparedFactorization {
  const k = p.factors;
  const q = new Float64Array(ITEM_COUNT * k);
  for (let i = 0; i < ITEM_COUNT; i++) {
    for (let d = 0; d < k; d++) q[i * k + d] = p.itemEmb[i][d];
    for (const t of TAG_INDEX[i]) for (let d = 0; d < k; d++) q[i * k + d] += p.tagEmb[t][d];
  }
  return { k, bf: Float64Array.from(p.featureBias), v: Float64Array.from(p.featureEmb.flat()), bi: Float64Array.from(p.itemBias), q };
}

/** Writes the factorisation logit of every item. */
export function scoreFactorization(pf: PreparedFactorization, x: ArrayLike<number>, out: Float64Array): void {
  const k = pf.k;
  const u = new Float64Array(k);
  let ub = 0;
  for (let f = 0; f < x.length; f++) {
    const xv = x[f];
    if (xv === 0) continue;
    ub += pf.bf[f] * xv;
    for (let d = 0; d < k; d++) u[d] += xv * pf.v[f * k + d];
  }
  for (let i = 0; i < ITEM_COUNT; i++) {
    let z = pf.bi[i] + ub;
    for (let d = 0; d < k; d++) z += u[d] * pf.q[i * k + d];
    out[i] = z;
  }
}
