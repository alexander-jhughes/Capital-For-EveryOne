// The only numbers the profile model sees. An allowlist: anything not built here can't reach the model.
// Each feature is in [0, 1]. Money features are ratios and yes/no flags worked out on the server from the person's
// saved account; no amount, merchant or transaction ever goes into the vector.
import { NEED_IDS, type NeedId } from "./catalog";

export const USAGE_KINDS = ["dial", "learn", "whatIf", "goals", "detailed"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export type Usage = Record<UsageKind, number>;
/** Counts stop here, so a busy week can't dominate. */
export const USAGE_CAP = 10;
export const emptyUsage = (): Usage => ({ dial: 0, learn: 0, whatIf: 0, goals: 0, detailed: 0 });

/** Everything the profile model may know, already reduced to safe shapes. */
export interface ProfileInputs {
  /** currentBalance / creditLimit, or null when there's no limit. */
  utilisation: number | null;
  payments: { kind: "minimum" | "statement" | "custom" }[];
  goalKinds: string[];
  spendPauseOn: boolean;
  simpleView: boolean;
  needs: NeedId[];
  usage: Usage;
}

const ACCOUNT_FEATURES = ["util", "util_high", "paid_full", "paid_min_only", "no_payment", "goal_save", "goal_debt", "goal_on_time", "goal_spend", "pause_on", "simple_view"] as const;
const USAGE_FEATURES = USAGE_KINDS.map((k) => `use_${k}` as const);
const NEED_FEATURES = NEED_IDS.map((id) => `need_${id}` as const);

export const FEATURE_NAMES = [...ACCOUNT_FEATURES, ...USAGE_FEATURES, ...NEED_FEATURES] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const flag = (b: boolean) => (b ? 1 : 0);
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function featureVector(input: ProfileInputs): number[] {
  const util = input.utilisation ?? 0;
  const kinds = input.payments.map((p) => p.kind);
  const goals = new Set(input.goalKinds);
  const account: Record<(typeof ACCOUNT_FEATURES)[number], number> = {
    util: clamp01(util),
    util_high: flag(util >= 0.75),
    paid_full: flag(kinds.includes("statement")),
    paid_min_only: flag(kinds.length > 0 && kinds.every((k) => k === "minimum")),
    no_payment: flag(kinds.length === 0),
    goal_save: flag(goals.has("save_up")),
    goal_debt: flag(goals.has("pay_down") || goals.has("utilisation")),
    goal_on_time: flag(goals.has("pay_on_time")),
    goal_spend: flag(goals.has("category_cap") || goals.has("spend_reduction") || goals.has("stay_in_budget")),
    pause_on: flag(input.spendPauseOn),
    simple_view: flag(input.simpleView),
  };
  const needs = new Set(input.needs);
  return [
    ...ACCOUNT_FEATURES.map((f) => account[f]),
    ...USAGE_KINDS.map((k) => clamp01((input.usage[k] ?? 0) / USAGE_CAP)),
    ...NEED_IDS.map((id) => flag(needs.has(id))),
  ];
}

/** Why a feature pushed the model one way, in the person's terms. Only shown when the feature is actually present. */
export const FEATURE_REASONS: Partial<Record<FeatureName, string>> = {
  util_high: "You're using most of your credit limit",
  paid_full: "You paid your full bill",
  paid_min_only: "Your payments so far were the minimum",
  goal_save: "You set a savings goal",
  goal_debt: "You set a goal to pay down your balance",
  goal_on_time: "You set a goal to pay on time",
  goal_spend: "You set a spending goal",
  pause_on: "You turned on Spend Pause",
  simple_view: "You use Simple view",
  use_dial: "You often ask Dial things",
  use_learn: "You've used the Learning Lab",
  use_whatIf: "You've tried what-if sums",
  use_goals: "You check your goals",
  use_detailed: "You often use Detailed view",
};
