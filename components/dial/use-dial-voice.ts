"use client";

// The microphone as Dial's surfaces use it: the shared voice engine plus the person's choice of where their voice is
// turned into text. Nothing listens in the background, and the microphone always opens inside the person's own click,
// so the browser's permission prompt appears straight away.
//
// Tapping the microphone:
//   - not chosen yet: starts listening with the browser's speech service, and saves that choice. The panel always
//     says, next to the microphone, that this sends speech to the browser maker. Display and voice can change it.
//   - chose typing: offers the choice again, rather than leaving voice off with no way back.
//   - chose "on this device only", but the browser doesn't have it: offers the choice with a plain explanation.
//   - chose the online service, or on-device is installed: starts listening.
import { useCallback, useEffect, useState } from "react";
import { usePreferences } from "@/lib/preferences/provider";
import type { Preferences } from "@/lib/preferences/schema";
import type { ListenMode, Utterance } from "@/lib/voice/types";
import { useVoiceEngine } from "@/lib/voice/use-voice-engine";
import { useWhisper } from "@/lib/voice/use-whisper";

type SpeechChoice = Exclude<Preferences["speechInput"], "unset">;

export function useDialVoice(opts: { listenMode?: ListenMode; onUtterance(u: Utterance): void; onInterrupt?(reason: "user-speech" | "stop-word" | "backgrounded"): void }) {
  const { prefs, apply } = usePreferences();
  const [asking, setAsking] = useState<{ notice?: string } | null>(null);
  const engine = useVoiceEngine({
    allowCloud: prefs.speechInput === "cloud",
    listenMode: opts.listenMode ?? prefs.listenMode,
    onUtterance: opts.onUtterance,
    onInterrupt: opts.onInterrupt,
  });
  // Clearer recognition (Groq Whisper) has the same shape; it is used instead of the browser's recogniser when chosen.
  const whisper = useWhisper({ onUtterance: opts.onUtterance });
  const useClearer = prefs.speechInput === "whisper";
  const active = useClearer ? whisper : engine;
  const { start: engineStart, error } = engine;

  /** Saved straight away, like any setting changed in Display and voice. Starts listening in the same click. */
  const choose = useCallback(
    (choice: SpeechChoice) => {
      apply([{ type: "speechInput", value: choice }], { save: true, source: "settings" });
      setAsking(null);
      if (choice === "whisper") whisper.start();
      else if (choice !== "typing") engineStart({ allowCloud: choice === "cloud" });
    },
    [apply, engineStart, whisper],
  );

  const start = useCallback(() => {
    setAsking(null);
    if (prefs.speechInput === "unset") return choose("cloud");
    if (prefs.speechInput === "typing") return setAsking({});
    if (prefs.speechInput === "whisper") return whisper.start();
    engineStart();
  }, [prefs.speechInput, engineStart, choose, whisper]);

  // On-device recognition isn't installed in this browser: say so and offer the online service, rather than a dead end.
  useEffect(() => {
    if (error?.code === "language-unavailable" && prefs.speechInput === "on-device") {
      setAsking({ notice: "Your browser doesn't have on-device speech recognition ready, so it can't hear you without its online speech service." });
    }
  }, [error, prefs.speechInput]);

  return {
    ...active,
    start,
    speechInput: prefs.speechInput,
    consent: asking ? { choose, dismiss: () => setAsking(null), notice: asking.notice } : null,
  };
}
