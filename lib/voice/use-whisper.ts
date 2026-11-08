"use client";

// "Clearer recognition": records one sentence and has Groq's Whisper turn it into text (POST /api/transcribe).
// Same shape as useVoiceEngine, so Dial's surfaces don't care which one is listening. Used only after the person chose
// it (speechInput "whisper"), because the recording goes to Groq. Nothing is kept: the audio lives in memory until the
// text comes back.
//
// One sentence per tap: the microphone opens inside the tap (so the permission prompt appears at once), recording
// stops on its own after a short pause once the person has spoken (longer than usual, so slow or hesitant speech
// isn't cut off), or when they tap again, or after 20 seconds.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecognitionBackend, TranscriptSnapshot, Utterance, VoiceError, VoiceState } from "./types";

const PAUSE_MS = 1600;
const MAX_MS = 20_000;
const NO_SPEECH_MS = 8000;
/** Loudness (RMS of the waveform, 0 to 1) that counts as speech. Low, so quiet voices are heard. */
const SPEECH_LEVEL = 0.02;

const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const pickMime = () => (typeof MediaRecorder === "undefined" ? null : (MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? ""));

const err = (code: VoiceError["code"], message: string, recoverable: boolean): VoiceError => ({ code, message, recoverable });

export function useWhisper(opts: { onUtterance(u: Utterance): void }) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot | null>(null);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const session = useRef<{ stop(send: boolean): void } | null>(null);
  const nextId = useRef(1);
  const speaking = useRef<string | null>(null);
  const processing = useRef(false);

  useEffect(() => setSupported(typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && pickMime() !== null), []);

  const idle = useCallback(() => setState(speaking.current ? "responding" : processing.current ? "processing" : "idle"), []);

  const start = useCallback(() => {
    if (session.current) return session.current.stop(true); // a second tap means "I've finished"
    setError(null);
    setSnapshot(null);
    setState("requesting-permission");
    const utteranceId = nextId.current++;
    let cancelled = false;
    let finish: ((send: boolean) => void) | null = null;
    session.current = { stop: (send) => (finish ? finish(send) : (cancelled = true)) };

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        const tracks = stream.getTracks();
        if (cancelled) {
          tracks.forEach((t) => t.stop());
          session.current = null;
          return idle();
        }
        const mime = pickMime() ?? "";
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

        // Loudness meter, for "they've started" and "they've paused". Runs on the device only.
        const audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        audio.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const began = performance.now();
        let heard = false;
        let lastLoud = began;
        let send = true;
        const timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
          const now = performance.now();
          if (rms > SPEECH_LEVEL) {
            lastLoud = now;
            if (!heard) {
              heard = true;
              setState("transcribing");
              setSnapshot({ utteranceId, finalText: "", interimText: "Listening...", text: "Listening...", corrected: false });
            }
          }
          if ((heard && now - lastLoud > PAUSE_MS) || now - began > MAX_MS || (!heard && now - began > NO_SPEECH_MS)) finish?.(true);
        }, 100);

        finish = (s: boolean) => {
          if (recorder.state === "inactive") return;
          send = s;
          clearInterval(timer);
          recorder.stop();
        };

        recorder.onstop = async () => {
          tracks.forEach((t) => t.stop());
          void audio.close().catch(() => {});
          session.current = null;
          setSnapshot(null);
          if (!send) return idle();
          if (!heard) {
            setError(err("no-speech", "I didn't hear anything. Tap the microphone and try again, or type instead.", true));
            return setState("failed");
          }
          setState("processing");
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
            const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": blob.type }, body: blob });
            const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
            if (!res.ok) {
              setError(err("network", body.error ?? "I couldn't turn that into text. Try again, or type instead.", true));
              return setState("failed");
            }
            const text = (body.text ?? "").trim();
            if (!text) {
              setError(err("no-speech", "I couldn't make out any words. Try again a little closer to the phone, or type instead.", true));
              return setState("failed");
            }
            idle();
            latest.current.onUtterance({ utteranceId, text, corrected: false, origin: "voice" });
          } catch {
            setError(err("network", "Clearer recognition couldn't be reached. Check your connection, or type instead.", true));
            setState("failed");
          }
        };

        recorder.start(250);
        setState("listening");
      })
      .catch((e: unknown) => {
        session.current = null;
        const name = (e as { name?: string })?.name;
        setError(
          name === "NotAllowedError"
            ? err("not-allowed", "The microphone is blocked. Allow it in your browser's site settings, or type instead.", false)
            : name === "NotFoundError"
              ? err("no-microphone", "No microphone was found. You can type instead.", false)
              : err("failed", "The microphone couldn't start. You can type instead.", true),
        );
        setState("failed");
      });
  }, [idle]);

  const stop = useCallback(() => session.current?.stop(true), []);
  const cancel = useCallback(() => session.current?.stop(false), []);
  const setSpeaking = useCallback(
    (text: string | null) => {
      speaking.current = text;
      if (!session.current) idle();
    },
    [idle],
  );
  const setProcessing = useCallback(
    (active: boolean) => {
      processing.current = active;
      if (!session.current) idle();
    },
    [idle],
  );
  useEffect(() => () => session.current?.stop(false), []);

  const backend: RecognitionBackend = "cloud";
  return { supported, backend, state, snapshot, error, start, stop, cancel, setSpeaking, setProcessing };
}
