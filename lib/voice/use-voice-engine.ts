"use client";

// React binding for the voice engine. The engine is created on the first start(), never at import or render, so
// nothing touches the microphone until the person asks. Callbacks are read through refs: a new onUtterance on every
// render must never restart recognition.

import { useCallback, useEffect, useRef, useState } from "react";
import { getRecognition } from "../assistant/speech";
import { createVoiceEngine } from "./engine";
import type { ListenMode, RecognitionBackend, TranscriptSnapshot, Utterance, VoiceEngine, VoiceError, VoiceState } from "./types";

const LANG = "en-GB";

export interface UseVoiceEngineOptions {
  /** The person agreed to the browser's online speech service (speechInput "cloud"). */
  allowCloud: boolean;
  /** Read when start() is called. */
  listenMode: ListenMode;
  onUtterance(u: Utterance): void;
  onInterrupt?(reason: "user-speech" | "stop-word" | "backgrounded"): void;
}

export function useVoiceEngine(opts: UseVoiceEngineOptions): {
  supported: boolean;
  backend: RecognitionBackend;
  state: VoiceState;
  snapshot: TranscriptSnapshot | null;
  error: VoiceError | null;
  start(): void;
  stop(): void;
  cancel(): void;
  setSpeaking(text: string | null): void;
  setProcessing(active: boolean): void;
} {
  const [supported, setSupported] = useState(false);
  const [backend, setBackend] = useState<RecognitionBackend>("none");
  const [state, setState] = useState<VoiceState>("idle");
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot | null>(null);
  const [error, setError] = useState<VoiceError | null>(null);

  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const engine = useRef<VoiceEngine | null>(null);
  // What the caller last told us, replayed onto an engine created later (or recreated after allowCloud changes).
  const speaking = useRef<string | null>(null);
  const processing = useRef(false);

  const disposeEngine = useCallback(() => {
    engine.current?.dispose();
    engine.current = null;
  }, []);

  // Before the first start() there is no engine, but the state still follows what Dial is doing.
  const settle = useCallback(() => {
    if (!engine.current) setState(speaking.current ? "responding" : processing.current ? "processing" : "idle");
  }, []);

  // Feature-detect after mount so the server render and the first client render agree.
  useEffect(() => setSupported(!!getRecognition(window)), []);

  // Changing consent drops the old engine, so a cloud session can't carry on after the person switches it off.
  // The backend is only worked out when the person taps the microphone (the engine does it in start() and reports it
  // through onState). It is deliberately not probed on mount: SpeechRecognition.available() can crash some browsers
  // (it did in headless Chromium), and it would run on every page load just to fill in a label.
  const { allowCloud } = opts;
  useEffect(() => {
    disposeEngine();
    settle();
    setSnapshot(null);
    setBackend("none");
  }, [allowCloud, disposeEngine, settle]);

  useEffect(() => disposeEngine, [disposeEngine]);

  const start = useCallback(() => {
    if (!engine.current) {
      const e = createVoiceEngine({
        win: window,
        lang: LANG,
        allowCloud: latest.current.allowCloud,
        events: {
          onState: (s) => {
            setState(s);
            setBackend(e.backend);
          },
          onTranscript: (s) => setSnapshot(s.text ? s : null),
          onUtterance: (u) => latest.current.onUtterance(u),
          onInterrupt: (r) => latest.current.onInterrupt?.(r),
          onError: setError,
        },
      });
      e.setSpeaking(speaking.current);
      e.setProcessing(processing.current);
      engine.current = e;
    }
    setError(null);
    engine.current.start(latest.current.listenMode);
  }, []);

  const stop = useCallback(() => engine.current?.stop(), []);
  const cancel = useCallback(() => engine.current?.cancel(), []);
  const setSpeaking = useCallback(
    (text: string | null) => {
      speaking.current = text;
      engine.current?.setSpeaking(text);
      settle();
    },
    [settle],
  );
  const setProcessing = useCallback(
    (active: boolean) => {
      processing.current = active;
      engine.current?.setProcessing(active);
      settle();
    },
    [settle],
  );

  return { supported, backend, state, snapshot, error, start, stop, cancel, setSpeaking, setProcessing };
}
