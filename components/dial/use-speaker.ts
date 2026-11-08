"use client";

// Read-aloud for Dial's replies (the browser's speech synthesis, never the microphone). One utterance at a time;
// cancelling is always safe.
import { useCallback, useEffect, useRef, useState } from "react";
import { canSpeak, pickVoice, SPEECH_RATE } from "@/lib/assistant/speech";
import { usePreferences } from "@/lib/preferences/provider";

export function useSpeaker() {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const current = useRef<SpeechSynthesisUtterance | null>(null);
  const { prefs } = usePreferences();
  const rate = SPEECH_RATE[prefs.voiceRate];

  useEffect(() => setSupported(canSpeak(window)), []);

  const cancel = useCallback(() => {
    current.current = null;
    if (canSpeak(window)) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume?.();
    }
    setSpeaking(false);
    setPaused(false);
  }, []);

  const pause = useCallback(() => {
    if (!current.current || !canSpeak(window)) return;
    window.speechSynthesis.pause();
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    if (!current.current || !canSpeak(window)) return;
    window.speechSynthesis.resume?.();
    setPaused(false);
  }, []);

  /** Speaks `text`; `onEnd` runs once when it finishes, fails or is replaced. */
  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!canSpeak(window) || !text.trim()) return onEnd?.();
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume?.();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    u.rate = rate;
    const v = pickVoice(window.speechSynthesis.getVoices());
    if (v) u.voice = v;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (current.current === u) {
        current.current = null;
        setSpeaking(false);
        setPaused(false);
      }
      onEnd?.();
    };
    u.onend = end;
    u.onerror = end;
    current.current = u;
    setSpeaking(true);
    setPaused(false);
    window.speechSynthesis.speak(u);
  }, [rate]);

  useEffect(() => cancel, [cancel]);
  return { supported, speaking, paused, speak, pause, resume, cancel };
}
