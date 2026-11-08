// Pure transcript assembly for the voice engine: no DOM, no timers. The engine passes in the recogniser's result
// list and the time; this decides what the person has said, when they have finished, and what to ignore.
// Written from general ideas only (see docs/ARCHITECTURE.md, decision 2). No code from any AGPL project.
import type { TranscriptSnapshot, Utterance } from "./types";

export interface RecognisedResult {
  transcript: string;
  isFinal: boolean;
}

/** The words have been stable this long: the person has finished. */
export const PAUSE_MS = 1000;
/** ...or this long when the words end mid-thought ("and", "actually", "I mean", "on"). */
export const CONTINUATION_PAUSE_MS = 1800;
/** Dial's own voice can still reach the microphone this long after it stops speaking. */
export const ECHO_WINDOW_MS = 1500;
/** Share of the heard words that match Dial's words, in order, for them to count as echo. */
export const ECHO_SIMILARITY = 0.7;
/** Stop words are acted on straight away only in short utterances. */
export const REFLEX_MAX_WORDS = 5;

const norm = (w: string) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, "");
const split = (s: string) => s.split(/\s+/).filter(Boolean);
const set = (s: string) => new Set(s.split(" "));

/** A word as heard. `edge`: a pause (a new recogniser segment) or punctuation comes just before it. */
interface Word {
  w: string;
  n: string;
  edge: boolean;
}

function tokenise(segments: string[]): Word[] {
  const out: Word[] = [];
  for (const seg of segments) {
    let edge = true;
    for (const w of split(seg)) {
      const n = norm(w);
      if (!n) {
        edge = true; // a lone dash or comma
        continue;
      }
      out.push({ w, n, edge });
      edge = /[,.;:!?–—-]$/.test(w);
    }
  }
  return out;
}

const join = (ws: Word[]) => ws.map((x) => x.w).join(" ");

// Self-corrections. Strong phrases are almost always a correction; "actually" and "sorry" often are not
// ("did I actually pay"), so they need a pause or punctuation before them, or a sentence that doesn't run on.
const STRONG = ["no wait", "wait no", "scratch that", "let me rephrase that", "let me rephrase", "let me start again", "i mean", "i meant", "or rather"].map(split);
const WEAK = [["actually"], ["sorry"]];
/** Words that leave a sentence open before "actually": "did I actually...", "is it actually...". */
const MID = set(
  "i you we they he she it that this there what do did does is are was were am be been have has had really not just can could would will should i've i'm it's that's you're i'd don't didn't isn't wasn't haven't hasn't",
);
/** Words after "actually" that carry the same sentence on: "has it actually gone up", "is it actually due". */
const RUNS_ON = set(
  "spend spent spending pay paid paying owe owed owing cost costs go gone going went get got charge charged need needed have has had is was are were be been afford happen happened use used buy bought due mean made come came late higher lower more less right wrong correct true enough up down over did do does work worked received arrive arrived changed increase increased",
);
const FILLER = set("no oh um uh er erm well okay ok");

function markerAt(ws: Word[], i: number): number {
  const prev = ws[i - 1];
  const opensSentence = !prev || ws[i].edge || !MID.has(prev.n);
  const contentAfter = (j: number) => ws.slice(j).some((x) => !FILLER.has(x.n));
  for (const m of STRONG) if (m.every((t, k) => ws[i + k]?.n === t) && opensSentence && contentAfter(i + m.length)) return m.length;
  for (const m of WEAK)
    if (ws[i].n === m[0] && contentAfter(i + 1) && (!prev || ws[i].edge || (opensSentence && !RUNS_ON.has(ws[i + 1]?.n ?? "")))) return 1;
  return 0;
}

function trimFillers(ws: Word[]): Word[] {
  let a = 0;
  let b = ws.length;
  while (a < b && FILLER.has(ws[a].n)) a++;
  while (b > a && FILLER.has(ws[b - 1].n)) b--;
  return ws.slice(a, b);
}

interface Corrected {
  text: string;
  corrected: boolean;
  replaces?: string;
}

function correctWords(ws: Word[]): Corrected {
  const cuts: { start: number; end: number }[] = [];
  for (let i = 0; i < ws.length; ) {
    const len = markerAt(ws, i);
    if (len) cuts.push({ start: i, end: i + len });
    i += len || 1;
  }
  // A marker at the very start ("Actually, what do I owe?") replaces nothing in this utterance: just drop it.
  let from = 0;
  while (cuts.length && trimFillers(ws.slice(from, cuts[0].start)).length === 0) from = cuts.shift()!.end;
  if (!cuts.length) return { text: join(trimFillers(ws.slice(from))), corrected: false };
  // Later corrections refine the same request, so the first clause is what was replaced.
  const replaces = join(trimFillers(ws.slice(from, cuts[0].start))).replace(/[\s,;:–—-]+$/, "");
  return { text: join(trimFillers(ws.slice(cuts.at(-1)!.end))), corrected: true, replaces };
}

/** Applies self-corrections to recogniser segments (each segment follows a pause). */
export const correct = (segments: string[]): Corrected => correctWords(tokenise(segments));

const OPEN_END = set("and but or so because actually then with also plus um uh er erm the a an my on of for to in at from than about rather");
const OPEN_END_PAIRS = ["i mean", "no wait", "wait no", "scratch that"];

/** True when the words end mid-thought, so the person is probably not finished. */
export function endsMidThought(text: string): boolean {
  const ws = split(text).map(norm).filter(Boolean);
  const last = ws.at(-1);
  return !!last && (OPEN_END.has(last) || OPEN_END_PAIRS.includes(ws.slice(-2).join(" ")));
}

export const pauseFor = (text: string) => (endsMidThought(text) ? CONTINUATION_PAUSE_MS : PAUSE_MS);

const STOP =
  /^(?:(?:ok|okay|dial|hey|oh|please) )*(?:stop|stop it|stop that|stop talking|stop speaking|cancel|cancel that|never mind|nevermind|forget it|be quiet|quiet|shush|enough|that's enough)(?: (?:please|now|dial|thanks|thank you))*$/;

/** A short utterance that only says "stop" (or cancel, never mind...). Longer sentences are never a reflex stop. */
export function isStopPhrase(text: string): boolean {
  const ws = split(text).map(norm).filter(Boolean);
  return ws.length > 0 && ws.length <= REFLEX_MAX_WORDS && STOP.test(ws.join(" "));
}

const CURRENCY = set("pounds pound pence p quid");
/** Words for echo matching: "£1,200.50" and "1200 pounds 50" compare equal. */
const echoTokens = (s: string) =>
  split(s.toLowerCase().replace(/£/g, " ").replace(/(\d),(\d)/g, "$1$2").replace(/(\d)\.(\d)/g, "$1 $2"))
    .map(norm)
    .filter((w) => w && !CURRENCY.has(w));

/** Ordered token overlap: the share of heard words found, in order, in what Dial said (0..1). */
export function echoSimilarity(heard: string, spoken: string): number {
  const a = echoTokens(heard);
  const b = echoTokens(spoken);
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    for (let j = 0; j < b.length; j++) cur.push(x === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** How many leading words are Dial's own (at least two, and never all of them). */
function leadingEcho(ws: Word[], spoken: string): number {
  const said = new Set(echoTokens(spoken));
  let k = 0;
  while (k < ws.length && echoTokens(ws[k].w).every((t) => said.has(t))) k++;
  return k >= 2 && k < ws.length ? k : 0;
}

export interface AssemblerUpdate {
  snapshot: TranscriptSnapshot;
  /** The snapshot differs from the previous one. */
  changed: boolean;
  /** Everything heard so far is Dial's own voice. */
  echo: boolean;
  /** The person spoke over Dial (not echo, two words or a stop word). Reported once per utterance. */
  bargeIn: boolean;
  /** The whole utterance is a short stop phrase. */
  stop: boolean;
}

// Ids are unique across every engine on the page, so a caller can always ignore an id it has already seen.
let lastId = 0;

/**
 * Builds one utterance at a time from a recogniser's growing result list. Results before `base` belong to
 * utterances already delivered or dropped, so a late final for them is ignored (stale).
 */
export class TranscriptAssembler {
  private id = ++lastId;
  private base = 0;
  private list: RecognisedResult[] = [];
  /** Words from an earlier recogniser session in the same utterance (push-to-talk across a restart). */
  private carry: RecognisedResult[] = [];
  private snap: TranscriptSnapshot = TranscriptAssembler.empty(this.id);
  private replaces: string | undefined;
  private changedAt = 0;
  private spoken: string | null = null;
  private lastSpoken: string | null = null;
  private spokenEndedAt = -Infinity;
  private echoSource: string | null = null;
  private echoOnly = false;
  private bargedIn = false;

  private static empty(utteranceId: number): TranscriptSnapshot {
    return { utteranceId, finalText: "", interimText: "", text: "", corrected: false };
  }

  get snapshot() {
    return this.snap;
  }
  get hasWords() {
    return this.snap.text !== "";
  }
  /** Only Dial's own words are pending. */
  get isEchoOnly() {
    return this.echoOnly;
  }

  /** What Dial is saying (null when quiet). */
  setSpeaking(text: string | null, now: number) {
    if (text) this.spoken = this.lastSpoken = text;
    else if (this.spoken !== null) {
      this.spoken = null;
      this.spokenEndedAt = now;
    }
  }
  get speaking() {
    return this.spoken !== null;
  }
  echoActive(now: number) {
    return this.spoken !== null || now - this.spokenEndedAt < ECHO_WINDOW_MS;
  }

  /** A new recogniser session started: its results begin again at index 0. Words heard so far are kept. */
  newSession() {
    this.carry = [...this.carry, ...this.list.slice(this.base)].map((r) => ({ transcript: r.transcript, isFinal: true }));
    this.list = [];
    this.base = 0;
  }

  update(results: RecognisedResult[], now: number): AssemblerUpdate {
    this.list = results.map((r) => ({ transcript: r.transcript ?? "", isFinal: !!r.isFinal }));
    const segs = [...this.carry, ...this.list.slice(this.base)];
    const words = tokenise(segs.map((r) => r.transcript));
    const finalCount = tokenise(segs.filter((r) => r.isFinal).map((r) => r.transcript)).length; // finals come first

    const active = this.echoActive(now);
    if (active && words.length && this.echoSource === null) this.echoSource = this.lastSpoken;
    const source = active ? this.lastSpoken : this.echoSource;
    let skip = 0;
    this.echoOnly = false;
    if (source && words.length) {
      if (echoSimilarity(join(words), source) >= ECHO_SIMILARITY) this.echoOnly = true;
      else skip = leadingEcho(words, source);
    }
    const kept = this.echoOnly ? [] : words.slice(skip);
    const nFinal = Math.max(0, finalCount - skip);
    const full = correctWords(kept);
    const snapshot: TranscriptSnapshot = {
      utteranceId: this.id,
      finalText: correctWords(kept.slice(0, nFinal)).text,
      interimText: join(kept.slice(nFinal)),
      text: full.text,
      corrected: full.corrected,
    };
    const before = this.snap;
    const changed = (Object.keys(snapshot) as (keyof TranscriptSnapshot)[]).some((k) => snapshot[k] !== before[k]);
    if (snapshot.text !== before.text) this.changedAt = now;
    this.snap = snapshot;
    this.replaces = full.replaces;

    const stop = !this.echoOnly && isStopPhrase(join(kept));
    const bargeIn = this.spoken !== null && !this.echoOnly && !this.bargedIn && (stop || split(full.text).length >= 2);
    if (bargeIn) this.bargedIn = true;
    return { snapshot, changed, echo: this.echoOnly, bargeIn, stop };
  }

  /** Milliseconds until the pause that ends this utterance (0 or less: now). Infinity when nothing is pending. */
  remaining(now: number) {
    return this.hasWords ? this.changedAt + pauseFor(this.snap.text) - now : Infinity;
  }

  /** Drops an utterance that was only Dial's echo, once Dial has been quiet long enough. */
  dropEcho(now: number): boolean {
    if (!this.echoOnly || this.echoActive(now)) return false;
    this.next();
    return true;
  }

  /** Hands over the pending utterance, once. Returns null when there is nothing to say. */
  deliver(): Utterance | null {
    const s = this.snap;
    if (!s.text) return null;
    const u: Utterance = { utteranceId: s.utteranceId, text: s.text, corrected: s.corrected, ...(this.replaces ? { replaces: this.replaces } : {}), origin: "voice" };
    this.next();
    return u;
  }

  /** Drops the pending utterance: nothing is submitted for its id. */
  discard() {
    this.next();
  }

  private next() {
    this.id = ++lastId;
    this.base = this.list.length;
    this.carry = [];
    this.snap = TranscriptAssembler.empty(this.id);
    this.replaces = undefined;
    this.echoSource = null;
    this.echoOnly = false;
    this.bargedIn = false;
  }
}
