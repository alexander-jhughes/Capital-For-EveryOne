// From the person's saved information to what the app does with it: their person type (from the model, or their own
// choice), why, and the adaptations. Pure, so the server, the tests and the training report all use the same code.
import { NEEDS, PERSON_TYPE_COPY, PERSON_TYPES, type NeedId, type PersonType } from "./catalog";
import { FEATURE_NAMES, FEATURE_REASONS, featureVector, type ProfileInputs } from "./features";
import { contributions, predictProba } from "./softmax";
import type { ProfileModel } from "./train";
import type { UiAction } from "../preferences/schema";

/** How Dial words answers for this person. Only wording: figures are checked by the same guard either way. */
export interface AnswerStyle {
  plain: boolean;
  brief: boolean;
  stepByStep: boolean;
  /** Calm and reassuring, never judging. */
  gentle: boolean;
}

export const NO_STYLE: AnswerStyle = { plain: false, brief: false, stepByStep: false, gentle: false };
export const hasStyle = (s: AnswerStyle) => s.plain || s.brief || s.stepByStep || s.gentle;

/** Home cards the tailored panel can show. An allowlist the client renders; nothing else can come from a profile. */
export const CARD_IDS = ["free_help", "pay_on_time", "learn_credit", "check_subscriptions", "savings_goal", "spend_pause", "what_if", "talk_to_dial"] as const;
export type CardId = (typeof CARD_IDS)[number];

export interface Adaptations {
  cards: CardId[];
  /** Dial's suggested questions, in order. Plain text the Dial panel runs through its normal, checked path. */
  dialSuggestions: string[];
  style: AnswerStyle;
  /** Mention free, impartial money advice next to answers about the bill. */
  signpost: boolean;
  /** One display change to offer as a preview. Never applied without "Keep it". */
  displayOffer: { title: string; actions: UiAction[]; mode?: "simple" | "complex" } | null;
}

export interface ProfileResult {
  /** null when the model isn't sure enough and the person hasn't chosen: the app then asks instead of guessing. */
  type: PersonType | null;
  source: "model" | "chosen" | "none";
  /** Top-class probability, 0 to 1, rounded to 2 places. */
  confidence: number;
  probabilities: Record<PersonType, number>;
  reasons: string[];
  adaptations: Adaptations;
  modelVersion: string;
}

const HELP_QUESTION = "Where can I get free help with money?";

const BY_TYPE: Record<PersonType, Omit<Adaptations, "style" | "signpost" | "displayOffer">> = {
  building: { cards: ["pay_on_time", "learn_credit"], dialSuggestions: ["When is my bill due?", "What is my minimum payment?", "Take me to the Learning Lab"] },
  steady: { cards: ["check_subscriptions", "savings_goal"], dialSuggestions: ["Has any subscription gone up?", "What did I spend this month?", "Did I pay Tesco twice this month?"] },
  stretched: { cards: ["free_help", "spend_pause"], dialSuggestions: ["What is my minimum payment?", "When is my bill due?", HELP_QUESTION] },
  life_change: { cards: ["free_help", "pay_on_time"], dialSuggestions: ["When is my bill due?", "What is my minimum payment?", HELP_QUESTION] },
  clear_simple: { cards: ["talk_to_dial", "pay_on_time"], dialSuggestions: ["When is my bill due?", "How much do I owe?", "Make everything bigger"] },
  planner: { cards: ["what_if", "savings_goal"], dialSuggestions: ["Where does most of my money go?", "What if I spend £100 less next month?", "What did I spend last month?"] },
};

const SIGNPOST_NEEDS: NeedId[] = ["money_tight", "behind_bills", "income_change", "bereavement", "money_anxiety"];

export function adaptationsFor(type: PersonType | null, needs: NeedId[]): Adaptations {
  const has = (id: NeedId) => needs.includes(id);
  const base = type ? BY_TYPE[type] : { cards: [] as CardId[], dialSuggestions: [] as string[] };
  const signpost = type === "stretched" || type === "life_change" || SIGNPOST_NEEDS.some(has);
  const style: AnswerStyle = {
    plain: type === "clear_simple" || type === "building" || has("plain_words") || has("numbers") || has("english") || has("reading"),
    brief: type === "life_change" || has("short_answers") || has("reading") || has("memory"),
    stepByStep: type === "clear_simple" || has("step_by_step") || has("digital"),
    gentle: signpost,
  };
  const cards = [...new Set<CardId>([...(signpost ? (["free_help"] as CardId[]) : []), ...base.cards])].slice(0, 3);
  const dialSuggestions = [...new Set([...base.dialSuggestions, ...(signpost ? [HELP_QUESTION] : [])])].slice(0, 4);
  const calm = type === "stretched" || type === "life_change" || type === "clear_simple" || has("reading") || has("money_anxiety");
  const displayOffer = calm
    ? {
        title: "A calmer home screen, one step at a time",
        actions: [{ type: "density", value: "calm" }, { type: "explanations", value: "stepByStep" }] as UiAction[],
        ...(type === "clear_simple" ? { mode: "simple" as const } : {}),
      }
    : type === "planner"
      ? { title: "A spending chart on your home screen", actions: [{ type: "show", widget: "chart" }] as UiAction[] }
      : null;
  return { cards, dialSuggestions, style, signpost, displayOffer };
}

const label = (id: NeedId) => NEEDS.find((n) => n.id === id)!.label;

/** Plain reasons for the chosen type: the features that pushed it up most, and only ones the person actually has. */
function reasonsFor(model: ProfileModel, x: number[], c: number): string[] {
  const parts = contributions(model, x, c)
    .map((v, j) => ({ v, name: FEATURE_NAMES[j] }))
    .filter((p) => p.v > 0.05 && x[FEATURE_NAMES.indexOf(p.name)] > 0)
    .sort((a, b) => b.v - a.v);
  const out: string[] = [];
  for (const { name } of parts) {
    const need = name.startsWith("need_") ? label(name.slice(5) as NeedId) : null;
    // "I'm new to credit cards" keeps its capital I; "Money is tight" becomes "money is tight".
    const text = need ? `You told us: ${/^I\b/.test(need) ? need : need[0].toLowerCase() + need.slice(1)}` : FEATURE_REASONS[name];
    if (text && !out.includes(text)) out.push(text);
    if (out.length === 3) break;
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function inferProfile(model: ProfileModel, input: ProfileInputs, chosen: PersonType | null = null): ProfileResult {
  const x = featureVector(input);
  const p = predictProba(model, x);
  const probabilities = Object.fromEntries(PERSON_TYPES.map((t, i) => [t, round2(p[i])])) as Record<PersonType, number>;
  const best = p.indexOf(Math.max(...p));
  const confident = p[best] >= model.threshold;
  const type = chosen ?? (confident ? PERSON_TYPES[best] : null);
  const source = chosen ? "chosen" : confident ? "model" : "none";
  const reasons = chosen ? ["You chose this yourself"] : confident ? reasonsFor(model, x, best) : [];
  return { type, source, confidence: round2(p[best]), probabilities, reasons, adaptations: adaptationsFor(type, input.needs), modelVersion: model.version };
}

/** For the person-facing panel. */
export const describeType = (t: PersonType) => PERSON_TYPE_COPY[t];
