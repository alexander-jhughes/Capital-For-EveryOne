"use client";

// Read-aloud for Dial's replies. One utterance at a time; cancelling is always safe.
import { useCallback, useEffect, useRef, useState } from "react";
import { canSpeak, pickVoice } from "@/lib/assistant/speech";

export function useSpeaker() {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const current = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => setSupported(canSpeak(window)), []);

  const cancel = useCallback(() => {
    current.current = null;
    if (canSpeak(window)) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  /** Speaks `text`; `onEnd` runs once when it finishes, fails or is replaced. */
  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!canSpeak(window) || !text.trim()) return onEnd?.();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    const v = pickVoice(window.speechSynthesis.getVoices());
    if (v) u.voice = v;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (current.current === u) {
        current.current = null;
        setSpeaking(false);
      }
      onEnd?.();
    };
    u.onend = end;
    u.onerror = end;
    current.current = u;
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  }, []);

  useEffect(() => cancel, [cancel]);
  return { supported, speaking, speak, cancel };
}
