// SYNTHETIC TRAINING DATA. No real person's data is used anywhere in this model.
//
// Each synthetic person has hidden *presentation tastes* (how much they like large text, a calm screen,
// charts, step-by-step guidance, talking, stillness, contrast, the bill up front, detail). These are tastes
// about how an interface looks, not conditions, diagnoses, ages or circumstances, and nothing financial.
// From the hidden tastes we simulate, with noise and missing data:
//   - the settings they set themselves (only some people ever open settings),
//   - "Make it yours" ticks (only some people do it),
//   - counts of explicit display actions (only people who consented have any),
//   - whether they would keep each setting if Dial offered it (the labels).
// The model only ever sees the observable parts. It has to learn which observable signals go together,
// it is never given the hidden tastes or the generator's formulas.
//
// Because we wrote the generator, good scores on this data show the pipeline works, NOT that the model
// predicts real people. See docs/ML-PERSONALISATION.md, "Limitations".
import { CHOICE_IDS, type ChoiceId, type PersonalisationInput, type SignalId, type Signals, TEXT_SIZE_LEVELS } from "./features";
import { rng } from "./forest";
import { TARGET_IDS, type TargetId } from "./targets";

export const SYNTHETIC_GENERATOR_VERSION = 1;

const TASTES = ["readable", "calm", "visual", "guided", "talk", "still", "contrast", "billFirst", "detail"] as const;
type Taste = (typeof TASTES)[number];
type Tastes = Record<Taste, number>;

/** Mixture components: loose bundles of tastes that tend to go together. Names describe interface tastes only. */
const ARCHETYPES: { weight: number; mean: Partial<Tastes> }[] = [
  { weight: 0.3, mean: {} }, // no strong preference
  { weight: 0.14, mean: { readable: 0.85, contrast: 0.6, still: 0.45, calm: 0.5, billFirst: 0.5 } },
  { weight: 0.13, mean: { calm: 0.85, guided: 0.55, billFirst: 0.65, still: 0.55, detail: 0.1 } },
  { weight: 0.12, mean: { visual: 0.85, detail: 0.55, calm: 0.2 } },
  { weight: 0.1, mean: { talk: 0.85, guided: 0.5, readable: 0.55 } },
  { weight: 0.11, mean: { guided: 0.85, calm: 0.6, billFirst: 0.55 } },
  { weight: 0.1, mean: { detail: 0.85, visual: 0.5, calm: 0.05 } },
];
const BASE_TASTE = 0.25;

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

export interface SyntheticOptions {
  people: number;
  seed: number;
  /** Probability of each label being flipped, to model people changing their minds. */
  labelNoise: number;
}

export const DEFAULT_SYNTHETIC: SyntheticOptions = { people: 20000, seed: 20261107, labelNoise: 0.05 };

export interface SyntheticPerson {
  input: PersonalisationInput;
  signals: Signals | null;
  /** 1 = would keep the setting if offered. Meaningful only when the setting is currently off. */
  labels: Record<TargetId, 0 | 1>;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function generateSynthetic(opts: SyntheticOptions = DEFAULT_SYNTHETIC): SyntheticPerson[] {
  const rand = rng(opts.seed);
  const bern = (p: number) => rand() < p;
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const poisson = (lambda: number) => {
    const limit = Math.exp(-lambda);
    let k = 0;
    let prod = rand();
    while (prod > limit) {
      k++;
      prod *= rand();
    }
    return k;
  };
  const totalWeight = ARCHETYPES.reduce((s, a) => s + a.weight, 0);

  const people: SyntheticPerson[] = [];
  for (let n = 0; n < opts.people; n++) {
    let pick = rand() * totalWeight;
    const arch = ARCHETYPES.find((a) => (pick -= a.weight) < 0) ?? ARCHETYPES[0];
    const taste = Object.fromEntries(TASTES.map((t) => [t, clamp01((arch.mean[t] ?? BASE_TASTE) + 0.18 * normal())])) as Tastes;

    // How much this person adjusts settings at all. Many people never open settings.
    const engagement = rand() ** 1.5;
    const adopts = (t: number) => bern(engagement * sigmoid(9 * (t - 0.6)));

    const textLevel = adopts(taste.readable) ? (taste.readable > 0.9 ? 3 : taste.readable > 0.78 ? 2 : 1) : 0;
    const chartUp = adopts(taste.visual);
    const billUp = adopts(taste.billFirst);
    const calmUp = adopts(taste.calm);
    const hiddenCount = calmUp || taste.calm > 0.6 ? Math.min(poisson(2.5 * taste.calm * engagement), 4) : 0;
    // Some app versions have no step-by-step or voice-first settings (the redesign branch); simulate that too.
    const newSchema = bern(0.7);
    const hiddenWidgets = ["recent", "chart", "budget", "balance"].slice(0, hiddenCount).filter((w) => !(chartUp && w === "chart"));

    const preferences = {
      textSize: TEXT_SIZE_LEVELS[textLevel],
      contrast: adopts(taste.contrast) ? "high" : "standard",
      spacing: adopts((taste.calm + taste.readable) / 2 + 0.05) ? "roomy" : "standard",
      motion: adopts(taste.still) ? "reduced" : "system",
      theme: bern(0.22) ? "dark" : bern(0.1) ? "light" : "system", // unrelated to any taste on purpose
      targets: adopts((taste.readable + taste.talk) / 2 + 0.05) ? "large" : "standard",
      ...(newSchema ? { explanations: adopts(taste.guided) ? "stepByStep" : "standard", voiceFirst: adopts(taste.talk) } : {}),
      layout: {
        pinned: [...(chartUp ? ["chart"] : []), ...(billUp ? ["bill"] : [])],
        shown: chartUp ? ["chart"] : [],
        hidden: hiddenWidgets,
        emphasis: billUp && bern(0.5) ? "bill" : null,
        density: calmUp ? "calm" : "standard",
      },
    };

    const viewSimple = bern(sigmoid(4 * (taste.calm + taste.guided + 0.5 * taste.talk - taste.detail - taste.visual)));

    // "Make it yours": done by under half. A tick is a noisy statement of a taste.
    const choices = bern(0.45) ? CHOICE_IDS.filter((c) => bern(0.03 + 0.9 * sigmoid(8 * (taste[CHOICE_TASTE[c]] - 0.6)))) : null;

    // Counts of explicit display actions, only for people who consented.
    let signals: Signals | null = null;
    if (bern(0.6)) {
      // Session actions (e.g. asking Dial for bigger text) happen even for people who never save a setting,
      // so they depend only weakly on settings engagement.
      const active = 0.7 + 0.5 * engagement;
      const counts: Record<SignalId, number> = {
        textLarger: poisson(active * 3 * Math.max(0, taste.readable - 0.35)),
        textSmaller: poisson(0.15 + active * 1.5 * Math.max(0, 0.4 - taste.readable)),
        voiceSessions: poisson(active * 5 * Math.max(0, taste.talk - 0.3)),
        lessOnScreen: poisson(active * 3 * Math.max(0, taste.calm - 0.35)),
        moreDetail: poisson(active * 3 * Math.max(0, taste.detail - 0.35) + 0.1),
        undoneChanges: poisson(0.3 + 0.4 * rand()), // noise: undoing is common and tells us little
      };
      signals = counts;
    }

    const labels = Object.fromEntries(
      TARGET_IDS.map((id) => {
        const keep = bern(sigmoid(10 * (taste[LABEL_TASTE[id]] - 0.55)));
        return [id, (bern(opts.labelNoise) ? !keep : keep) ? 1 : 0];
      }),
    ) as Record<TargetId, 0 | 1>;

    people.push({ input: { preferences, view: viewSimple ? "simple" : "complex", choices }, signals, labels });
  }
  return people;
}

/** Deterministic split by position after a seeded shuffle. Each person appears in exactly one part. */
export function splitIndices(count: number, seed: number, fractions = { train: 0.6, validation: 0.2 }) {
  const rand = rng(seed ^ 0x5eed);
  const idx = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const a = Math.round(count * fractions.train);
  const b = a + Math.round(count * fractions.validation);
  return { train: idx.slice(0, a), validation: idx.slice(a, b), test: idx.slice(b) };
}
