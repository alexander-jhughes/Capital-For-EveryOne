// The one voice engine for Voice Mode and the Ask sheet, over the browser's Web Speech API. It only listens and
// transcribes: one finished utterance at a time goes to the caller, which runs the same pipeline as typed text.
import { getRecognition, onDeviceStatus, voiceErrorMessage, type Recognition, type RecognitionCtor } from "../assistant/speech";
import type { Preferences } from "../preferences/schema";
import type { ListenMode, RecognitionBackend, VoiceEngine, VoiceEngineEvents, VoiceError, VoiceErrorCode, VoiceState } from "./types";
import { ECHO_WINDOW_MS, TranscriptAssembler, type RecognisedResult } from "./utterance";

/** Restarts after a failed session wait 1 s, 2 s, 4 s (the cap); the 4th failure in a row gives up. */
export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 4000;
export const MAX_FAILURES = 4;
/** Continuous listening stops after this long without the person saying anything. */
export const SILENCE_LIMIT_MS = 120_000;
/** How long "interrupted" shows before listening or idle. */
export const INTERRUPTED_MS = 700;
/** After stop(), how long to wait for the recogniser's final words before delivering what was shown. */
export const FINISH_GRACE_MS = 1200;

export interface VoiceEngineOptions {
  speechInput: Preferences["speechInput"];
  lang?: string;
  now?: () => number;
}

/** What the engine needs from `window`. Everything is feature-detected. */
export interface VoiceWindow {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  document?: { hidden: boolean; addEventListener(t: "visibilitychange", f: () => void): void; removeEventListener(t: "visibilitychange", f: () => void): void };
}

const onDeviceCapable = (Rec: RecognitionCtor) => typeof Rec.available === "function" || "processLocally" in (Rec.prototype ?? {});

/** on-device needs the person's agreement and browser support; cloud needs their agreement. Otherwise typing. */
export function chooseBackend(win: unknown, speechInput: Preferences["speechInput"]): RecognitionBackend {
  const Rec = getRecognition(win);
  if (!Rec) return "none";
  if (speechInput === "cloud") return "cloud";
  if (speechInput === "on-device" && onDeviceCapable(Rec)) return "on-device";
  return "none";
}

const BROWSER_CODES: Record<string, VoiceErrorCode> = {
  "not-allowed": "not-allowed",
  "service-not-allowed": "not-allowed",
  "audio-capture": "no-microphone",
  network: "network",
  "language-not-supported": "language-unavailable",
  "no-speech": "no-speech",
  aborted: "aborted",
};
/** Errors where trying again can't help, so the engine stops at once. */
const FATAL = new Set<VoiceErrorCode>(["not-allowed", "no-microphone", "language-unavailable", "unsupported"]);

export function toVoiceError(code: string): VoiceError {
  const c: VoiceErrorCode = BROWSER_CODES[code] ?? (["unsupported", "language-unavailable", "no-microphone", "failed"].includes(code) ? (code as VoiceErrorCode) : "failed");
  return { code: c, message: voiceErrorMessage(c) || voiceErrorMessage("failed"), recoverable: !["not-allowed", "unsupported", "language-unavailable"].includes(c) };
}

export type BrowserVoiceEngine = VoiceEngine & {
  /** The microphone is on, or about to be (including between continuous restarts). */
  readonly listening: boolean;
};

export function createVoiceEngine(win: VoiceWindow, events: VoiceEngineEvents, opts: VoiceEngineOptions): BrowserVoiceEngine {
  const Rec = getRecognition(win);
  const backend = chooseBackend(win, opts.speechInput);
  const lang = opts.lang ?? "en-GB";
  const now = opts.now ?? (() => Date.now());
  const asm = new TranscriptAssembler();
  // Checked once: is the British English pack on this device? Starting waits for it only the first time.
  let onDevice: Promise<string> | string | null = backend === "on-device" ? onDeviceStatus(win, lang) : null;
  if (onDevice instanceof Promise) void onDevice.then((s) => (onDevice = s));

  let mode: ListenMode = "tap";
  let rec: Recognition | null = null;
  let running = false; // the person wants the microphone on
  let finishing = false; // stop() asked for the last words
  let started = false; // this session's recogniser has started
  let permitted = false; // a recogniser has started before, so permission isn't being asked
  let processing = false;
  let speaking: string | null = null;
  let failure: VoiceError | null = null;
  let lastError: string | null = null;
  let failures = 0;
  let interruptedUntil = 0;
  let disposed = false;
  let opening = 0;
  const timers = { pause: 0, restart: 0, finish: 0, silence: 0, interrupted: 0 } as Record<"pause" | "restart" | "finish" | "silence" | "interrupted", ReturnType<typeof setTimeout> | 0>;
  const clear = (k: keyof typeof timers) => {
    if (timers[k]) clearTimeout(timers[k]);
    timers[k] = 0;
  };

  function compute(): VoiceState {
    if (failure) return "failed";
    if (now() < interruptedUntil) return "interrupted";
    const on = running || finishing;
    if (on && asm.hasWords) return "transcribing";
    if (speaking !== null) return "responding";
    if (processing) return "processing";
    if (on) return started || permitted ? "listening" : "requesting-permission";
    return "idle";
  }
  let last = { state: compute(), listening: false };
  function emit() {
    const next = { state: compute(), listening: running || finishing };
    if (next.state === last.state && next.listening === last.listening) return;
    last = next;
    events.onState(next.state);
  }

  function abortRec() {
    const r = rec;
    rec = null;
    started = false;
    clear("pause");
    clear("finish");
    if (!r) return;
    try {
      if (r.abort) r.abort();
      else r.stop();
    } catch {}
  }

  function fail(code: string) {
    running = false;
    finishing = false;
    abortRec();
    clear("restart");
    clear("silence");
    failure = toVoiceError(code);
    events.onError(failure);
    emit();
  }

  function interrupt(reason: "user-speech" | "stop-word" | "backgrounded") {
    interruptedUntil = now() + INTERRUPTED_MS;
    clear("interrupted");
    timers.interrupted = setTimeout(emit, INTERRUPTED_MS + 10);
    events.onInterrupt?.(reason);
    emit();
  }

  function resetSilence() {
    clear("silence");
    if (mode !== "continuous" || !running) return;
    timers.silence = setTimeout(() => {
      if (!running || asm.hasWords) return resetSilence();
      running = false;
      abortRec();
      clear("restart");
      failure = { code: "no-speech", message: "I stopped listening because it was quiet for 2 minutes. Tap the microphone to start again.", recoverable: true };
      events.onError(failure);
      emit();
    }, SILENCE_LIMIT_MS);
  }

  function deliver() {
    clear("pause");
    const u = asm.deliver();
    if (!u) return;
    if (mode === "tap") {
      running = false;
      abortRec();
    }
    processing = true; // before the handler runs, so a handler that finishes at once can clear it
    events.onUtterance(u);
    emit();
  }

  /** Ends the utterance after a stable pause (never in push-to-talk: release ends it). */
  function schedule() {
    clear("pause");
    if (!running || finishing) return;
    const t = now();
    if (asm.dropEcho(t)) events.onTranscript(asm.snapshot);
    if (asm.isEchoOnly) {
      timers.pause = setTimeout(schedule, ECHO_WINDOW_MS);
      return;
    }
    if (mode === "hold" || !asm.hasWords) return;
    const wait = asm.remaining(t);
    if (wait <= 0) return deliver();
    timers.pause = setTimeout(schedule, wait);
  }

  function onResults(list: RecognisedResult[]) {
    const t = now();
    const u = asm.update(list, t);
    if (u.snapshot.text) resetSilence();
    if (u.stop && (speaking !== null || processing)) {
      asm.discard();
      events.onTranscript(asm.snapshot);
      if (mode === "tap") {
        running = false;
        abortRec();
      }
      interrupt("stop-word");
      return;
    }
    if (u.bargeIn) interrupt("user-speech");
    if (u.changed) events.onTranscript(u.snapshot);
    emit();
    schedule();
  }

  function finish() {
    finishing = false;
    abortRec();
    deliver();
    emit();
  }

  function onEnd() {
    const err = lastError;
    lastError = null;
    const hadStarted = started;
    rec = null;
    started = false;
    clear("pause");
    if (finishing) return finish();
    if (!running) return emit();
    // The recogniser ended by itself. Words already shown were said: hand them over (push-to-talk keeps them).
    if (mode !== "hold" && asm.hasWords) deliver();
    if (!running) return emit();
    if (mode === "tap") {
      if (err && err !== "aborted") return fail(err);
      running = false;
      return emit();
    }
    const failed = !hadStarted || (!!err && err !== "no-speech" && err !== "aborted");
    failures = failed ? failures + 1 : 0;
    if (failures >= MAX_FAILURES) return fail(err && err !== "no-speech" ? err : "failed");
    asm.newSession();
    const delay = failures ? Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** (failures - 1)) : 0;
    timers.restart = setTimeout(open, delay);
    emit();
  }

  async function open() {
    clear("restart");
    if (!running || disposed || !Rec) return;
    const token = ++opening;
    if (onDevice instanceof Promise) onDevice = await onDevice;
    if (token !== opening || !running) return;
    if (backend === "on-device" && onDevice !== "available") return fail("language-unavailable");
    const r = new Rec();
    r.lang = lang;
    r.continuous = true; // the engine decides when an utterance ends, in every mode
    r.interimResults = true;
    r.maxAlternatives = 1;
    if (backend === "on-device") r.processLocally = true;
    else if ("processLocally" in r) r.processLocally = false;
    r.onstart = () => {
      if (r !== rec) return;
      started = permitted = true;
      emit();
    };
    r.onresult = (e) => {
      if (r !== rec) return; // a stopped recogniser's late results are stale
      onResults(Array.from(e.results, (x) => ({ transcript: x[0]?.transcript ?? "", isFinal: !!x.isFinal })));
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      lastError = e.error;
      const code = toVoiceError(e.error).code;
      if (FATAL.has(code)) fail(e.error);
    };
    r.onend = () => {
      if (r === rec) onEnd();
    };
    rec = r;
    started = false;
    try {
      r.start();
    } catch {
      lastError = "failed";
      onEnd();
    }
    emit();
  }

  const onVisibility = () => {
    if (!win.document?.hidden || !(running || finishing || rec)) return;
    running = false;
    finishing = false;
    abortRec();
    clear("restart");
    clear("silence");
    interrupt("backgrounded"); // the transcript stays on screen; nothing is sent
  };
  win.document?.addEventListener("visibilitychange", onVisibility);

  const engine: BrowserVoiceEngine = {
    backend,
    get state() {
      return compute();
    },
    get listening() {
      return running || finishing;
    },
    start(m) {
      if (disposed) return;
      failure = null;
      if (backend === "none") return fail("unsupported");
      abortRec();
      clear("restart");
      if (asm.hasWords || asm.isEchoOnly) asm.discard(); // left over from a backgrounded or failed session
      asm.newSession();
      mode = m;
      running = true;
      finishing = false;
      failures = 0;
      resetSilence();
      emit();
      void open();
    },
    stop() {
      clear("restart");
      clear("silence");
      if (rec && started && running) {
        running = false;
        finishing = true;
        try {
          rec.stop();
        } catch {}
        timers.finish = setTimeout(finish, FINISH_GRACE_MS);
        return emit();
      }
      running = false;
      finish();
    },
    cancel() {
      running = false;
      finishing = false;
      clear("restart");
      clear("silence");
      abortRec();
      if (asm.hasWords) {
        asm.discard();
        events.onTranscript(asm.snapshot);
      } else asm.discard();
      failure = null;
      emit();
    },
    setSpeaking(text) {
      speaking = text || null;
      asm.setSpeaking(speaking, now());
      if (speaking) failure = null;
      resetSilence();
      emit();
      schedule();
    },
    setProcessing(active) {
      processing = active;
      if (active) failure = null;
      emit();
    },
    dispose() {
      if (disposed) return;
      engine.cancel();
      disposed = true;
      for (const k of Object.keys(timers) as (keyof typeof timers)[]) clear(k);
      win.document?.removeEventListener("visibilitychange", onVisibility);
    },
  };
  return engine;
}
