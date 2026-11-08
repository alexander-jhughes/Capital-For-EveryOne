// GENERATOR B: a second, independently designed SYNTHETIC population. Used ONLY to test robustness
// ("train on generator A, test on generator B"). It is never used for training, threshold choice, calibration
// or any tuning, and it was frozen before the v2 model was designed (docs/ml-personalisation/EVALUATION-v2.md).
//
// It makes different assumptions from generator A (synthetic.ts) on purpose:
//   tastes        A: a mixture of 7 loose bundles.           B: 4 continuous latent factors with different loadings, more noise.
//   engagement    A: smooth (rand^1.5).                      B: bimodal (25% tinkerers, 75% rarely touch settings).
//   adoption      A: engagement x steep sigmoid at 0.6.      B: engagement x linear ramp from 0.4 to 0.9.
//   action counts A: weakly tied to engagement, Poisson.      B: strongly tied to how often they use the app, overdispersed, cross-talk between tastes.
//   labels        A: sigmoid(10(t-0.55)), 5% flipped.        B: flatter (slope 7), floor 5% / ceiling 95%, status-quo bias, 8% flipped.
//   schema        A: 30% on the older schema.                B: everyone on the current schema, with answer style and listen mode.
//   consent       A: 60%.                                    B: 50%.
// Hidden variables are still interface TASTES only (how someone likes the screen to look and behave), never
// conditions, ages, circumstances or anything financial. Same author as generator A, so B is a stress test of
// specific assumptions, not truly independent evidence.
import { CHOICE_IDS, type ChoiceId, type Signals, TEXT_SIZE_LEVELS } from "./features";
import { rng } from "./forest";
import type { SyntheticOptions, SyntheticPerson } from "./synthetic";
import { TARGET_IDS, type TargetId } from "./targets";

export const GENERATOR_B_VERSION = 1;
export const DEFAULT_SYNTHETIC_B: SyntheticOptions = { people: 20000, seed: 4242, labelNoise: 0.08 };

type Taste = "readable" | "calm" | "visual" | "guided" | "talk" | "still" | "contrast" | "billFirst" | "detail";
type Factor = "simple" | "voice" | "data" | "order";

/** Taste = sigmoid(sum of loadings x factors + bias + noise). Loadings describe interface tastes only. */
const LOADINGS: Record<Taste, { bias: number } & Partial<Record<Factor, number>>> = {
  readable: { simple: 0.9, voice: 0.3, bias: -1.0 },
  calm: { simple: 0.8, data: -0.6, bias: -0.8 },
  visual: { data: 0.9, simple: -0.2, bias: -1.0 },
  guided: { simple: 0.5, order: 0.6, voice: 0.3, bias: -0.9 },
  talk: { voice: 1.1, bias: -1.3 },
  still: { simple: 0.5, order: 0.4, bias: -1.2 },
  contrast: { simple: 0.6, data: 0.3, bias: -1.4 },
  billFirst: { order: 0.9, data: -0.2, bias: -0.8 },
  detail: { data: 1.0, simple: -0.4, bias: -0.9 },
};
const TASTE_NOISE = 0.7;

const LABEL_TASTE: Record<TargetId, Taste> = {
  largerText: "readable",
  calmLayout: "calm",
  visualSummary: "visual",
  stepByStep: "guided",
  voiceFirst: "talk",
  reducedMotion: "still",
  highContrast: "contrast",
  paymentsProminent: "billFirst",
};
const CHOICE_TASTE: Record<ChoiceId, Taste> = {
  largerText: "readable",
  lessInfo: "calm",
  moreVisual: "visual",
  stepByStep: "guided",
  voiceFirst: "talk",
  moreDetail: "detail",
  reducedMotion: "still",
  highContrast: "contrast",
  paymentsProminent: "billFirst",
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const ramp = (v: number, from: number, to: number) => Math.min(1, Math.max(0, (v - from) / (to - from)));

export function generateSyntheticB(opts: SyntheticOptions = DEFAULT_SYNTHETIC_B): SyntheticPerson[] {
  const rand = rng(opts.seed ^ 0xb0b);
  const bern = (p: number) => rand() < p;
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const poisson = (lambda: number) => {
    const limit = Math.exp(-lambda);
    let k = 0;
    let prod = rand();
    while (prod > limit && k < 60) {
      k++;
      prod *= rand();
    }
    return k;
  };
  // Gamma(1.5) / 1.5 (mean 1): makes counts overdispersed (some people do one thing a lot, others never).
  const burst = () => (-Math.log(1 - rand()) + 0.5 * normal() ** 2) / 1.5;

  const people: SyntheticPerson[] = [];
  for (let n = 0; n < opts.people; n++) {
    const f: Record<Factor, number> = { simple: normal(), voice: normal(), data: normal(), order: normal() };
    const taste = Object.fromEntries(
      (Object.keys(LOADINGS) as Taste[]).map((t) => {
        const { bias, ...load } = LOADINGS[t];
        const z = bias + (Object.entries(load) as [Factor, number][]).reduce((s, [k, w]) => s + w * f[k], 0) + TASTE_NOISE * normal();
        return [t, sigmoid(z)];
      }),
    ) as Record<Taste, number>;

    const engagement = bern(0.25) ? 0.55 + 0.45 * rand() : 0.3 * rand();
    const adopts = (t: number) => bern(engagement * ramp(t, 0.4, 0.9));

    const textOn = adopts(taste.readable);
    const chartUp = adopts(taste.visual);
    const billUp = adopts(taste.billFirst);
    const calmUp = adopts(taste.calm);
    const hideP = 0.6 * engagement * ramp(taste.calm, 0.3, 0.9);
    const hidden = ["recent", "budget", "chart", "balance", "insights"].filter((w) => !(chartUp && w === "chart") && bern(hideP));
    const talks = adopts(taste.talk);

    const preferences = {
      textSize: TEXT_SIZE_LEVELS[textOn ? (taste.readable > 0.85 ? 3 : taste.readable > 0.7 ? 2 : 1) : 0],
      contrast: adopts(taste.contrast) ? "high" : "standard",
      spacing: adopts(Math.max(taste.calm, taste.readable) - 0.05) ? "roomy" : "standard",
      motion: adopts(taste.still) ? "reduced" : "system",
      theme: bern(0.15 + 0.3 * taste.contrast) ? "dark" : bern(0.1) ? "light" : "system",
      targets: adopts(0.6 * taste.readable + 0.4 * taste.talk) ? "large" : "standard",
      explanations: adopts(taste.guided) ? "stepByStep" : "standard",
      voiceFirst: talks,
      answerStyle: adopts(0.6 * taste.talk + 0.4 * taste.calm) ? "brief" : "standard",
      listenMode: talks && bern(0.7) ? (bern(0.55) ? "hold" : "continuous") : "tap",
      layout: {
        pinned: taste.billFirst > taste.visual ? [...(billUp ? ["bill"] : []), ...(chartUp ? ["chart"] : [])] : [...(chartUp ? ["chart"] : []), ...(billUp ? ["bill"] : [])],
        shown: chartUp ? ["chart"] : [],
        hidden,
        emphasis: billUp && bern(0.3) ? "bill" : chartUp && bern(0.2) ? "chart" : null,
        density: calmUp ? "calm" : "standard",
      },
    };

    const viewSimple = bern(Math.min(0.9, Math.max(0.1, 0.5 + 0.35 * (taste.calm + taste.guided - taste.detail - taste.visual))));
    const choices = bern(0.35) ? CHOICE_IDS.filter((c) => bern(0.1 + 0.75 * ramp(taste[CHOICE_TASTE[c]], 0.35, 0.85))) : null;

    let signals: Signals | null = null;
    if (bern(0.5)) {
      const sessions = 1 + poisson(1 + 8 * engagement);
      const count = (ratePerSession: number) => poisson(sessions * ratePerSession * burst());
      signals = {
        textLarger: count(0.25 * ramp(taste.readable, 0.3, 0.9) + 0.03),
        textSmaller: count(0.06 * (1 - taste.readable)),
        voiceSessions: count(0.35 * ramp(taste.talk, 0.25, 0.85) + 0.08 * taste.readable),
        lessOnScreen: count(0.2 * ramp(taste.calm, 0.3, 0.9) + 0.08 * taste.still),
        moreDetail: count(0.2 * ramp(taste.detail, 0.3, 0.9) + 0.05),
        undoneChanges: count(0.1 + 0.1 * (1 - engagement)),
        // Explicit taps added for v2 features. Older code ignores unknown signal ids.
        readAloud: count(0.12 * ramp(taste.talk, 0.3, 0.9) + 0.2 * ramp(taste.readable, 0.4, 0.9)),
        viewSimple: count(0.06 * (taste.calm + taste.guided)),
        viewDetailed: count(0.08 * taste.detail + 0.04 * taste.visual),
      } as Signals;
    }

    const labels = Object.fromEntries(
      TARGET_IDS.map((id) => {
        const p = (0.05 + 0.9 * sigmoid(7 * (taste[LABEL_TASTE[id]] - 0.5))) * (0.85 + 0.15 * engagement);
        const keep = bern(p);
        return [id, (bern(opts.labelNoise) ? !keep : keep) ? 1 : 0];
      }),
    ) as Record<TargetId, 0 | 1>;

    people.push({ input: { preferences, view: viewSimple ? "simple" : "complex", choices }, signals, labels });
  }
  return people;
}
