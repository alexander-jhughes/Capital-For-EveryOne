"use client";

import { Cloud, Keyboard, Smartphone } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { getRecognition, installOnDevice, onDeviceStatus, type OnDeviceStatus } from "@/lib/assistant/speech";
import { usePreferences } from "@/lib/preferences/provider";
import type { Preferences } from "@/lib/preferences/schema";

export type SpeechChoice = Exclude<Preferences["speechInput"], "unset">;

/** Short names for the current choice (for Settings and the "Voice input" line in Voice Mode). */
export const SPEECH_INPUT_LABELS: Record<Preferences["speechInput"], string> = {
  unset: "Not chosen yet",
  "on-device": "On this device only",
  cloud: "Your browser's online speech service",
  typing: "Typing instead",
};

export const CLOUD_DISCLOSURE =
  "Your voice is sent to your browser's speech service (Google in Chrome, Apple in Safari) to turn it into text. Dial doesn't keep recordings.";

const TONES = {
  dark: {
    card: "border border-[#aab4c8] bg-[#1c2640] text-[#f5f5f2] hover:bg-[#27314a]",
    hint: "text-[#c9d1df]",
    current: "outline outline-2 outline-[#6cc4e8]",
    alert: "bg-[#3a1f2a] text-[#ffb4ad]",
    plain: "border border-[#aab4c8]",
  },
  app: {
    card: "hairline bg-background text-foreground hover:bg-accent",
    hint: "text-muted-foreground",
    current: "outline outline-2 outline-primary",
    alert: "bg-accent text-accent-foreground",
    plain: "hairline bg-card",
  },
};

/**
 * Asks where speech may be turned into text, before the microphone is first used (or to change it later).
 * Saved straight away with no source, so it is never counted as a display change by the ML suggestions.
 */
export function SpeechConsent({ tone = "app", onDone, onCancel }: { tone?: keyof typeof TONES; onDone?: (choice: SpeechChoice) => void; onCancel?: () => void }) {
  const { prefs, apply } = usePreferences();
  const id = useId();
  const t = TONES[tone];
  const [device, setDevice] = useState<OnDeviceStatus | "checking">("checking");
  const [recognition, setRecognition] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let live = true;
    setRecognition(!!getRecognition(window));
    void onDeviceStatus(window).then((s) => live && setDevice(s));
    return () => {
      live = false;
    };
  }, []);

  const choose = (value: SpeechChoice) => {
    apply([{ type: "speechInput", value }], { save: true });
    onDone?.(value);
  };

  async function chooseOnDevice() {
    if (device === "available") return choose("on-device");
    setBusy(true);
    setMessage("Downloading the British English speech pack. This can take a minute.");
    const ok = await installOnDevice(window); // runs from this tap: the browser asks for a user gesture
    setBusy(false);
    if (ok) {
      setMessage("");
      return choose("on-device");
    }
    setMessage("The speech pack couldn't be downloaded. You can use your browser's online speech service, or type instead.");
  }

  const option = (value: SpeechChoice, Icon: typeof Cloud, title: string, hint: string, onClick: () => void) => (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-describedby={`${id}-${value}`}
        className={`flex min-h-(--target-min) w-full items-start gap-3 rounded-xl p-3 text-left disabled:opacity-60 ${t.card} ${prefs.speechInput === value ? t.current : ""}`}
      >
        <Icon aria-hidden className="mt-0.5 size-[1.2em] shrink-0" />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-bold">
            {title}
            {prefs.speechInput === value && <span className="font-normal"> (your choice now)</span>}
          </span>
          <span id={`${id}-${value}`} className={`text-sm ${t.hint}`}>
            {hint}
          </span>
        </span>
      </button>
    </li>
  );

  const local = device === "available" || device === "downloadable" || device === "downloading";
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3 id={`${id}-title`} className="text-lg font-bold">
        How should Dial hear you?
      </h3>
      <p className={`text-sm ${t.hint}`}>Choose once. You can change it any time. Dial only listens after you tap or hold the microphone.</p>
      {device === "checking" && recognition ? (
        <p role="status" className={`text-sm ${t.hint}`}>
          Checking what this browser can do...
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {recognition &&
            local &&
            option(
              "on-device",
              Smartphone,
              "On this device only",
              device === "available"
                ? "Your voice is turned into text on this device and isn't sent anywhere."
                : "Your voice is turned into text on this device and isn't sent anywhere. First your browser downloads a British English speech pack, once.",
              () => void chooseOnDevice(),
            )}
          {recognition && option("cloud", Cloud, "Use my browser's online speech service", CLOUD_DISCLOSURE, () => choose("cloud"))}
          {option("typing", Keyboard, "Type instead", recognition ? "Use the keyboard. You can turn voice on later." : "Voice input isn't available in this browser, so typing is the way to talk to Dial here.", () =>
            choose("typing"),
          )}
        </ul>
      )}
      {message && (
        <p role={busy ? "status" : "alert"} className={`rounded-xl p-3 text-sm ${t.alert}`}>
          {message}
        </p>
      )}
      {onCancel && (
        <button type="button" onClick={onCancel} className={`inline-flex min-h-(--target-min) items-center justify-center self-start rounded-full px-5 font-bold ${t.plain}`}>
          Not now
        </button>
      )}
    </section>
  );
}
