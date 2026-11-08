"use client";

// The microphone as Dial's surfaces use it: the shared voice engine, behind the person's choice of where their voice
// is turned into text. Nothing listens until they have chosen, and nothing listens in the background.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePreferences } from "@/lib/preferences/provider";
import type { Preferences } from "@/lib/preferences/schema";
import type { ListenMode, Utterance } from "@/lib/voice/types";
import { useVoiceEngine } from "@/lib/voice/use-voice-engine";

type SpeechChoice = Exclude<Preferences["speechInput"], "unset">;

export function useDialVoice(opts: { listenMode?: ListenMode; onUtterance(u: Utterance): void; onInterrupt?(reason: "user-speech" | "stop-word" | "backgrounded"): void }) {
  const { prefs, apply } = usePreferences();
  const [askingConsent, setAskingConsent] = useState(false);
  const startAfterChoice = useRef(false);
  const engine = useVoiceEngine({
    allowCloud: prefs.speechInput === "cloud",
    listenMode: opts.listenMode ?? prefs.listenMode,
    onUtterance: opts.onUtterance,
    onInterrupt: opts.onInterrupt,
  });
  const { start: engineStart } = engine;

  const start = useCallback(() => {
    // "typing" is a choice the person can change their mind about: tapping the microphone offers the choice again
    // instead of leaving voice switched off with no way back.
    if (prefs.speechInput === "unset" || prefs.speechInput === "typing") return setAskingConsent(true);
    engineStart();
  }, [prefs.speechInput, engineStart]);

  /** Saved straight away, like any setting changed in Display and voice; it can be changed there later. */
  const choose = useCallback(
    (choice: SpeechChoice) => {
      apply([{ type: "speechInput", value: choice }], { save: true, source: "settings" });
      setAskingConsent(false);
      startAfterChoice.current = choice !== "typing";
    },
    [apply],
  );

  // Start once the engine has been rebuilt with the new choice (allowCloud changes with it).
  useEffect(() => {
    if (!startAfterChoice.current || prefs.speechInput === "unset" || prefs.speechInput === "typing") return;
    startAfterChoice.current = false;
    engineStart();
  }, [prefs.speechInput, engineStart]);

  return {
    ...engine,
    start,
    speechInput: prefs.speechInput,
    consent: askingConsent ? { choose, dismiss: () => setAskingConsent(false) } : null,
  };
}
