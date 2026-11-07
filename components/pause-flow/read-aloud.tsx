"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { actionClass } from "@/components/spend-pause/styles";
import { canSpeak, pickVoice, SPEECH_RATE } from "@/lib/assistant/speech";
import { usePreferences } from "@/lib/preferences/provider";
import { usePersonalisation } from "@/lib/personalisation/provider";

/** Reads a sentence on request, in a British voice where there is one. Never plays by itself, and hides if unsupported. */
export function ReadAloud({ text }: { text: string }) {
  // Counts the tap only (no text), and only when display suggestions are switched on.
  const { noteReadAloud } = usePersonalisation();
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const { prefs } = usePreferences();

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
    noteReadAloud();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(window.speechSynthesis.getVoices());
    if (voice) utterance.voice = voice;
    utterance.lang = "en-GB";
    utterance.rate = SPEECH_RATE[prefs.voiceRate];
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
