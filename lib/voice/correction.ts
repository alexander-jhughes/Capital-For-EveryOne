// Self-correction phrases, shared by the voice engine (spoken) and the Dial planner (typed). Pure, no state.
//
// "How much did I spend on food? Actually, groceries."  -> { before: "How much did I spend on food?", after: "groceries" }
// "Take me to pay, no wait, spending"                   -> { before: "Take me to pay", after: "spending" }
//
// Only the LAST correction counts: "A, actually B, no I mean C" -> before "A, actually B", after "C". The planner
// then decides whether `after` is a whole new request or a fragment to merge into `before`.

/** Phrases that mean "replace what I just said". Ordered longest first so "no, I mean" wins over "I mean". */
const CORRECTION_PHRASES = [
  "no wait i mean",
  "no sorry i mean",
  "sorry i meant",
  "sorry i mean",
  "no no i mean",
  "change that to",
  "no i meant",
  "no i mean",
  "scratch that",
  "forget that",
  "let me rephrase",
  "or rather",
  "i meant",
  "i mean",
  "no wait",
  "sorry no",
  "actually",
  "rather",
  "sorry",
  "wait",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A phrase only counts at a clause boundary: start of text, or after punctuation, or after "oh"/"um" fillers.
// "I actually spent" (mid-clause) is not a correction; "Food. Actually, groceries" is.
const PHRASE = new RegExp(
  `(^|[.?!,;:]\\s*|\\s(?:oh|um|uh|er|erm)\\s*,?\\s*)(${CORRECTION_PHRASES.map((p) => p.split(" ").map(esc).join("[\\s,]+")).join("|")})[\\s,.:;!-]*`,
  "gi",
);

export interface CorrectionSplit {
  /** The words the correction replaces, trimmed. Empty when the correction was the first thing said. */
  before: string;
  /** What the person meant instead, trimmed. */
  after: string;
}

/** "Actually, groceries": the text opens with a correction phrase and says something after it. */
export function opensWithCorrection(text: string): boolean {
  PHRASE.lastIndex = 0;
  const m = PHRASE.exec(text);
  return !!m && m.index === 0 && text.slice(m[0].length).trim() !== "";
}

/** Splits on the last self-correction phrase. Null when there isn't one, or nothing follows it. */
export function splitCorrection(text: string): CorrectionSplit | null {
  let last: RegExpExecArray | null = null;
  PHRASE.lastIndex = 0;
  for (let m = PHRASE.exec(text); m; m = PHRASE.exec(text)) last = m;
  if (!last) return null;
  const start = last.index + last[1].length;
  const before = text.slice(0, start).replace(/[\s,;:-]+$/, "").trim();
  const after = text.slice(last.index + last[0].length).trim();
  if (!after) return null;
  // "Actually, how much do I owe?" at the very start is just a sentence, not a correction of anything.
  if (!before) return null;
  return { before, after };
}
