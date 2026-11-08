"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getRecognition } from "../assistant/speech";
import type { Preferences } from "../preferences/schema";
import { createVoiceEngine, type BrowserVoiceEngine } from "./engine";
import type { ListenMode, RecognitionBackend, TranscriptSnapshot, Utterance, VoiceEngineEvents, VoiceError, VoiceState } from "./types";

/** Microphone use needs the person's choice first (Settings, or the chooser shown on first tap). */
export const needsSpeechChoice = (speechInput: Preferences["speechInput"]) => speechInput === "unset" || speechInput === "typing";

/**
 * The shared voice engine for a component. Created after mount (never on the server) and again when the person
 * changes where speech is turned into text. Handlers may change every render; the latest ones are always used.
 */
export function useVoice({
  speechInput,
  onUtterance,
  onInterrupt,
  lang = "en-GB",
}: {
  speechInput: Preferences["speechInput"];
  onUtterance: (u: Utterance) => void;
  onInterrupt?: VoiceEngineEvents["onInterrupt"];
  lang?: string;
}) {
  const engine = useRef<BrowserVoiceEngine | null>(null);
  const handlers = useRef({ onUtterance, onInterrupt });
  const startWhenReady = useRef<ListenMode | null>(null);
  const [state, setState] = useState<VoiceState>("idle");
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptSnapshot | null>(null);
  const [error, setError] = useState<VoiceError | null>(null);
  const [backend, setBackend] = useState<RecognitionBackend>("none");
  const [recognition, setRecognition] = useState(false);

  useEffect(() => {
    handlers.current = { onUtterance, onInterrupt };
  });

  useEffect(() => {
    const e = createVoiceEngine(
      window,
      {
        onState: (s) => {
          setState(s);
          setListening(engine.current?.listening ?? false);
        },
        onTranscript: setTranscript,
        onUtterance: (u) => {
          setTranscript(null);
          handlers.current.onUtterance(u);
        },
        onInterrupt: (r) => handlers.current.onInterrupt?.(r),
        onError: setError,
      },
      { speechInput, lang },
    );
    engine.current = e;
    setBackend(e.backend);
    setRecognition(!!getRecognition(window));
    setState(e.state);
    // The person just chose voice input from the mic button: start as they asked.
    if (startWhenReady.current && e.backend !== "none") e.start(startWhenReady.current);
    startWhenReady.current = null;
    return () => {
      engine.current = null;
      e.dispose();
    };
  }, [speechInput, lang]);

  const api = useMemo(
    () => ({
      start(mode: ListenMode) {
        setError(null);
        engine.current?.start(mode);
      },
      /** Start once the engine for a just-saved speech choice exists. */
      startWhenReady(mode: ListenMode) {
        setError(null);
        startWhenReady.current = mode;
      },
      stop: () => engine.current?.stop(),
      cancel() {
        setError(null);
        engine.current?.cancel();
      },
      setSpeaking: (text: string | null) => engine.current?.setSpeaking(text),
      setProcessing: (active: boolean) => engine.current?.setProcessing(active),
    }),
    [],
  );

  return { state, listening, transcript, error, backend, recognition, ...api };
}

/**
 * Props for a microphone button. Hold mode: listen while the pointer, Space or Enter is held. A plain click (as
 * screen readers and switch access send) toggles in every mode, so holding is never the only way.
 */
export function useMicButton({ hold, listening, onStart, onStop }: { hold: boolean; listening: boolean; onStart: () => void; onStop: () => void }) {
  const held = useRef(false);
  const releasedAt = useRef(0);
  const press = () => {
    if (held.current) return;
    held.current = true;
    onStart();
  };
  const release = () => {
    if (!held.current) return;
    held.current = false;
    releasedAt.current = Date.now();
    onStop();
  };
  const toggle = () => (listening ? onStop() : onStart());
  const isKey = (k: string) => k === " " || k === "Enter";
  const props: React.ButtonHTMLAttributes<HTMLButtonElement> = hold
    ? {
        onPointerDown: (e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          press();
        },
        onPointerUp: release,
        onPointerCancel: release,
        onBlur: release,
        onContextMenu: (e) => e.preventDefault(),
        onKeyDown: (e) => {
          if (!isKey(e.key)) return;
          e.preventDefault();
          if (!e.repeat) press();
        },
        onKeyUp: (e) => {
          if (!isKey(e.key)) return;
          e.preventDefault();
          release();
        },
        // The click that follows a hold is not a second request.
        onClick: () => Date.now() - releasedAt.current < 600 || toggle(),
      }
    : { onClick: toggle };
  return { props, press, release, held };
}
