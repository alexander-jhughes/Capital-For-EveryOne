// Understands a person describing their situation ("I have trouble seeing at night") by meaning, not keywords.
//
//   text ─► clauses ─► sentence embeddings (on the device) ─► nearest examples in the catalogue ─► situations + scope
//
// Pure apart from the `embed` function it is given, so it runs the same in the browser (Transformers.js, WASM) and in
// tests (Transformers.js, Node). Nothing is sent anywhere. A sentence is only treated as a situation when it is clearly
// closer to a situation's examples than to money questions or direct commands; anything less certain is left to the
// precise on-device rules and, after that, to the cloud model, which may only name a situation from the catalogue.
import { NOT_A_SITUATION, SITUATION_IDS, SITUATIONS, situationById, type Change, type Scope, type SituationId } from "./catalogue";
import { NIGHT_SETTINGS, type NightAction, type UiAction } from "../preferences/schema";

/** Turns sentences into unit-length vectors (cosine similarity is then a dot product). */
export type Embed = (texts: string[]) => Promise<Float32Array[]>;

export type Label = SituationId | "none:money" | "none:command";

export interface ExampleIndex {
  labels: Label[];
  vectors: Float32Array[];
}

/**
 * Tuned by leave-one-out over the catalogue's own examples (scripts/access/evaluate.ts), never on the test set.
 * accept/margin: confident enough to offer on the device. maybe/maybeMargin: offered only when the precise rules found
 * nothing else to do with the sentence, and worded as a question. margin is the gap to the nearest money question or
 * direct command, which is where a wrong guess would hijack a request.
 */
export const THRESHOLDS = { accept: 0.5, margin: 0.1, maybe: 0.4, maybeMargin: 0.05, topK: 3 } as const;

/** Every example sentence with its label, in a fixed order (the index is built from exactly this list). */
export function exampleList(): { label: Label; text: string }[] {
  return [
    ...SITUATIONS.flatMap((s) => s.examples.map((text) => ({ label: s.id as Label, text }))),
    ...NOT_A_SITUATION.money.map((text) => ({ label: "none:money" as Label, text })),
    ...NOT_A_SITUATION.command.map((text) => ({ label: "none:command" as Label, text })),
  ];
}

export async function buildIndex(embed: Embed): Promise<ExampleIndex> {
  const list = exampleList();
  return { labels: list.map((e) => e.label), vectors: await embed(list.map((e) => e.text)) };
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Each label's score: the mean similarity of its `topK` closest examples. Highest first. */
export function scoreLabels(vec: Float32Array, index: ExampleIndex, topK: number = THRESHOLDS.topK): { label: Label; score: number }[] {
  const byLabel = new Map<Label, number[]>();
  index.vectors.forEach((v, i) => {
    const list = byLabel.get(index.labels[i]) ?? [];
    list.push(dot(vec, v));
    byLabel.set(index.labels[i], list);
  });
  return [...byLabel.entries()]
    .map(([label, sims]) => {
      const top = sims.sort((a, b) => b - a).slice(0, topK);
      return { label, score: top.reduce((s, x) => s + x, 0) / top.length };
    })
    .sort((a, b) => b.score - a.score);
}

const isSituation = (l: Label): l is SituationId => !l.startsWith("none:");

/** Lower case, plain words, single spaces. */
const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/** "I have arthritis and it's hard to see at night" -> two parts, each judged on its own. */
export function clauses(text: string): string[] {
  const parts = text
    .split(/[,;.!?]+|\s+(?:and|but|also|plus|as well as)\s+/i)
    .map((p) => p.trim().replace(/^(?:and|but|also|plus|so)\s+/i, ""))
    .filter((p) => norm(p).split(" ").length >= 2);
  return parts.length > 1 ? parts : [text.trim()];
}

/**
 * "I'm not colour blind" is not a situation. Narrow on purpose: only a denial of a named condition counts, so "I can't
 * see at night" and "I'm not fluent in English" are not negations.
 */
export const NEGATED =
  /\b(i'?m not|i am not|im not|i don'?t have|i do not have|i'?m no longer|i no longer have|i haven'?t got|i'?ve not got)( a| an| any)? (colou?r ?blind|blind|deaf|dyslexic|dyslexia|disabled|partially sighted|visually impaired|hard of hearing|adhd|autistic|arthritis|dementia|a tremor|tremors|migraines?|sight loss|hearing loss)\b/;

/** Time words are a closed set, so plain rules are the right tool here. */
export function detectScope(text: string): Scope | null {
  const s = ` ${norm(text)} `;
  if (/ (at night|night time|nighttime|in the evening|in the evenings|evenings|after dark|in the dark|when it's dark|when its dark|late at night|in bed|at bedtime|bedtime|before bed) /.test(s)) return "night";
  if (/ (right now|for now|just now|today|at the moment|for the moment|on the bus|on the train|outside|outdoors|in the sun|this time|temporarily|for a bit|for a while) /.test(s)) return "now";
  if (/ (always|every time|all the time|permanently|from now on|for good) /.test(s)) return "always";
  return null;
}

export type Understanding =
  | {
      kind: "situations";
      situations: SituationId[];
      scope: Scope;
      /** Each situation's best similarity, for the evaluation report and the developer view. */
      scores: Partial<Record<SituationId, number>>;
      /** "sure": offer straight away. "maybe": offer only if nothing else understood the sentence, as a question. */
      confidence: "sure" | "maybe";
    }
  | { kind: "none"; reason: "empty" | "money" | "command" | "unsure" | "negated"; best?: { label: Label; score: number } };

export interface Judgement {
  label: Label;
  score: number;
  margin: number;
  /** Confident: offered straight away. */
  accepted: boolean;
  /** Probably: offered only if nothing else understood the sentence. */
  maybe: boolean;
}

/** Whether one clause is clearly a situation: close to its examples, and clearly closer than to anything else. */
export function judge(scores: { label: Label; score: number }[]): Judgement {
  const best = scores[0];
  // Two situations scoring close together is fine (both can apply). What matters is the gap to the nearest
  // money question or direct command, because that is where a wrong guess would hijack the request.
  const nearestNonSituation = scores.find((s) => !isSituation(s.label))?.score ?? 0;
  const margin = isSituation(best.label) ? best.score - nearestNonSituation : 0;
  const accepted = isSituation(best.label) && best.score >= THRESHOLDS.accept && margin >= THRESHOLDS.margin;
  const maybe = !accepted && isSituation(best.label) && best.score >= THRESHOLDS.maybe && margin >= THRESHOLDS.maybeMargin;
  return { label: best.label, score: best.score, margin, accepted, maybe };
}

/** The whole pipeline for one utterance. Never throws on odd input; an embedding failure is the caller's to handle. */
export async function understand(text: string, embed: Embed, index: ExampleIndex): Promise<Understanding> {
  const trimmed = text.trim().slice(0, 300);
  if (norm(trimmed).length === 0) return { kind: "none", reason: "empty" };

  const parts = clauses(trimmed);
  const checked = parts.filter((p) => !NEGATED.test(norm(p)));
  if (checked.length === 0) return { kind: "none", reason: "negated" };

  const vectors = await embed(checked);
  const sure = new Map<SituationId, number>();
  const maybe = new Map<SituationId, number>();
  let best: { label: Label; score: number } | undefined;
  for (const vec of vectors) {
    const j = judge(scoreLabels(vec, index));
    if (!best || j.score > best.score) best = { label: j.label, score: j.score };
    if (!isSituation(j.label)) continue;
    if (j.accepted) sure.set(j.label, Math.max(sure.get(j.label) ?? 0, j.score));
    else if (j.maybe) maybe.set(j.label, Math.max(maybe.get(j.label) ?? 0, j.score));
  }
  const found = sure.size > 0 ? sure : maybe;
  if (found.size === 0) {
    const reason = best?.label === "none:money" ? "money" : best?.label === "none:command" ? "command" : "unsure";
    return { kind: "none", reason, best };
  }
  const situations = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 3);
  return { kind: "situations", situations, scope: scopeFor(trimmed, situations), scores: Object.fromEntries(found), confidence: sure.size > 0 ? "sure" : "maybe" };
}

/** Time words win. Otherwise the first situation's usual scope ("at night" for night vision, "for now" for sunlight). */
export function scopeFor(text: string, situations: SituationId[]): Scope {
  return detectScope(text) ?? situationById(situations[0]).defaultScope;
}

/** A key per setting, so two situations that both change contrast don't fight: the first one heard wins. */
const settingKey = (a: UiAction) => ("widget" in a ? `${a.type}:${a.widget}` : a.type);

/** The changes for these situations, merged in order, one per setting, each with its reason. */
export function changesFor(situations: SituationId[]): Change[] {
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const id of situations) {
    for (const c of situationById(id).changes) {
      const key = settingKey(c.action);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

const isNightAction = (a: UiAction): a is NightAction => (NIGHT_SETTINGS as readonly string[]).includes(a.type);

/**
 * How the changes are kept for a scope. With "night", what the screen looks like becomes the night look (only between
 * 7pm and 7am) and anything else, like ignoring double taps, is kept all day: it isn't about the light.
 */
export function planKeep(changes: Change[], scope: Scope): { now: UiAction[]; night: NightAction[] } {
  if (scope !== "night") return { now: changes.map((c) => c.action), night: [] };
  const night = changes.map((c) => c.action).filter(isNightAction);
  const now = changes.map((c) => c.action).filter((a) => !isNightAction(a));
  return { now, night };
}

export const isSituationId = (v: unknown): v is SituationId => SITUATION_IDS.includes(v as SituationId);
