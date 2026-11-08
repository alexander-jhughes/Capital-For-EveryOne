// Pure transcript helpers for the voice engine. No timers, no browser: everything here is plain text in, text out,
// so the rules that decide what gets submitted can be tested on their own.

import { splitCorrection } from "./correction";
import type { TranscriptSnapshot } from "./types";

/** One recognition result as the browser gives it: the best alternative first, and whether it is final. */
export type ResultLike = ArrayLike<{ transcript: string }> & { isFinal?: boolean };

/** Collapses runs of whitespace and trims. Recognisers often leave leading spaces on later results. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Joins transcript pieces with single spaces, skipping empty ones. */
export function joinParts(...parts: string[]): string {
  return normalise(parts.filter(Boolean).join(" "));
}

/** True when the text has something worth submitting (not just spaces or punctuation). */
export function hasWords(text: string): boolean {
  return /[a-z0-9]/i.test(foldAccents(text));
}

/**
 * Reads a browser result list from `from` onwards. Results before `from` belong to utterances already handled.
 * Browsers list final results before interim ones, so the final words always come first.
 */
export function readResults(results: ArrayLike<ResultLike>, from = 0): { final: string; interim: string } {
  const final: string[] = [];
  const interim: string[] = [];
  for (let i = Math.max(0, from); i < results.length; i++) {
    const r = results[i];
    const t = r?.[0]?.transcript ?? "";
    (r?.isFinal ? final : interim).push(t);
  }
  return { final: joinParts(...final), interim: joinParts(...interim) };
}

export interface Transcript {
  snapshot: TranscriptSnapshot;
  /** The words a self-correction replaced, when there was one. */
  replaces?: string;
}

/**
 * Builds what the person sees from the final and interim words of one utterance, with the last self-correction
 * applied. `text` always equals finalText and interimText joined, so the screen never shows one thing and submits
 * another. When the correction phrase is still in the interim words, the corrected tail is all interim.
 */
export function buildTranscript(utteranceId: number, finalWords: string, interimWords: string): Transcript {
  const final = normalise(finalWords);
  const interim = normalise(interimWords);
  const raw = joinParts(final, interim);
  const split = splitCorrection(raw);
  if (!split) {
    return { snapshot: { utteranceId, finalText: final, interimText: interim, text: raw, corrected: false } };
  }
  // splitCorrection trims `after`, and raw has no trailing space, so the corrected text is the tail of raw.
  const cut = raw.length - split.after.length;
  const finalText = cut < final.length ? normalise(raw.slice(cut, final.length)) : "";
  const interimText = cut < final.length ? interim : split.after;
  return {
    snapshot: { utteranceId, finalText, interimText, text: split.after, corrected: true },
    replaces: split.before,
  };
}

/**
 * Words that mean "I haven't finished". After one of these the engine waits longer before ending the utterance.
 * "Turn Spend Pause on" also ends on one, which only costs a slightly longer wait; cutting someone off costs far more.
 */
const CONTINUATIONS = ["and", "actually", "i mean", "um", "uh", "er", "erm", "so", "but", "or", "then", "because", "no wait", "on", "for", "at", "to", "the"];
const CONTINUATION = new RegExp(`(?:^|\\s)(?:${CONTINUATIONS.map((w) => w.replace(" ", "\\s+")).join("|")})$`);

/** True when the text trails off on a word like "and" or "actually", so more is probably coming. A full stop or question mark means it didn't. */
export function endsWithContinuation(text: string): boolean {
  return !/[.?!]\s*$/.test(text) && CONTINUATION.test(words(text).join(" "));
}

/** Phrases that silence Dial. Only the whole utterance counts: "stop my card" is a request, not a stop word. */
const STOP_PHRASES = ["stop talking", "be quiet", "hang on", "shut up", "stop", "cancel", "wait", "quiet", "enough"];
const FILLER = "(?:ok|okay|oh|dial|please|no|now|just)";
const STOP = new RegExp(`^(?:${FILLER}\\s+)*(?:${STOP_PHRASES.map((p) => p.replace(" ", "\\s+")).join("|")})(?:\\s+(?:${STOP_PHRASES.join("|")}|${FILLER}|a\\s+(?:sec|second|moment|minute)|it|that))*$`);

/** True when everything said is a stop word ("stop", "hang on", "be quiet please", "stop stop"). */
export function isStopWord(text: string): boolean {
  const w = words(text);
  return w.length > 0 && STOP.test(w.join(" "));
}

/**
 * True when what the microphone heard is most likely Dial's own voice coming back through the speaker: most of the
 * heard words are words Dial is saying. Recognisers mishear echo, so this is a share of words, not an exact match.
 */
export function isEcho(heard: string, dialSpeaking: string | null): boolean {
  if (!dialSpeaking) return false;
  const h = words(heard);
  if (h.length === 0) return false;
  const said = new Set(words(dialSpeaking));
  const matched = h.filter((w) => said.has(w)).length;
  return matched / h.length > 0.5;
}

function foldAccents(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Lower-case words with punctuation removed, for comparing what was heard with what was said. */
export function words(text: string): string[] {
  return foldAccents(text)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
