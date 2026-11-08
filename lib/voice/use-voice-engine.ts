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
  /** Starts listening. `allowCloud` overrides the option for this start (a choice the person just made in the same click). */
  start(override?: { allowCloud?: boolean }): void;
  stop(): void;
  cancel(): void;
  pause(): void;
  resume(): void;
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
  /** The allowCloud the current engine was made with. */
  const engineCloud = useRef<boolean | null>(null);
  // What the caller last told us, replayed onto an engine created later (or recreated after allowCloud changes).
  const speaking = useRef<string | null>(null);
  const processing = useRef(false);

  const disposeEngine = useCallback(() => {
    engine.current?.dispose();
    engine.current = null;
    engineCloud.current = null;
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
    // An engine already made with this setting (started in the same click as the choice) keeps listening.
    if (engineCloud.current === allowCloud) return;
    disposeEngine();
    settle();
    setSnapshot(null);
    setBackend("none");
  }, [allowCloud, disposeEngine, settle]);

  useEffect(() => disposeEngine, [disposeEngine]);

  const start = useCallback((override?: { allowCloud?: boolean }) => {
    const cloud = override?.allowCloud ?? latest.current.allowCloud;
    if (engine.current && engineCloud.current !== cloud) disposeEngine();
    if (!engine.current) {
      const e = createVoiceEngine({
        win: window,
        lang: LANG,
        allowCloud: cloud,
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
      engineCloud.current = cloud;
    }
    setError(null);
    engine.current.start(latest.current.listenMode);
  }, [disposeEngine]);

  const stop = useCallback(() => engine.current?.stop(), []);
  const cancel = useCallback(() => engine.current?.cancel(), []);
  const pause = useCallback(() => engine.current?.pause(), []);
  const resume = useCallback(() => engine.current?.resume(), []);
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

  return { supported, backend, state, snapshot, error, start, stop, cancel, pause, resume, setSpeaking, setProcessing };
}
