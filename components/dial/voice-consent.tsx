"use client";

import { Keyboard, Laptop, Globe } from "lucide-react";

const btn = "inline-flex min-h-(--target-min) w-full items-center gap-3 rounded-xl px-4 py-2 text-left font-bold";

/** Asked once, before the microphone is first used. The choice is saved and can be changed in Display and voice. */
/** Who runs the browser's online speech service, so the choice names them. Null when we can't tell. */
function speechProvider(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  return /Edg\//.test(ua) ? "Microsoft" : /Chrome\//.test(ua) ? "Google" : /Safari\//.test(ua) ? "Apple" : null;
}

export function VoiceConsent({ tone, notice, onChoose, onDismiss }: { tone: "light" | "voice"; notice?: string; onChoose: (c: "on-device" | "cloud" | "typing") => void; onDismiss: () => void }) {
  const voice = tone === "voice";
  const provider = speechProvider();
  const option = `${btn} ${voice ? "bg-[#27314a] text-[#f5f5f2]" : "hairline bg-card"}`;
  const muted = voice ? "text-[#aab4c8]" : "text-muted-foreground";
  return (
    <section aria-labelledby="voice-consent-h" className={`flex flex-col gap-3 rounded-2xl p-(--space) ${voice ? "bg-[#1c2640]" : "bg-accent text-accent-foreground"}`}>
      <h3 id="voice-consent-h" className="text-lg font-bold">
        Before Dial listens
      </h3>
      {notice && <p role="alert" className="font-bold">{notice}</p>}
      <p>Your browser turns your voice into text. Choose where that happens. Dial never records audio and only listens after you tap the microphone. Your browser will then ask to use your microphone.</p>
      <button type="button" className={option} onClick={() => onChoose("cloud")}>
        <Globe aria-hidden className="size-[1.2em] shrink-0" />
        <span>
          Allow my browser&apos;s online speech service
          <span className={`block text-sm font-normal ${muted}`}>Works in more browsers. While the microphone is on, the sound of your voice is sent to {provider ?? "your browser's maker (for example Google in Chrome)"} to turn it into text.</span>
        </span>
      </button>
      <button type="button" className={option} onClick={() => onChoose("on-device")}>
        <Laptop aria-hidden className="size-[1.2em] shrink-0" />
        <span>
          On this device only (experimental)
          <span className={`block text-sm font-normal ${muted}`}>Private: audio stays on this device. Needs Chrome 139 or newer with the language pack installed, and may not work yet.</span>
        </span>
      </button>
      <button type="button" className={option} onClick={() => onChoose("typing")}>
        <Keyboard aria-hidden className="size-[1.2em] shrink-0" />
        I&apos;ll type instead
      </button>
      <button type="button" onClick={onDismiss} className={`self-start text-sm font-bold underline underline-offset-4 ${muted}`}>
        Not now
      </button>
    </section>
  );
}
