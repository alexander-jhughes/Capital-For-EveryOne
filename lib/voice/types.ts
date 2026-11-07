// CONTRACT (Phase 0, owned by the lead; changes need agreeing with the voice and frontend owners).
//
// One voice engine for the whole app: Dial Voice Mode and the Ask sheet both use it. It turns speech into ONE
// finished utterance at a time and hands it to the same pipeline as typed text (interpret -> local answers ->
// /api/ask). The engine never answers, never acts and never touches money: it only listens and transcribes.
//
// Design (independent implementation of general ideas; no code from any AGPL project):
// - Interim results are shown live but never submitted. An utterance ends on a final result, or when the interim
//   text has stopped changing for a pause (longer after words like "and", "actually", "I mean").
// - Self-corrections ("actually...", "no, I mean...", "scratch that") replace what came before in the same utterance.
// - Each utterance has an id and is delivered at most once. Answers to an older id are discarded by the caller.
// - While Dial is speaking, words that match what Dial is saying are treated as echo, not as the person interrupting.

/** What the person sees and hears. Exactly one at a time. */
export type VoiceState =
  /** Not listening. */
  | "idle"
  /** Waiting for the browser's microphone permission prompt. */
  | "requesting-permission"
  /** Microphone open, nothing heard yet in this utterance. */
  | "listening"
  /** Words are arriving (interim text visible). */
  | "transcribing"
  /** The utterance was handed over and Dial is working on it. */
  | "processing"
  /** Dial is showing or speaking the answer. */
  | "responding"
  /** The person cut Dial off, or the page went to the background. Short-lived, then listening or idle. */
  | "interrupted"
  /** Listening stopped because of an error. See VoiceError. */
  | "failed";

/** tap: one utterance per tap. hold: listen while held (push-to-talk). continuous: keep listening (opt-in). */
export type ListenMode = "tap" | "hold" | "continuous";

/** Where speech is turned into text. "none" means voice input isn't available: offer typing. */
export type RecognitionBackend = "on-device" | "cloud" | "none";

export interface TranscriptSnapshot {
  utteranceId: number;
  /** Final words so far in this utterance (after corrections). */
  finalText: string;
  /** Words still being recognised. Shown, never submitted on their own. */
  interimText: string;
  /** What would be submitted now: finalText + interimText with corrections applied. */
  text: string;
  /** True when a self-correction replaced earlier words. */
  corrected: boolean;
}

export interface Utterance {
  utteranceId: number;
  /** The text to submit. The visible transcript always equals this when it is delivered. */
  text: string;
  corrected: boolean;
  /** "voice" when it ended by itself; "edited" when the person changed the transcript before sending. */
  origin: "voice" | "edited";
}

export type VoiceErrorCode =
  | "not-allowed" // microphone permission refused
  | "no-microphone"
  | "unsupported" // no speech recognition in this browser
  | "network" // cloud recogniser unreachable
  | "language-unavailable" // on-device pack not installed and cloud not allowed
  | "no-speech"
  | "aborted"
  | "failed";

export interface VoiceError {
  code: VoiceErrorCode;
  /** Plain English, ready to show. */
  message: string;
  /** True when trying again might work (no-speech, network); false for permission and unsupported. */
  recoverable: boolean;
}

export interface VoiceEngineEvents {
  onState(state: VoiceState): void;
  onTranscript(snapshot: TranscriptSnapshot): void;
  /** Called at most once per utteranceId, with the final, corrected text. */
  onUtterance(utterance: Utterance): void;
  /** The person spoke over Dial (non-echo words) or said a stop word, or the page was hidden. */
  onInterrupt?(reason: "user-speech" | "stop-word" | "backgrounded"): void;
  onError(error: VoiceError): void;
}

export interface VoiceEngine {
  readonly backend: RecognitionBackend;
  readonly state: VoiceState;
  start(mode: ListenMode): void;
  /** Stop listening and deliver the pending utterance if it has words. */
  stop(): void;
  /** Stop listening and drop the pending utterance. Nothing is submitted. */
  cancel(): void;
  /** Tell the engine what Dial is saying (null when quiet), for echo filtering and barge-in. */
  setSpeaking(text: string | null): void;
  /** The caller finished handling an utterance (answer shown or failed). */
  setProcessing(active: boolean): void;
  dispose(): void;
}
