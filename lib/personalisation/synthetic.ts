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
// predicts real people. See docs/ml-personalisation/README.md, "Limitations".
//
// Version 2 (the default) keeps version 1's tastes and formulas as its core, adds four taste bundles, the current
// schema's answer style and listen mode, three new explicit signals, and, PER PERSON, randomises the generator's own
// uncertain assumptions within ranges that include version 1's values (domain randomisation): taste noise, how
// engagement drives saving settings and action counts, overdispersed counts, how strongly view follows taste, and how
// sharply tastes turn into "would keep it". Version 1 is kept unchanged so it can still be evaluated against.
import { sanitize } from "../preferences/schema";
import { CHOICE_IDS, type ChoiceId, type PersonalisationInput, type SignalId, type Signals, TEXT_SIZE_LEVELS } from "./features";
import { rng } from "./forest";
import { TARGET_IDS, type TargetId } from "./targets";

export const SYNTHETIC_GENERATOR_VERSION = 2;

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
  /** Generator version. Default SYNTHETIC_GENERATOR_VERSION; 1 reproduces the population model v1 was trained on. */
  version?: 1 | typeof SYNTHETIC_GENERATOR_VERSION;
}

export const DEFAULT_SYNTHETIC: SyntheticOptions = { people: 30000, seed: 20261107, labelNoise: 0.05, version: SYNTHETIC_GENERATOR_VERSION };

export interface SyntheticPerson {
  input: PersonalisationInput;
  signals: Signals | null;
  /** 1 = would keep the setting if offered. Meaningful only when the setting is currently off. */
  labels: Record<TargetId, 0 | 1>;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function generateSynthetic(opts: SyntheticOptions = DEFAULT_SYNTHETIC): SyntheticPerson[] {
  return (opts.version ?? SYNTHETIC_GENERATOR_VERSION) === 1 ? generateV1(opts) : generateV2(opts);
}

function generateV1(opts: SyntheticOptions): SyntheticPerson[] {
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
      const counts: Partial<Record<SignalId, number>> = {
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

/** Version 2 bundles: version 1's seven plus four more combinations of interface tastes. */
const ARCHETYPES_V2: typeof ARCHETYPES = [
  ...ARCHETYPES,
  { weight: 0.06, mean: { talk: 0.8, calm: 0.6, readable: 0.6, still: 0.5 } },
  { weight: 0.06, mean: { contrast: 0.85, readable: 0.65, still: 0.6 } },
  { weight: 0.05, mean: { visual: 0.75, billFirst: 0.7, detail: 0.35 } },
  { weight: 0.04, mean: { still: 0.85, calm: 0.6, contrast: 0.45 } },
];

function generateV2(opts: SyntheticOptions): SyntheticPerson[] {
  const rand = rng(opts.seed ^ 0x2a2a);
  const bern = (p: number) => rand() < p;
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
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
  // Gamma(2) / 2, mean 1: some people do one thing much more than their tastes alone suggest.
  const burst = () => -(Math.log(1 - rand()) + Math.log(1 - rand())) / 2;
  const totalWeight = ARCHETYPES_V2.reduce((s, a) => s + a.weight, 0);

  const people: SyntheticPerson[] = [];
  for (let n = 0; n < opts.people; n++) {
    let pick = rand() * totalWeight;
    const arch = ARCHETYPES_V2.find((a) => (pick -= a.weight) < 0) ?? ARCHETYPES_V2[0];
    const sigma = between(0.15, 0.3);
    const taste = Object.fromEntries(TASTES.map((t) => [t, clamp01((arch.mean[t] ?? BASE_TASTE) + sigma * normal())])) as Tastes;

    // Randomised assumptions; each range includes version 1's value.
    const engagement = bern(0.2) ? between(0.6, 1) : rand() ** 1.5;
    const slope = between(5, 11);
    const onset = between(0.5, 0.65);
    const adopts = (t: number) => bern(engagement * sigmoid(slope * (t - onset)));

    const textLevel = adopts(taste.readable) ? (taste.readable > 0.9 ? 3 : taste.readable > 0.78 ? 2 : 1) : 0;
    const chartUp = adopts(taste.visual);
    const billUp = adopts(taste.billFirst);
    const calmUp = adopts(taste.calm);
    const hiddenCount = calmUp || taste.calm > 0.6 ? Math.min(poisson(2.5 * taste.calm * engagement), 4) : 0;
    const hiddenWidgets = ["recent", "chart", "budget", "balance"].slice(0, hiddenCount).filter((w) => !(chartUp && w === "chart"));

    const preferences = {
      textSize: TEXT_SIZE_LEVELS[textLevel],
      contrast: adopts(taste.contrast) ? "high" : "standard",
      spacing: adopts((taste.calm + taste.readable) / 2 + 0.05) ? "roomy" : "standard",
      motion: adopts(taste.still) ? "reduced" : "system",
      theme: bern(0.22) ? "dark" : bern(0.1) ? "light" : "system", // unrelated to any taste on purpose
      targets: adopts((taste.readable + taste.talk) / 2 + 0.05) ? "large" : "standard",
      explanations: adopts(taste.guided) ? "stepByStep" : "standard",
      voiceFirst: adopts(taste.talk),
      answerStyle: adopts((taste.calm + 1 - taste.detail) / 2 + 0.05) ? "brief" : "standard",
      listenMode: adopts(taste.talk) ? (bern(0.6) ? "hold" : "continuous") : "tap",
      layout: {
        pinned: [...(chartUp ? ["chart"] : []), ...(billUp ? ["bill"] : [])],
        shown: chartUp ? ["chart"] : [],
        hidden: hiddenWidgets,
        emphasis: billUp && bern(0.5) ? "bill" : null,
        density: calmUp ? "calm" : "standard",
      },
    };

    // How strongly the chosen view follows taste varies: for some people it says little.
    const viewSimple = bern(sigmoid(between(1, 4) * (taste.calm + taste.guided + 0.5 * taste.talk - taste.detail - taste.visual)));
    const choices = bern(0.45) ? CHOICE_IDS.filter((c) => bern(0.03 + 0.9 * sigmoid(8 * (taste[CHOICE_TASTE[c]] - 0.6)))) : null;

    let signals: Signals | null = null;
    if (bern(0.6)) {
      // From version 1's weak link to engagement (coupling 0) to a strong one (coupling 1).
      const coupling = rand();
      const active = (1 - coupling) * (0.7 + 0.5 * engagement) + coupling * (0.15 + 2 * engagement);
      const count = (rate: number) => poisson(rate * burst());
      signals = {
        textLarger: count(active * 3 * Math.max(0, taste.readable - 0.35)),
        textSmaller: count(0.15 + active * 1.5 * Math.max(0, 0.4 - taste.readable)),
        voiceSessions: count(active * 5 * Math.max(0, taste.talk - 0.3)),
        lessOnScreen: count(active * 3 * Math.max(0, taste.calm - 0.35)),
        moreDetail: count(active * 3 * Math.max(0, taste.detail - 0.35) + 0.1),
        undoneChanges: poisson(0.3 + 0.4 * rand()), // noise
        readAloud: count(active * 2.5 * Math.max(0, 0.6 * taste.talk + 0.4 * taste.readable - 0.35)),
        viewSimple: count(0.1 + active * 1.5 * Math.max(0, (taste.calm + taste.guided) / 2 - 0.35)),
        viewDetailed: count(0.1 + active * 1.5 * Math.max(0, (taste.detail + taste.visual) / 2 - 0.35)),
      };
    }

    // How sharply a taste turns into "would keep it", and how sure anyone ever is, varies per person.
    const k = between(6, 12);
    const centre = between(0.5, 0.6);
    const lo = between(0, 0.08);
    const hi = between(0.88, 1);
    const labels = Object.fromEntries(
      TARGET_IDS.map((id) => {
        const keep = bern(lo + (hi - lo) * sigmoid(k * (taste[LABEL_TASTE[id]] - centre)));
        return [id, (bern(opts.labelNoise) ? !keep : keep) ? 1 : 0];
      }),
    ) as Record<TargetId, 0 | 1>;

    people.push({ input: { preferences, view: viewSimple ? "simple" : "complex", choices }, signals, labels });
  }
  return people;
}

/**
 * The people the app can actually score, as PersonalisationProvider sees them: they consented (so they have counts),
 * their settings went through the cookie's sanitize() (current schema, defaults filled in), and Make it yours ticks
 * are not passed (the provider sends choices: null). The model is trained, calibrated and evaluated on these people.
 */
export function servedPopulation(people: SyntheticPerson[]): SyntheticPerson[] {
  return people
    .filter((p) => p.signals !== null && typeof p.input.preferences?.voiceFirst === "boolean")
    .map((p) => ({ ...p, input: { preferences: sanitize(p.input.preferences), view: p.input.view, choices: null } }));
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
