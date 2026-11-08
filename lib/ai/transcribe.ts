// POST /api/transcribe: turns a short recording into text with Groq's hosted Whisper (whisper-large-v3-turbo).
// Only used after the person chose "Clearer recognition" for their voice (speechInput "whisper"), because it sends
// their audio to Groq. The audio is passed straight through: it is never stored or logged, and neither is the text.
// Whisper copes far better than the browser's recogniser with strong accents and speech that is slurred or slow.
import { describeError, GroqApiError, groqConfig } from "./groq";
import { isRateLimit } from "./model-chain";
import { allowModelCall, clientKey } from "./rate-limit";

export const TRANSCRIBE_MODEL_DEFAULT = "whisper-large-v3-turbo";
/** About a minute of Opus audio. Dial's utterances are a few seconds; anything bigger is refused before Groq sees it. */
export const MAX_AUDIO_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const ACCEPTED = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|m4a|x-m4a|aac)(;.*)?$/i;

export interface Transcriber {
  transcribe(audio: Blob, timeoutMs: number): Promise<string>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Whisper's well-known output for silence or noise. Never sent on as if the person had said it. */
const SILENCE = /^(you|thank you\.?|thanks for watching!?|\.|bye\.?|\[.*\]|\(.*\))$/i;

/** Plain text only, short, no control characters. */
export const cleanTranscript = (s: string) => s.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 500);

export function createTranscriber(): Transcriber | null {
  const config = groqConfig();
  if (!config) return null;
  const model = process.env.GROQ_TRANSCRIBE_MODEL?.trim() || TRANSCRIBE_MODEL_DEFAULT;
  return {
    async transcribe(audio, timeoutMs) {
      const form = new FormData();
      const ext = audio.type.includes("mp4") || audio.type.includes("m4a") ? "m4a" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("wav") ? "wav" : "webm";
      form.append("file", audio, `speech.${ext}`);
      form.append("model", model);
      form.append("language", "en");
      form.append("response_format", "json");
      form.append("temperature", "0");
      const res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.text().catch(() => "");
        throw new GroqApiError(res.status);
      }
      const body = (await res.json()) as { text?: unknown };
      return typeof body.text === "string" ? body.text : "";
    },
  };
}

export async function handleTranscribe(request: Request, makeTranscriber: () => Transcriber | null = createTranscriber): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!ACCEPTED.test(type)) return json({ error: "Send the recording as audio." }, 415);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) return json({ error: "That recording is too long. Try a shorter sentence." }, 413);

  let audio: Blob;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: "The recording was empty." }, 400);
    if (bytes.byteLength > MAX_AUDIO_BYTES) return json({ error: "That recording is too long. Try a shorter sentence." }, 413);
    audio = new Blob([bytes], { type: type.split(";")[0] });
  } catch {
    return json({ error: "The recording didn't arrive. Try again." }, 400);
  }

  if (!allowModelCall(clientKey(request))) return json({ error: "Too many recordings in a minute. Wait a moment, or type instead.", busy: true }, 429);
  const transcriber = makeTranscriber();
  if (!transcriber) return json({ error: "Clearer recognition isn't set up on this server. Your browser's speech service and typing still work." }, 503);

  try {
    const text = cleanTranscript(await transcriber.transcribe(audio, TIMEOUT_MS));
    return json({ text: SILENCE.test(text) ? "" : text });
  } catch (error) {
    // The reason only: never the audio, the text or the error body.
    console.warn(`[transcribe] failed: ${describeError(error)}`);
    if (isRateLimit(error)) return json({ error: "Groq is busy right now. Try again in a few seconds, or type instead.", busy: true }, 503);
    return json({ error: "I couldn't turn that into text. Try again, or type instead." }, 502);
  }
}

/** Whether clearer recognition is available, for the settings and consent screens. Never shows the key. */
export const transcribeStatus = () => ({ available: groqConfig() !== null });
