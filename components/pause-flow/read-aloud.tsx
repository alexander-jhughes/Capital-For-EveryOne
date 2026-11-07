"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { actionClass } from "@/components/spend-pause/styles";

/** Reads a sentence on request, in a British voice where there is one. Never plays by itself, and hides if unsupported. */
export function ReadAloud({ text }: { text: string }) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setSupported("speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function");
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  if (!supported) return null;

  const toggle = () => {
    window.speechSynthesis.cancel();
    if (speaking) return setSpeaking(false);
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.toLowerCase().replace("_", "-") === "en-gb") ?? voices.find((v) => v.lang.toLowerCase().startsWith("en"));
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
