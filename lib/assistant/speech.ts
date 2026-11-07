// Feature detection for voice input and read-aloud. Each control is shown only when its API exists.

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

/** Plain-English message for a recognition error code. */
export function voiceErrorMessage(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access is blocked. You can type your question instead.";
  if (code === "no-speech") return "I didn't hear anything. Try again, or type your question.";
  if (code === "aborted") return "";
  return "Voice input stopped working. You can type your question instead.";
}
