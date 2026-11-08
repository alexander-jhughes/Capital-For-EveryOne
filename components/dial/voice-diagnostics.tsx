"use client";

// "Voice not working?" in one click: what the browser supports, whether the microphone is allowed, which speech
// service is chosen, what the engine is doing and the last error. Read-only; nothing here opens the microphone.
import { useEffect, useState } from "react";
import { getRecognition } from "@/lib/assistant/speech";
import type { Preferences } from "@/lib/preferences/schema";
import type { RecognitionBackend, VoiceError, VoiceState } from "@/lib/voice/types";

type PermissionState = "granted" | "denied" | "prompt" | "unknown";

interface Facts {
  supported: boolean;
  onDeviceApi: boolean;
  secure: boolean;
  permission: PermissionState;
  browser: string;
}

/** Reads what the browser will say about itself. Safe on any browser: anything missing reads as unknown. */
async function readFacts(): Promise<Facts> {
  const Rec = getRecognition(window);
  const proto = (Rec as unknown as { prototype?: object } | null)?.prototype;
  let permission: PermissionState = "unknown";
  try {
    // Chrome and Edge answer; Safari and Firefox throw for "microphone". Either way nothing is opened.
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    permission = status.state as PermissionState;
  } catch {
    permission = "unknown";
  }
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "this browser";
  return { supported: !!Rec, onDeviceApi: !!proto && "processLocally" in proto, secure: window.isSecureContext, permission, browser };
}

const STATE_WORDS: Record<VoiceState, string> = {
  idle: "not listening",
  "requesting-permission": "waiting for the browser to start the microphone",
  listening: "listening",
  transcribing: "hearing words",
  processing: "working on what you said",
  responding: "speaking",
  interrupted: "stopped",
  failed: "stopped after an error",
};

export function VoiceDiagnostics({
  tone,
  open,
  state,
  backend,
  error,
  speechInput,
}: {
  tone: "light" | "voice";
  /** Opened automatically after an error, so the person sees why without hunting. */
  open?: boolean;
  state: VoiceState;
  backend: RecognitionBackend;
  error: VoiceError | null;
  speechInput: Preferences["speechInput"];
}) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [shown, setShown] = useState(!!open);
  useEffect(() => {
    if (open) setShown(true);
  }, [open]);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    void readFacts().then((f) => live && setFacts(f));
    return () => {
      live = false;
    };
  }, [shown, state, error]);

  const voice = tone === "voice";
  const muted = voice ? "text-[#aab4c8]" : "text-muted-foreground";
  const good = voice ? "text-[#86e0a6]" : "text-success";
  const bad = voice ? "text-[#ffb4ad]" : "text-attention";

  const rows: { label: string; value: string; ok: boolean | null }[] = facts
    ? [
        { label: "Browser", value: facts.browser, ok: null },
        { label: "Voice input in this browser", value: facts.supported ? "available" : "not available (Chrome or Edge have it)", ok: facts.supported },
        { label: "Secure page", value: facts.secure ? "yes" : "no (voice needs https or localhost)", ok: facts.secure },
        {
          label: "Microphone permission",
          value:
            facts.permission === "granted"
              ? "allowed"
              : facts.permission === "denied"
                ? "blocked. Click the icon at the left of the address bar to allow it"
                : facts.permission === "prompt"
                  ? "not asked yet. The browser asks when you tap the microphone"
                  : "unknown (this browser doesn't say)",
          ok: facts.permission === "granted" ? true : facts.permission === "denied" ? false : null,
        },
        {
          label: "Where speech is turned into text",
          value:
            speechInput === "cloud"
              ? "your browser's speech service"
              : speechInput === "on-device"
                ? facts.onDeviceApi
                  ? "on this device (experimental, needs the language pack)"
                  : "on this device, but this browser can't do that"
                : speechInput === "typing"
                  ? "voice is off, typing only"
                  : "not chosen yet",
          ok: speechInput === "on-device" && !facts.onDeviceApi ? false : null,
        },
        { label: "Dial is", value: `${STATE_WORDS[state]}${backend !== "none" && state !== "idle" && state !== "failed" ? ` (${backend === "on-device" ? "on this device" : "browser speech service"})` : ""}`, ok: null },
        { label: "Last problem", value: error ? `${error.message} (${error.code})` : "none", ok: error ? false : null },
      ]
    : [];

  return (
    <details open={shown} onToggle={(e) => setShown((e.target as HTMLDetailsElement).open)} className={`rounded-xl ${voice ? "bg-[#1c2640]" : "bg-accent text-accent-foreground"}`}>
      <summary className={`flex min-h-(--target-min) cursor-pointer items-center px-3 text-sm font-bold ${muted}`}>Voice not working? See why</summary>
      <dl className="flex flex-col gap-1.5 px-3 pb-3 text-sm">
        {rows.length === 0 && <p className={muted}>Checking...</p>}
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap gap-x-2">
            <dt className={`shrink-0 ${muted}`}>{r.label}:</dt>
            <dd className={`font-semibold ${r.ok === true ? good : r.ok === false ? bad : ""}`}>{r.value}</dd>
          </div>
        ))}
        {facts && (
          <p className={`pt-1 ${muted}`}>
            If the microphone still doesn&apos;t start, reload the page and tap it once more. Typing always works.
          </p>
        )}
      </dl>
    </details>
  );
}
