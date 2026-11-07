// Feature detection for voice input and read-aloud. Each control is shown only when its API exists.

/** One recognised phrase. `isFinal` false means the browser may still change it. */
export interface RecognitionResult extends ArrayLike<{ transcript: string }> {
  isFinal?: boolean;
}

/** Minimal shape of the Web Speech recognition API we use (not in TypeScript's DOM lib). */
export interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous?: boolean;
  /** Chrome: recognise on the device only. Feature-detected; absent elsewhere. */
  processLocally?: boolean;
  onresult: ((e: { resultIndex?: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart?: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}
type Langs = { langs: string[]; processLocally?: boolean };
export type RecognitionCtor = (new () => Recognition) & {
  available?: (o: Langs) => Promise<string>;
  install?: (o: Langs) => Promise<boolean>;
};

export function getRecognition(win: unknown): RecognitionCtor | null {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined;
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null;
}

/** Whether this browser can recognise `lang` on the device: available now, after a download, or not at all. */
export type OnDeviceStatus = "available" | "downloadable" | "downloading" | "unavailable";

export async function onDeviceStatus(win: unknown, lang = "en-GB"): Promise<OnDeviceStatus> {
  const Rec = getRecognition(win);
  if (typeof Rec?.available !== "function") return "unavailable";
  try {
    const s = await Rec.available({ langs: [lang], processLocally: true });
    return s === "available" || s === "downloadable" || s === "downloading" ? s : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Downloads the on-device language pack. Must run from a tap (the browser needs a user gesture). */
export async function installOnDevice(win: unknown, lang = "en-GB"): Promise<boolean> {
  const Rec = getRecognition(win);
  if (typeof Rec?.install !== "function") return false;
  try {
    return (await Rec.install({ langs: [lang], processLocally: true })) === true;
  } catch {
    return false;
  }
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

/** Plain-English message for a recognition error code (browser codes and VoiceErrorCode alike). */
export function voiceErrorMessage(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access is blocked. You can type your question instead.";
  if (code === "no-speech") return "I didn't hear anything. Try again, or type your question.";
  if (code === "aborted") return "";
  if (code === "audio-capture" || code === "no-microphone") return "I can't find a microphone. Check it's plugged in, or type your question instead.";
  if (code === "network") return "The speech service couldn't be reached. Check your connection and try again, or type your question.";
  if (code === "language-not-supported" || code === "language-unavailable")
    return "Speech for British English isn't ready on this device. You can change voice input to the online service, or type your question.";
  if (code === "unsupported") return "Voice input isn't available in this browser. You can type instead.";
  return "Voice input stopped working. You can type your question instead.";
}
