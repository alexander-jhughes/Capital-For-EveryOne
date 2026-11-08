// The one voice engine for Dial (contract: ./types.ts). It drives the browser's recogniser, shows words as they
// arrive and hands over ONE finished utterance at a time. It never answers, acts, records or uploads audio itself:
// speech to text is the browser's own recogniser, on the device where it can be, and the browser's online service
// only when the person has allowed it (allowCloud). See docs/ARCHITECTURE.md, decision 1.
//
// How an utterance ends: words reset a pause timer (longer after "and", "actually"...). When it runs out, whatever
// was heard is delivered. Finals don't end the utterance on their own, so a natural pause mid-question can't cut it.
// We always ask for a continuous session and decide the end ourselves; when the browser ends a session early
// (Chrome does after silence, Android after each phrase) we restart it with back-off and keep the words heard so far.

import {
  getLiveRecognition,
  onDeviceAvailability,
  recognitionError,
  voiceError,
  type LiveRecognition,
  type RecognitionResults,
} from "../assistant/speech";
import { buildTranscript, endsWithContinuation, hasWords, isEcho, isStopWord, joinParts, normalise, readResults, type Transcript } from "./transcript";
import type { ListenMode, RecognitionBackend, VoiceEngine, VoiceEngineEvents, VoiceError, VoiceState } from "./types";

export interface VoiceEngineOptions {
  /** The window to find SpeechRecognition and document on. Defaults to the real window. */
  win?: unknown;
  /** BCP 47 language. Default "en-GB". */
  lang?: string;
  /** The person agreed to the browser's online speech service. Without it only on-device recognition is used. */
  allowCloud: boolean;
  events: VoiceEngineEvents;
  timing?: Partial<{
    /** Silence that ends an utterance. */
    pauseMs: number;
    /** Silence that ends an utterance trailing off on "and", "actually", "I mean"... */
    longPauseMs: number;
    /** Browser session ends in a row (with no words in between) before giving up. */
    maxRestarts: number;
    /** Tap mode: give up when nothing is heard for this long. */
    noSpeechMs: number;
  }>;
  clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now(): number };
}

const DEFAULT_TIMING = { pauseMs: 1100, longPauseMs: 2000, maxRestarts: 6, noSpeechMs: 8000 };
/** First restart delay; doubles each time (200, 400, 800...). */
const BACKOFF_MS = 200;
/** A session that ran this long ended normally (silence), not in a failure loop, so it doesn't use up a restart. */
const HEALTHY_SESSION_MS = 5000;
/** How long "interrupted" shows before the engine settles. */
const INTERRUPTED_MS = 600;
/** Recognisers lag: Dial's last words can still arrive this long after it stops speaking. */
const ECHO_TAIL_MS = 1500;

type Timer = ReturnType<typeof setTimeout>;
interface DocLike {
  visibilityState?: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

const realClock = {
  setTimeout: ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms)) as typeof setTimeout,
  clearTimeout: ((t: Timer) => globalThis.clearTimeout(t)) as typeof clearTimeout,
  now: () => Date.now(),
};

/**
 * Where speech would be recognised. On the device when the browser says the language is installed there; the
 * browser's online service only with allowCloud; otherwise "none" (offer typing). Never opens the microphone.
 */
export async function detectBackend(win: unknown, lang: string, allowCloud: boolean): Promise<RecognitionBackend> {
  if (!getLiveRecognition(win)) return "none";
  if ((await onDeviceAvailability(win, lang)) === "available") return "on-device";
  return allowCloud ? "cloud" : "none";
}

/** The backend when it can be known without waiting (no on-device API to ask), else null. */
function knownBackend(win: unknown, allowCloud: boolean): RecognitionBackend | null {
  const Rec = getLiveRecognition(win);
  if (!Rec) return "none";
  if (typeof Rec.available === "function") return null;
  return allowCloud ? "cloud" : "none";
}

export function createVoiceEngine(opts: VoiceEngineOptions): VoiceEngine {
  const win = "win" in opts ? opts.win : typeof window === "undefined" ? undefined : window;
  const lang = opts.lang ?? "en-GB";
  const { events, allowCloud } = opts;
  const timing = { ...DEFAULT_TIMING, ...opts.timing };
  const clock = opts.clock ?? realClock;
  const Rec = getLiveRecognition(win);
  const doc = (win as { document?: DocLike } | undefined)?.document;

  // Lifecycle
  let disposed = false;
  let state: VoiceState = "idle";
  let backend: RecognitionBackend = knownBackend(win, allowCloud) ?? "none";
  /** True from start() until stop/cancel/failure/tap delivery: the person wants us listening. */
  let active = false;
  let mode: ListenMode = "tap";
  /** Bumped on every start(), so a slow backend check can't open the microphone after stop(). */
  let startToken = 0;
  /** Microphone confirmed open in this start() (the permission prompt is behind us). */
  let micReady = false;
  let failed = false;
  let processing = false;
  let interrupted = false;
  let restarts = 0;

  // The current recogniser. Each instance gets a token; events from any other instance are ignored.
  let rec: LiveRecognition | null = null;
  let instance = 0;
  let sessionStartedAt = 0;

  // The current utterance
  let counter = 0;
  let lastDelivered = 0;
  /** 0 until the first real (non-echo) words of a new utterance arrive. */
  let utteranceId = 0;
  let current: Transcript | null = null;
  /** Final words from earlier recogniser sessions in this utterance (a restart starts its results from zero). */
  let carried = "";
  let sessionWords = "";
  /** Results before this index in the current session belong to utterances already handled. */
  let boundary = 0;
  let seen = 0;
  /** This utterance already passed the echo and stop-word checks. */
  let userSpoke = false;

  // Dial's own voice
  let speaking: string | null = null;
  let echoTail: string | null = null;
  let echoUntil = 0;
  /** onInterrupt("user-speech") already fired for what Dial is saying now. */
  let bargedIn = false;

  // Timers
  const timers = new Set<Timer>();
  let pauseTimer: Timer | null = null;
  let restartTimer: Timer | null = null;
  let noSpeechTimer: Timer | null = null;
  let interruptTimer: Timer | null = null;

  function later(fn: () => void, ms: number): Timer {
    const set = clock.setTimeout;
    const t: Timer = set(() => {
      timers.delete(t);
      if (!disposed) fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function clear(t: Timer | null): null {
    if (t !== null) {
      const c = clock.clearTimeout;
      c(t);
      timers.delete(t);
    }
    return null;
  }

  function computeState(): VoiceState {
    if (interrupted) return "interrupted";
    if (active && current) return "transcribing";
    if (speaking !== null) return "responding";
    if (processing) return "processing";
    if (active) return micReady ? "listening" : "requesting-permission";
    return failed ? "failed" : "idle";
  }
  function emit() {
    if (disposed) return;
    const next = computeState();
    if (next === state) return;
    state = next;
    events.onState(next);
  }

  function flashInterrupted(reason: "user-speech" | "stop-word" | "backgrounded") {
    events.onInterrupt?.(reason);
    interrupted = true;
    interruptTimer = clear(interruptTimer);
    interruptTimer = later(() => {
      interruptTimer = null;
      interrupted = false;
      emit();
    }, INTERRUPTED_MS);
    emit();
  }

  // Recogniser sessions

  function abortRecogniser() {
    const r = rec;
    rec = null;
    instance++;
    if (!r) return;
    r.onstart = r.onaudiostart = r.onresult = r.onerror = r.onend = null;
    try {
      if (r.abort) r.abort();
      else r.stop();
    } catch {
      // Already ended.
    }
  }

  function open() {
    if (!Rec || disposed || !active) return;
    abortRecogniser(); // never two sessions at once
    const token = instance;
    const r = new Rec();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    if (backend === "on-device") r.processLocally = true;
    const live = () => token === instance && !disposed;
    r.onstart = r.onaudiostart = () => {
      if (!live()) return;
      micReady = true;
      armNoSpeech();
      emit();
    };
    r.onresult = (e) => live() && handleResults(e.results);
    r.onerror = (e) => live() && handleError(e.error);
    r.onend = () => live() && handleEnd();
    rec = r;
    boundary = seen = 0;
    sessionWords = "";
    sessionStartedAt = clock.now();
    try {
      r.start();
    } catch {
      fail(voiceError("failed"));
    }
  }

  function begin(token: number, b: RecognitionBackend) {
    if (token !== startToken || !active || disposed) return;
    backend = b;
    if (b === "none") return fail(voiceError("language-unavailable"));
    open();
  }

  /** Stops listening. Timers and the recogniser go; the pending utterance is dropped (callers take it first). */
  function halt() {
    active = false;
    startToken++;
    pauseTimer = clear(pauseTimer);
    restartTimer = clear(restartTimer);
    noSpeechTimer = clear(noSpeechTimer);
    abortRecogniser();
    resetUtterance();
  }

  function fail(err: VoiceError) {
    halt();
    failed = true;
    if (!disposed) events.onError(err);
    emit();
  }

  // Utterances

  function resetUtterance() {
    pauseTimer = clear(pauseTimer);
    boundary = seen;
    carried = sessionWords = "";
    current = null;
    utteranceId = 0;
    userSpoke = false;
  }

  /** Takes the pending utterance (if any) and starts a fresh one. */
  function take(): Transcript | null {
    const t = current;
    resetUtterance();
    return t;
  }

  function deliver(t: Transcript | null) {
    if (!t || disposed) return;
    const { utteranceId: id, text, corrected } = t.snapshot;
    if (!hasWords(text) || id <= lastDelivered) return;
    lastDelivered = id;
    events.onUtterance({ utteranceId: id, text, corrected, ...(t.replaces ? { replaces: t.replaces } : {}), origin: "voice" });
  }

  function armPause(raw: string) {
    pauseTimer = clear(pauseTimer);
    if (mode === "hold") return; // push-to-talk ends on release, not on silence
    pauseTimer = later(endOfUtterance, endsWithContinuation(raw) ? timing.longPauseMs : timing.pauseMs);
  }

  function endOfUtterance() {
    pauseTimer = null;
    const t = take();
    if (mode === "tap") halt();
    deliver(t);
    emit();
  }

  function armNoSpeech() {
    noSpeechTimer = clear(noSpeechTimer);
    if (mode !== "tap" || current) return;
    noSpeechTimer = later(() => {
      noSpeechTimer = null;
      if (active && !current) fail(voiceError("no-speech"));
    }, timing.noSpeechMs);
  }

  function handleResults(results: RecognitionResults) {
    restarts = 0;
    micReady = true;
    seen = results.length;
    const { final, interim } = readResults(results, boundary);
    const raw = joinParts(carried, final, interim);
    if (!hasWords(raw)) return;

    if (!userSpoke) {
      // While Dial talks: a stop word silences it, Dial's own voice is ignored, anything else is the person cutting in.
      if (speaking !== null && isStopWord(raw)) {
        resetUtterance();
        return flashInterrupted("stop-word");
      }
      const echoOf = speaking ?? (clock.now() < echoUntil ? echoTail : null);
      if (isEcho(raw, echoOf)) return resetUtterance();
      userSpoke = true;
      if (speaking !== null && !bargedIn) {
        bargedIn = true;
        flashInterrupted("user-speech");
      }
    }

    if (!utteranceId) utteranceId = ++counter;
    sessionWords = joinParts(final, interim);
    current = buildTranscript(utteranceId, joinParts(carried, final), interim);
    noSpeechTimer = clear(noSpeechTimer);
    events.onTranscript(current.snapshot);
    armPause(raw);
    emit();
  }

  function handleError(code: string) {
    const err = recognitionError(code);
    if (!err) return; // aborted: never shown; onend decides what happens next
    // Silence isn't a failure while the person holds the button, in continuous mode, or after they've spoken.
    if (err.code === "no-speech" && (mode !== "tap" || current)) return;
    fail(err);
  }

  function handleEnd() {
    rec = null;
    // A new session's results start from zero, so keep this session's words with the utterance.
    if (current) carried = joinParts(carried, sessionWords);
    sessionWords = "";
    boundary = seen = 0;
    if (!active) return emit();
    // Tap mode with nothing heard: the browser gave up listening, so do we (quietly; no-speech reports itself).
    if (mode === "tap" && !current) {
      halt();
      return emit();
    }
    if (clock.now() - sessionStartedAt >= HEALTHY_SESSION_MS) restarts = 0;
    if (restarts >= timing.maxRestarts) {
      const t = take();
      fail(voiceError("failed"));
      return deliver(t);
    }
    const delay = BACKOFF_MS * 2 ** restarts;
    restarts++;
    restartTimer = later(() => {
      restartTimer = null;
      open();
    }, delay);
  }

  function onVisibility() {
    if (doc?.visibilityState !== "hidden" || disposed) return;
    if (!active && speaking === null) return;
    const t = take();
    halt();
    if (t) events.onTranscript(emptySnapshot(t.snapshot.utteranceId));
    flashInterrupted("backgrounded");
  }
  doc?.addEventListener("visibilitychange", onVisibility);

  return {
    get backend() {
      return backend;
    },
    get state() {
      return state;
    },
    start(m: ListenMode) {
      if (disposed) return;
      if (active) {
        mode = m; // already listening: never a second session
        return;
      }
      active = true;
      mode = m;
      failed = false;
      micReady = false;
      restarts = 0;
      const token = ++startToken;
      emit();
      if (!Rec) return fail(voiceError("unsupported"));
      const known = knownBackend(win, allowCloud);
      if (known) return begin(token, known);
      // Chrome: ask whether the language is installed on the device. Safe to wait: the microphone isn't open yet.
      void detectBackend(win, lang, allowCloud).then((b) => begin(token, b));
    },
    stop() {
      if (disposed || !active) return;
      const t = take();
      halt();
      deliver(t);
      emit();
    },
    cancel() {
      if (disposed) return;
      const t = take();
      halt();
      if (t) events.onTranscript(emptySnapshot(t.snapshot.utteranceId));
      emit();
    },
    setSpeaking(text: string | null) {
      if (disposed) return;
      const next = text && normalise(text) ? normalise(text) : null;
      if (next === speaking) return;
      if (speaking !== null && next === null) {
        echoTail = speaking;
        echoUntil = clock.now() + ECHO_TAIL_MS;
      }
      speaking = next;
      bargedIn = false;
      emit();
    },
    setProcessing(on: boolean) {
      if (disposed) return;
      processing = on;
      emit();
    },
    dispose() {
      if (disposed) return;
      halt();
      for (const t of [...timers]) clear(t);
      interruptTimer = null;
      doc?.removeEventListener("visibilitychange", onVisibility);
      disposed = true;
    },
  };
}

function emptySnapshot(utteranceId: number) {
  return { utteranceId, finalText: "", interimText: "", text: "", corrected: false };
}
