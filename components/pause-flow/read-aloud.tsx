"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { actionClass } from "@/components/spend-pause/styles";
import { canSpeak, pickVoice } from "@/lib/assistant/speech";

/** Reads a sentence on request, in a British voice where there is one. Never plays by itself, and hides if unsupported. */
export function ReadAloud({ text }: { text: string }) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setSupported(canSpeak(window));
    return () => {
      if (canSpeak(window)) window.speechSynthesis.cancel();
    };
  }, []);

  if (!supported) return null;

  const toggle = () => {
    window.speechSynthesis.cancel();
    if (speaking) return setSpeaking(false);
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(window.speechSynthesis.getVoices());
    if (voice) utterance.voice = voice;
    utterance.lang = "en-GB";
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  return (
    <Button variant="outline" onClick={toggle} className={`${actionClass} border-input`}>
      {speaking ? "Stop reading" : "Read aloud"}
    </Button>
  );
}
