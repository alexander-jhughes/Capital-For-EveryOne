// SYNTHETIC TRAINING DATA. No real person's data is used anywhere in this model.
//
// Each synthetic person has one person type (the label: the type they would pick for themselves if shown all six).
// From the type we simulate, with noise, overlap and missing data:
//   - their account behaviour (how much of the limit they use, how they paid, which goals they set, Spend Pause),
//   - what they ticked on "About you" (many people tick nothing, and health needs need the extra consent),
//   - how often they use parts of the app.
// The model sees only those observable features, never the generator's probabilities.
// Because we wrote the generator, good scores show the pipeline works, NOT that it predicts real people.
// See docs/profile-model/README.md, "Limitations".
import { rng } from "../personalisation/forest";
import { isSensitive, NEED_IDS, PERSON_TYPES, type NeedId, type PersonType } from "./catalog";
import { emptyUsage, USAGE_KINDS, type ProfileInputs, type UsageKind } from "./features";

export const SYNTHETIC_GENERATOR_VERSION = 1;

interface TypeSpec {
  weight: number;
  /** Utilisation range: uniform between the two. */
  util: [number, number];
  pay: { statement: number; minimum: number; none: number };
  goals: Partial<Record<"save_up" | "pay_down" | "pay_on_time" | "category_cap", number>>;
  pause: number;
  simple: number;
  needs: Partial<Record<NeedId, number>>;
  usage: Partial<Record<UsageKind, number>>;
}

const SPECS: Record<PersonType, TypeSpec> = {
  building: {
    weight: 0.17,
    // Starter cards have low limits, so people new to credit often use a lot of a small limit.
    util: [0.05, 0.85],
    pay: { statement: 0.25, minimum: 0.25, none: 0.5 },
    goals: { pay_on_time: 0.35, save_up: 0.1 },
    pause: 0.1,
    simple: 0.4,
    needs: { new_to_credit: 0.7, numbers: 0.25, plain_words: 0.35, english: 0.1 },
    usage: { learn: 4, dial: 2 },
  },
  steady: {
    weight: 0.2,
    util: [0, 0.35],
    pay: { statement: 0.7, minimum: 0.05, none: 0.25 },
    goals: { save_up: 0.45, category_cap: 0.15 },
    pause: 0.08,
    simple: 0.3,
    needs: { short_answers: 0.25 },
    usage: { detailed: 3, goals: 2, dial: 1 },
  },
  stretched: {
    weight: 0.18,
    util: [0.55, 1],
    pay: { statement: 0.05, minimum: 0.55, none: 0.4 },
    goals: { pay_down: 0.3, category_cap: 0.15 },
    pause: 0.35,
    simple: 0.45,
    needs: { money_tight: 0.6, behind_bills: 0.35, irregular_income: 0.25, income_change: 0.2, money_anxiety: 0.3, short_answers: 0.25 },
    usage: { dial: 2, goals: 1 },
  },
  life_change: {
    weight: 0.12,
    util: [0.2, 0.8],
    pay: { statement: 0.25, minimum: 0.35, none: 0.4 },
    goals: { pay_on_time: 0.15 },
    pause: 0.15,
    simple: 0.5,
    needs: { bereavement: 0.3, income_change: 0.35, caring: 0.3, relationship: 0.25, money_anxiety: 0.3, money_tight: 0.3, short_answers: 0.3, step_by_step: 0.2, memory: 0.15 },
    usage: { dial: 1 },
  },
  clear_simple: {
    weight: 0.18,
    util: [0.1, 0.7],
    pay: { statement: 0.3, minimum: 0.3, none: 0.4 },
    goals: { pay_on_time: 0.2 },
    pause: 0.15,
    simple: 0.8,
    needs: { reading: 0.35, memory: 0.3, sight_hearing: 0.2, numbers: 0.4, english: 0.25, digital: 0.4, plain_words: 0.55, step_by_step: 0.5, short_answers: 0.3 },
    usage: { dial: 3 },
  },
  planner: {
    weight: 0.15,
    util: [0.1, 0.6],
    pay: { statement: 0.45, minimum: 0.1, none: 0.45 },
    goals: { pay_down: 0.3, category_cap: 0.5, save_up: 0.3 },
    pause: 0.12,
    simple: 0.1,
    needs: {},
    usage: { whatIf: 5, detailed: 5, goals: 3, dial: 2 },
  },
};

const BASE_NEED = 0.03;
/** Share of people who tick nothing at all on "About you". */
const SILENT_SHARE = 0.4;
/** Of those who tick things, the share who also give the extra consent for health needs. */
const SENSITIVE_CONSENT = 0.7;
/** Share of labels replaced by a random type: people don't always pick the type their behaviour suggests. */
const LABEL_NOISE = 0.08;

export interface SyntheticPerson {
  input: ProfileInputs;
  label: PersonType;
}

function pick<T extends string>(random: () => number, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = random() * total;
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries[entries.length - 1][0];
}

/** A count around `mean` (0 when unset): uniform on [0, 2 x mean], which is noisy on purpose. */
const count = (random: () => number, mean = 0.3) => Math.min(10, Math.floor(random() * 2 * mean + 0.5 * random()));

export function generatePerson(random: () => number): SyntheticPerson {
  const type = pick(random, Object.fromEntries(PERSON_TYPES.map((t) => [t, SPECS[t].weight])) as Record<PersonType, number>);
  const s = SPECS[type];
  const util = s.util[0] + random() * (s.util[1] - s.util[0]);
  const pay = pick(random, s.pay);
  const payments = pay === "none" ? [] : random() < 0.3 ? [{ kind: pay }, { kind: "custom" as const }] : [{ kind: pay }];
  const goalKinds = Object.entries(s.goals).filter(([, p]) => random() < (p as number)).map(([k]) => k);
  if (random() < 0.04) goalKinds.push("stay_in_budget");

  const silent = random() < SILENT_SHARE;
  const sensitiveOk = random() < SENSITIVE_CONSENT;
  const needs = silent ? [] : NEED_IDS.filter((id) => (isSensitive(id) ? sensitiveOk : true) && random() < (s.needs[id] ?? BASE_NEED));

  const usage = emptyUsage();
  for (const k of USAGE_KINDS) usage[k] = count(random, s.usage[k]);

  const label = random() < LABEL_NOISE ? PERSON_TYPES[Math.floor(random() * PERSON_TYPES.length)] : type;
  return {
    input: { utilisation: util, payments, goalKinds, spendPauseOn: random() < s.pause, simpleView: random() < s.simple, needs, usage },
    label,
  };
}

export function generateDataset(n: number, seed: number): SyntheticPerson[] {
  const random = rng(seed);
  return Array.from({ length: n }, () => generatePerson(random));
}
