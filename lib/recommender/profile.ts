// The optional "About you" profile. Every question is optional and every answer can be skipped.
//
// What the profile is: things a person chooses to tell Dial about how they like to use a money app.
// What it is not: a record of who they are. It never asks about health, disability, income, debt or anything
// financial about their situation, and nothing here is ever inferred. Accessibility settings (text size,
// contrast, motion, button size) are not asked here: they are set directly in Display and voice, and those
// explicit settings always win over any suggestion.
//
// Demographic research answers (`ResearchAnswers`) are a separate type with separate consent. They are never
// part of `ProfileAnswers` and never reach the recommender: they are used only for aggregate fairness checks.

export const PROFILE_VERSION = 1;

export const PROFILE_SECTIONS = [
  { id: "experience", title: "Money and apps" },
  { id: "interaction", title: "How you like to use Dial" },
  { id: "accessibility", title: "Accessibility" },
] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number]["id"];

interface QuestionDef<V extends string> {
  id: string;
  section: ProfileSection;
  label: string;
  options: readonly { value: V; label: string }[];
}

const q = <const V extends string>(def: QuestionDef<V>) => def;

export const QUESTIONS = [
  q({
    id: "creditFamiliarity",
    section: "experience",
    label: "How familiar are you with credit cards?",
    options: [
      { value: "new", label: "I'm new to them" },
      { value: "some", label: "I know the basics" },
      { value: "confident", label: "I'm confident with them" },
    ],
  }),
  q({
    id: "budgetingFamiliarity",
    section: "experience",
    label: "How familiar are you with budgeting?",
    options: [
      { value: "new", label: "I'm new to it" },
      { value: "some", label: "I know the basics" },
      { value: "confident", label: "I'm confident with it" },
    ],
  }),
  q({
    id: "appConfidence",
    section: "experience",
    label: "How confident do you feel using money apps?",
    options: [
      { value: "low", label: "Not very confident" },
      { value: "medium", label: "Fairly confident" },
      { value: "high", label: "Very confident" },
    ],
  }),
  q({
    id: "detailLevel",
    section: "experience",
    label: "How much financial detail do you like to see?",
    options: [
      { value: "keyFacts", label: "Just the key facts" },
      { value: "some", label: "Some detail" },
      { value: "everything", label: "All the detail" },
    ],
  }),
  q({
    id: "inputMode",
    section: "interaction",
    label: "Do you prefer talking, or typing and tapping?",
    options: [
      { value: "voice", label: "Talking" },
      { value: "touch", label: "Typing and tapping" },
      { value: "either", label: "Either is fine" },
    ],
  }),
  q({
    id: "explanationFormat",
    section: "interaction",
    label: "How do you like things explained?",
    options: [
      { value: "visual", label: "With charts and pictures" },
      { value: "written", label: "In words" },
      { value: "both", label: "A mix of both" },
    ],
  }),
  q({
    id: "answerLength",
    section: "interaction",
    label: "Do you prefer short or detailed answers?",
    options: [
      { value: "short", label: "Short" },
      { value: "detailed", label: "Detailed" },
    ],
  }),
  q({
    id: "guidance",
    section: "interaction",
    label: "Do you like to be guided, or to find your own way?",
    options: [
      { value: "guided", label: "Guide me step by step" },
      { value: "independent", label: "I'll find my own way" },
    ],
  }),
  q({
    id: "screenComplexity",
    section: "interaction",
    label: "How much would you like on your home screen?",
    options: [
      { value: "minimal", label: "As little as possible" },
      { value: "balanced", label: "A balance" },
      { value: "everything", label: "Everything at once" },
    ],
  }),
  q({
    id: "priority",
    section: "interaction",
    label: "What would you most like to see first?",
    options: [
      { value: "payments", label: "Upcoming payments" },
      { value: "spending", label: "Where my money goes" },
      { value: "budget", label: "How I'm doing against my budget" },
      { value: "transactions", label: "Recent transactions" },
    ],
  }),
  q({
    id: "screenReader",
    section: "accessibility",
    label: "Do you use a screen reader?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  }),
] as const;

export type Question = (typeof QUESTIONS)[number];
export type QuestionId = Question["id"];
type ValueOf<Q> = Q extends { options: readonly { value: infer V }[] } ? V : never;

/** Answers the person chose to give. A missing key means "skipped" or "prefer not to say". */
export type ProfileAnswers = { [Q in Question as Q["id"]]?: ValueOf<Q> };

export const QUESTION_IDS = QUESTIONS.map((x) => x.id) as QuestionId[];
export const questionById = (id: QuestionId) => QUESTIONS.find((x) => x.id === id)!;

/** Rebuilds answers from untrusted input, keeping only known questions and allowed values. */
export function sanitizeAnswers(input: unknown): ProfileAnswers {
  const o = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const question of QUESTIONS) {
    const v = o[question.id];
    if (typeof v === "string" && question.options.some((opt) => opt.value === v)) out[question.id] = v;
  }
  return out as ProfileAnswers;
}

/** True if the input was already clean (used by APIs to reject, rather than silently drop, bad answers). */
export function isValidAnswers(input: unknown): input is ProfileAnswers {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const clean = sanitizeAnswers(input);
  return Object.keys(input).length === Object.keys(clean).length;
}

export const answeredCount = (a: ProfileAnswers) => Object.keys(a).length;

/** The label of an answer, for explanations: "You said: Just the key facts". */
export function answerLabel(id: QuestionId, value: string): string | null {
  return questionById(id).options.find((o) => o.value === value)?.label ?? null;
}

// --- Optional demographic research data: separate consent, separate storage, never used to recommend. ---

export const AGE_BANDS = ["18-24", "25-34", "35-49", "50-64", "65+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export interface ResearchAnswers {
  ageBand?: AgeBand;
}

export function sanitizeResearch(input: unknown): ResearchAnswers {
  const o = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  return (AGE_BANDS as readonly unknown[]).includes(o.ageBand) ? { ageBand: o.ageBand as AgeBand } : {};
}
