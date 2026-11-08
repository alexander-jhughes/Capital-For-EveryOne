import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqApiError } from "./groq";
import { cleanTranscript, createTranscriber, handleTranscribe, MAX_AUDIO_BYTES, type Transcriber } from "./transcribe";
import { resetRateLimit } from "./rate-limit";

const post = (bytes: number, type = "audio/webm", ip = `10.1.0.${Math.floor(Math.random() * 250)}`) =>
  new Request("http://x/api/transcribe", { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body: new Uint8Array(bytes) });
const fake = (impl: Transcriber["transcribe"]): Transcriber => ({ transcribe: vi.fn(impl) });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetRateLimit();
});

describe("POST /api/transcribe", () => {
  it("returns the text, cleaned", async () => {
    const r = await handleTranscribe(post(2000), () => fake(async () => "  I have trouble <b>seeing</b> at night\n"));
    expect(await r.json()).toEqual({ text: "I have trouble b seeing /b at night" });
  });

  it("refuses non-audio, empty and oversized bodies before calling Groq", async () => {
    const t = fake(async () => "x");
    expect((await handleTranscribe(post(10, "text/plain"), () => t)).status).toBe(415);
    expect((await handleTranscribe(post(0), () => t)).status).toBe(400);
    expect((await handleTranscribe(post(MAX_AUDIO_BYTES + 1), () => t)).status).toBe(413);
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it("says plainly when there is no key", async () => {
    const r = await handleTranscribe(post(100), () => null);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("isn't set up");
  });

  it("drops Whisper's usual output for silence instead of submitting it", async () => {
    for (const s of ["Thank you.", "you", "[BLANK_AUDIO]"]) expect(await (await handleTranscribe(post(100), () => fake(async () => s))).json()).toEqual({ text: "" });
  });

  it("never logs the audio or the words, and says when Groq is busy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await handleTranscribe(post(100), () => fake(async () => Promise.reject(new GroqApiError(429))));
    expect(r.status).toBe(503);
    expect((await r.json()).busy).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).toBe(JSON.stringify([["[transcribe] failed: API status 429"]]));
  });

  it("sends the audio to Groq's transcription endpoint with the key as a bearer token", async () => {
    vi.stubEnv("GROQ_API_KEY", "k-test");
    vi.stubEnv("GROQ_BASE_URL", "");
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createTranscriber()!.transcribe(new Blob([new Uint8Array(10)], { type: "audio/webm" }), 1000)).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k-test");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("en");
  });

  it("cleans control characters and long text", () => {
    expect(cleanTranscript("a\u0000b")).toBe("a b");
    expect(cleanTranscript("x".repeat(900)).length).toBe(500);
  });
});
