// WS2: feature encoding. One encoding for training and inference, so the model never sees a different input.
//
// Allowlist only. The model reads exactly these parts of `RecommenderInput` and nothing else, even if the object
// it is given carries more (an age band, transactions, a conversation): unknown fields are never touched.
//   answers   one-hot per option of every "About you" question (a skipped question is all zeros), plus one
//             "answered something in this section" indicator per section
//   settings  one binary per catalog item: is it already in effect (catalog `isActive`). This includes the view.
//   explicit  one binary per dimension the person set themselves
//   signals   counts of explicit interface actions, log1p(min(n, SIGNAL_CAP)) / log1p(SIGNAL_CAP)
//   history   how many earlier suggestions this person kept, turned down or undid (capped, log-scaled, no item ids)
//
// Each feature carries a plain-English description of the person's own choice, used for explanations, and a
// similarity weight used by the collaborative component (lib/recommender/engine/similarity.ts).
import { sanitize, type Preferences } from "../../preferences/schema";
import type { Mode } from "../../types";
import { CATALOG, DIMENSIONS, type Dimension, isActive, isDimension, isItemId, ITEM_IDS, type ItemId } from "../catalog";
import { PROFILE_SECTIONS, type ProfileAnswers, type ProfileSection, type QuestionId, QUESTIONS, sanitizeAnswers } from "../profile";
import { type HistoryEntry, type RecommenderInput, SIGNAL_CAP, SIGNAL_IDS, type SignalId } from "../types";

export type FeatureGroup = "answer" | "section" | "setting" | "explicit" | "signal" | "history";

export interface FeatureDef {
  id: string;
  group: FeatureGroup;
  /** Weight in the collaborative similarity (0 = not used for "people like you"). */
  similarityWeight: number;
  /** Plain-English reason for a positive value, about the person's own choice. Null: never shown as a reason. */
  describe: (value: number) => string | null;
}

/** History counts are capped like signals: a long history should not dominate. */
export const HISTORY_CAP = 5;
export const HISTORY_OUTCOMES = ["accepted", "rejected", "reverted"] as const;

/** How each question is referred to in an explanation. The accessibility question is never quoted back. */
const ASKED: Record<Exclude<QuestionId, "screenReader">, string> = {
  creditFamiliarity: "about credit cards",
  budgetingFamiliarity: "about budgeting",
  appConfidence: "about using money apps",
  detailLevel: "how much financial detail you like to see",
  inputMode: "whether you prefer talking or typing and tapping",
  explanationFormat: "how you like things explained",
  answerLength: "whether you prefer short or detailed answers",
  guidance: "whether you like to be guided",
  screenComplexity: "how much you'd like on your home screen",
  priority: "what you'd most like to see first",
};

/** What a setting already in effect says about the person's own choices. */
const SETTING_TEXT: Record<ItemId, string> = {
  "view.simple": "You use Simple view",
  "view.detailed": "You use Detailed view",
  "density.calm": "You chose less on your home screen",
  "textSize.125": "You chose larger text",
  "textSize.150": "You chose much larger text",
  "contrast.high": "You chose stronger contrast",
  "spacing.roomy": "You chose more space between things",
  "motion.reduced": "You chose less animation",
  "targets.large": "You chose bigger buttons",
  "explanations.stepByStep": "You chose step-by-step explanations",
  "voiceFirst.on": "You made talking to Dial the first option",
  "homeFocus.bill": "You put your bill at the top of your home screen",
  "homeFocus.chart": "You put your spending chart at the top of your home screen",
  "homeFocus.budget": "You put spending this month at the top of your home screen",
  "homeFocus.recent": "You put recent transactions at the top of your home screen",
  "homeFocus.insights": "You put what Dial noticed at the top of your home screen",
};

const SIGNAL_TEXT: Record<SignalId, string> = {
  textLarger: "You made the text bigger",
  textSmaller: "You made the text smaller",
  lessOnScreen: "You asked for less on screen",
  moreDetail: "You asked for more detail",
  moreVisual: "You brought the spending chart forward",
  voiceSessions: "You've opened Voice Mode",
  shorterAnswers: "You asked for shorter answers",
  undoneChanges: "You undid a display change",
};

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

const SIGNAL_SCALE = Math.log1p(SIGNAL_CAP);
const HISTORY_SCALE = Math.log1p(HISTORY_CAP);
/** Encoded count back to a whole count, for explanations. */
const decodeCount = (v: number, scale: number) => Math.round(Math.expm1(v * scale));

function buildFeatures(): FeatureDef[] {
  const defs: FeatureDef[] = [];
  for (const q of QUESTIONS) {
    for (const o of q.options) {
      const asked = q.id === "screenReader" ? null : ASKED[q.id];
      const text = asked ? `You said "${o.label}" when asked ${asked}` : null;
      defs.push({ id: `answer.${q.id}.${o.value}`, group: "answer", similarityWeight: 1, describe: (v) => (v > 0 ? text : null) });
    }
  }
  for (const s of PROFILE_SECTIONS) defs.push({ id: `section.${s.id}`, group: "section", similarityWeight: 0, describe: () => null });
  for (const item of ITEM_IDS) {
    // The view is always one of two values, so it says little about who is similar: left out of similarity.
    const weight = CATALOG[item].dimension === "view" ? 0 : 1;
    defs.push({ id: `active.${item}`, group: "setting", similarityWeight: weight, describe: (v) => (v > 0 ? SETTING_TEXT[item] : null) });
  }
  for (const d of DIMENSIONS) defs.push({ id: `explicit.${d}`, group: "explicit", similarityWeight: 0.25, describe: () => null });
  for (const s of SIGNAL_IDS) {
    defs.push({
      id: `signal.${s}`,
      group: "signal",
      similarityWeight: 0.25,
      describe: (v) => {
        const n = decodeCount(v, SIGNAL_SCALE);
        if (n < 1) return null;
        return `${SIGNAL_TEXT[s]} ${n >= SIGNAL_CAP ? `${SIGNAL_CAP} or more times` : times(n)}`;
      },
    });
  }
  for (const h of HISTORY_OUTCOMES) {
    defs.push({
      id: `history.${h}`,
      group: "history",
      similarityWeight: 0,
      describe: (v) => {
        if (h !== "accepted") return null; // turning something down is never quoted back as a reason
        const n = decodeCount(v, HISTORY_SCALE);
        if (n < 1) return null;
        return n === 1 ? "You kept an earlier suggestion" : `You kept ${n >= HISTORY_CAP ? `${HISTORY_CAP} or more` : n} earlier suggestions`;
      },
    });
  }
  // How many separate times suggestions were shown (novelty wears off, fatigue builds up). Never quoted back.
  defs.push({ id: "history.rounds", group: "history", similarityWeight: 0, describe: () => null });
  return defs;
}

export const FEATURES: readonly FeatureDef[] = buildFeatures();
export const FEATURE_IDS: readonly string[] = FEATURES.map((f) => f.id);
export const FEATURE_COUNT = FEATURES.length;

const indexOf = new Map(FEATURE_IDS.map((id, i) => [id, i] as const));
export function featureIndex(id: string): number {
  const i = indexOf.get(id);
  if (i === undefined) throw new Error(`Unknown feature ${id}`);
  return i;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalised input: everything the engine (model and policy) reads, rebuilt from untrusted input.
// ---------------------------------------------------------------------------------------------------------------

export interface NormalisedInput {
  answers: ProfileAnswers;
  answered: number;
  preferences: Preferences;
  view: Mode | null;
  /** As given by the caller (what the model was trained on). */
  explicit: Set<Dimension>;
  signals: Record<SignalId, number>;
  /** Valid entries only, newest last, at most MAX_HISTORY. */
  history: HistoryEntry[];
}

export const MAX_HISTORY = 200;
const OUTCOMES = new Set(["accepted", "rejected", "reverted", "dismissed"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads only allowlisted fields. Never throws. */
export function normaliseInput(input: unknown): NormalisedInput {
  const o = isObj(input) ? input : {};
  const answers = sanitizeAnswers(o.answers);
  const preferences = sanitize(o.preferences);
  const view: Mode | null = o.view === "simple" || o.view === "complex" ? o.view : null;
  const explicit = new Set<Dimension>(Array.isArray(o.explicit) ? o.explicit.filter(isDimension) : []);
  const rawSignals = isObj(o.signals) ? o.signals : {};
  const signals = {} as Record<SignalId, number>;
  for (const id of SIGNAL_IDS) {
    const n = rawSignals[id];
    signals[id] = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), SIGNAL_CAP) : 0;
  }
  const history: HistoryEntry[] = [];
  if (Array.isArray(o.history)) {
    for (const e of o.history.slice(-MAX_HISTORY)) {
      if (!isObj(e) || !isItemId(e.item) || typeof e.outcome !== "string" || !OUTCOMES.has(e.outcome)) continue;
      if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      history.push({ item: e.item, outcome: e.outcome as HistoryEntry["outcome"], at: e.at });
    }
  }
  return { answers, answered: Object.keys(answers).length, preferences, view, explicit, signals, history };
}

const ANSWER_INDEX: { question: QuestionId; section: ProfileSection; options: Map<string, number> }[] = QUESTIONS.map((q) => ({
  question: q.id,
  section: q.section,
  options: new Map(q.options.map((opt) => [opt.value as string, featureIndex(`answer.${q.id}.${opt.value}`)])),
}));
const SECTION_INDEX = new Map(PROFILE_SECTIONS.map((s) => [s.id as ProfileSection, featureIndex(`section.${s.id}`)]));
const ACTIVE_INDEX = ITEM_IDS.map((id) => featureIndex(`active.${id}`));
const EXPLICIT_INDEX = new Map(DIMENSIONS.map((d) => [d, featureIndex(`explicit.${d}`)]));
const SIGNAL_INDEX = SIGNAL_IDS.map((s) => featureIndex(`signal.${s}`));
const HISTORY_INDEX = HISTORY_OUTCOMES.map((h) => featureIndex(`history.${h}`));
const ROUNDS_INDEX = featureIndex("history.rounds");

/** Encodes a normalised input into `out` (length FEATURE_COUNT). */
export function encodeNormalised(n: NormalisedInput, out: Float64Array | number[] = new Float64Array(FEATURE_COUNT)): Float64Array | number[] {
  for (let i = 0; i < FEATURE_COUNT; i++) out[i] = 0;
  const answers = n.answers as Record<string, string | undefined>;
  for (const q of ANSWER_INDEX) {
    const v = answers[q.question];
    const idx = v === undefined ? undefined : q.options.get(v);
    if (idx === undefined) continue;
    out[idx] = 1;
    out[SECTION_INDEX.get(q.section)!] = 1;
  }
  if (n.view !== null) for (let i = 0; i < ITEM_IDS.length; i++) out[ACTIVE_INDEX[i]] = isActive(ITEM_IDS[i], n.preferences, n.view) ? 1 : 0;
  else for (let i = 0; i < ITEM_IDS.length; i++) if (CATALOG[ITEM_IDS[i]].dimension !== "view") out[ACTIVE_INDEX[i]] = isActive(ITEM_IDS[i], n.preferences, "simple") ? 1 : 0;
  for (const d of n.explicit) out[EXPLICIT_INDEX.get(d)!] = 1;
  for (let i = 0; i < SIGNAL_IDS.length; i++) {
    const c = n.signals[SIGNAL_IDS[i]];
    if (c > 0) out[SIGNAL_INDEX[i]] = Math.log1p(c) / SIGNAL_SCALE;
  }
  if (n.history.length > 0) {
    const counts = [0, 0, 0];
    for (const h of n.history) {
      const k = HISTORY_OUTCOMES.indexOf(h.outcome as (typeof HISTORY_OUTCOMES)[number]);
      if (k >= 0) counts[k]++;
    }
    for (let k = 0; k < counts.length; k++) if (counts[k] > 0) out[HISTORY_INDEX[k]] = Math.log1p(Math.min(counts[k], HISTORY_CAP)) / HISTORY_SCALE;
    // Entries answered at the same moment belong to one suggestion.
    const rounds = new Set(n.history.map((h) => h.at)).size;
    out[ROUNDS_INDEX] = Math.log1p(Math.min(rounds, HISTORY_CAP)) / HISTORY_SCALE;
  }
  return out;
}

/** The model's view of one person: FEATURE_IDS.length numbers in [0, 1]. Reads only allowlisted fields. */
export function encode(input: RecommenderInput): number[] {
  return Array.from(encodeNormalised(normaliseInput(input), new Float64Array(FEATURE_COUNT)));
}

/** Sparse form (indices of non-zero features and their values), for training and fast scoring. */
export interface SparseRow {
  idx: Int32Array;
  val: Float64Array;
}

export function toSparse(x: ArrayLike<number>): SparseRow {
  let nnz = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) nnz++;
  const idx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  for (let i = 0, k = 0; i < x.length; i++) {
    if (x[i] !== 0) {
      idx[k] = i;
      val[k++] = x[i];
    }
  }
  return { idx, val };
}
