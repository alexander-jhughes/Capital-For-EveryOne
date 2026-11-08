// Feature detection for voice input and read-aloud. Each control is shown only when its API exists.

import type { VoiceError, VoiceErrorCode } from "../voice/types";

/** Minimal shape of the Web Speech recognition API we use (not in TypeScript's DOM lib). */
export interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

export function getRecognition(win: unknown): RecognitionCtor | null {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined;
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null;
}

export function canSpeak(win: unknown): boolean {
  const w = win as { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown } | undefined;
  return !!w?.speechSynthesis && typeof w.SpeechSynthesisUtterance === "function";
}

/** Prefers a British English voice, then any English voice, else the browser default (null). */
export function pickVoice<V extends { lang: string }>(voices: V[]): V | null {
  const norm = (l: string) => l.toLowerCase().replace("_", "-");
  return voices.find((v) => norm(v.lang) === "en-gb") ?? voices.find((v) => norm(v.lang).startsWith("en")) ?? null;
}

/** Plain-English message for a recognition error code (the browser's code, or the engine's VoiceErrorCode). */
export function voiceErrorMessage(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access is blocked. You can type your question instead.";
  if (code === "no-speech") return "I didn't hear anything. Try again, or type your question.";
  if (code === "aborted") return "";
  if (code === "audio-capture" || code === "no-microphone") return "I can't find a microphone. Check one is connected, or type your question instead.";
  if (code === "network") return "I couldn't reach your browser's speech service. Check your connection and try again, or type your question.";
  if (code === "unsupported") return "Voice input isn't available in this browser. You can type your question instead.";
  if (code === "language-not-supported" || code === "language-unavailable") {
    return "Voice input isn't ready on this device yet. You can type your question, or allow your browser's speech service in Display and voice.";
  }
  return "Voice input stopped working. You can type your question instead.";
}

// The fuller recogniser the voice engine (lib/voice/engine.ts) drives. Separate from Recognition above so the
// existing callers keep their narrow type. Members that differ between browsers are optional.

/** The browser's result list: the best alternative first, and whether the result is final. */
export type RecognitionResults = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;

export interface LiveRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chrome's on-device recognition: when true, audio never leaves the device. */
  processLocally?: boolean;
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onresult: ((e: { resultIndex?: number; results: RecognitionResults }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

/** Chrome's answer to "can you recognise this language on the device?". */
export type OnDeviceAvailability = "available" | "downloadable" | "downloading" | "unavailable";

export interface LiveRecognitionClass {
  new (): LiveRecognition;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<OnDeviceAvailability>;
}

export function getLiveRecognition(win: unknown): LiveRecognitionClass | null {
  return getRecognition(win) as unknown as LiveRecognitionClass | null;
}

/** Whether `lang` can be recognised on the device. Null when the browser has no way to say (no on-device API). */
export async function onDeviceAvailability(win: unknown, lang: string): Promise<OnDeviceAvailability | null> {
  const Rec = getLiveRecognition(win);
  if (typeof Rec?.available !== "function") return null;
  try {
    // A browser that never answers counts as "can't say", so the microphone button can't hang waiting for it.
    return await Promise.race([
      Rec.available({ langs: [lang], processLocally: true }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  } catch {
    return null;
  }
}

const ERROR_CODES: Record<string, VoiceErrorCode> = {
  "not-allowed": "not-allowed",
  "service-not-allowed": "not-allowed",
  "audio-capture": "no-microphone",
  network: "network",
  "no-speech": "no-speech",
  aborted: "aborted",
  "language-not-supported": "language-unavailable",
};

/** A VoiceError for one of our codes, with its plain-English message. */
export function voiceError(code: VoiceErrorCode): VoiceError {
  return { code, message: voiceErrorMessage(code), recoverable: code === "network" || code === "no-speech" || code === "failed" };
}

/** Maps the browser's recognition error code to a VoiceError. Null for "aborted", which is never shown. */
export function recognitionError(browserCode: string): VoiceError | null {
  const code = ERROR_CODES[browserCode] ?? "failed";
  return code === "aborted" ? null : voiceError(code);
}
