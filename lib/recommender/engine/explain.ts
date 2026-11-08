// Explanations. Each reason is about the person's own choices ("You said …", "You chose …", "You've opened …"),
// taken from the largest positive per-feature contributions of the content model, plus at most one line about
// similar people. Never a statement about who someone is, never the accessibility answer, never a count of
// other people.
import { CATALOG, type ItemId } from "../catalog";
import type { Reason } from "../types";
import { FEATURE_COUNT, FEATURES } from "./features";
import { safeLogit } from "./math";
import type { RecommenderModel } from "./model";
import type { PreparedModel, RawScores } from "./score";

/** Content contributions smaller than this (log-odds) are noise, not a reason. */
export const MIN_CONTRIBUTION = 0.1;
export const MAX_CONTENT_REASONS = 3;
/** The "similar people" line needs at least this much support (and is never a count). */
export const MIN_DISCLOSURE = 20;

export const SIMILAR_PEOPLE_TEXT = {
  synthetic: "In Dial's practice data (made-up examples, not real people), most profiles with answers like yours kept this",
  real: "Most people with similar answers who tried this kept it",
} as const;

const KIND: Record<string, Reason["kind"] | null> = {
  answer: "answer",
  setting: "setting",
  signal: "signal",
  history: "history",
  section: null,
  explicit: null,
};

/** Reasons for one item, strongest first. */
export function itemReasons(model: RecommenderModel, p: PreparedModel, raw: RawScores, item: number): Reason[] {
  const contributions: Reason[] = [];
  const base = item * FEATURE_COUNT;
  for (let f = 0; f < FEATURE_COUNT; f++) {
    const x = raw.x[f];
    if (x === 0) continue;
    const c = p.contentW[base + f] * x;
    if (c < MIN_CONTRIBUTION) continue;
    const def = FEATURES[f];
    const kind = KIND[def.group];
    const text = kind ? def.describe(x) : null;
    if (kind && text) contributions.push({ kind, text, weight: round3(c) });
  }
  contributions.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  const reasons = contributions.slice(0, MAX_CONTENT_REASONS);
  const collab = raw.collaborative[item];
  const prior = p.prior[item];
  if (raw.support[item] >= MIN_DISCLOSURE && collab >= 0.5 && collab > prior) {
    reasons.push({
      kind: "similar_people",
      text: model.trainedOn === "synthetic" ? SIMILAR_PEOPLE_TEXT.synthetic : SIMILAR_PEOPLE_TEXT.real,
      weight: round3(safeLogit(collab) - safeLogit(prior)),
    });
  }
  return reasons;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

const joinAnd = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

const SOURCE_TEXT: Record<Reason["kind"], string> = {
  answer: "your answers in About you",
  setting: "your current settings",
  signal: "how you've used Dial",
  history: "suggestions you kept before",
  similar_people: "",
};

/** Summary and reasons for a whole configuration. */
export function configurationExplanation(
  model: RecommenderModel,
  title: string,
  items: readonly ItemId[],
  reasonsByItem: ReadonlyMap<ItemId, Reason[]>,
): { summary: string; reasons: string[] } {
  const all = items.flatMap((id) => reasonsByItem.get(id) ?? []);
  const personal = all.filter((r) => r.kind !== "similar_people").sort((a, b) => b.weight - a.weight);
  const texts = [...new Set(personal.map((r) => r.text))].slice(0, 4);
  const similar = all.find((r) => r.kind === "similar_people");
  if (similar) texts.push(similar.text);
  const kinds = [...new Set(personal.map((r) => r.kind))].sort((a, b) => order(a) - order(b));
  const sources = kinds.map((k) => SOURCE_TEXT[k]);
  if (similar) sources.push(model.trainedOn === "synthetic" ? "Dial's practice data" : "people with similar answers");
  const what = items.length === 1 ? CATALOG[items[0]].title : title;
  const summary = sources.length
    ? `${what} may make Dial easier for you. Suggested from ${joinAnd(sources)}.`
    : `${what} may make Dial easier for you.`;
  return { summary, reasons: texts };
}

const order = (k: Reason["kind"]) => ["answer", "setting", "signal", "history", "similar_people"].indexOf(k);

export const NO_SUGGESTION_TEXT = {
  insufficient_data: "Dial doesn't know enough yet to suggest a change. Answering a few questions in About you helps.",
  no_recommendation: "No suggestion right now: nothing Dial could suggest is a confident enough fit.",
  unavailable: "Suggestions aren't available right now. Everything else works as usual.",
} as const;
