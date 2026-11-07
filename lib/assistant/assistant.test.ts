import { describe, expect, it, vi } from "vitest";
import { seedContext } from "../ai/facts";
import {
  askDial,
  evidenceHref,
  intentForQuestion,
  knownEvidence,
  offlineFacts,
  parseAskResponse,
  SUGGESTED_QUESTIONS,
} from "./client";
import { canSpeak, getRecognition, pickVoice, voiceErrorMessage } from "./speech";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("askDial against the AskResponse contract", () => {
  it("returns a valid answer unchanged and posts the question", async () => {
    const body = { answer: "Tesco charged you £38.62 twice.", evidenceIds: ["t051", "t052"], source: "cache" };
    const f = reply(200, body);
    expect(await askDial("Did I pay Tesco twice this month?", { fetchImpl: f })).toEqual({ kind: "answer", response: body, experience: { template: "general", intent: null } });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("/api/ask");
    expect(JSON.parse(init.body as string)).toEqual({ question: "Did I pay Tesco twice this month?" });
  });

  it("sends {} for the default summary", async () => {
    const f = reply(200, { answer: "x", evidenceIds: [], source: "template" });
    await askDial(undefined, { fetchImpl: f });
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body).toBe("{}");
  });

  it("400 keeps the backend's friendly message", async () => {
    expect(await askDial(" ", { fetchImpl: reply(400, { error: "Please type a question first." }) })).toEqual({
      kind: "invalid",
      message: "Please type a question first.",
    });
    expect(await askDial("x", { fetchImpl: reply(400, "not json") })).toMatchObject({ kind: "invalid" });
  });

  it("500, 404, network failure and malformed bodies are unavailable", async () => {
    expect(await askDial("x", { fetchImpl: reply(500, { error: "Sorry" }) })).toEqual({ kind: "unavailable" });
    expect(await askDial("x", { fetchImpl: reply(404, "<html>") })).toEqual({ kind: "unavailable" });
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await askDial("x", { fetchImpl: down })).toEqual({ kind: "unavailable" });
    expect(await askDial("x", { fetchImpl: reply(200, { answer: "x", evidenceIds: "t051", source: "cache" }) })).toEqual({ kind: "unavailable" });
  });

  it("times out instead of hanging", async () => {
    const hang = vi.fn(
      (_: unknown, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    ) as unknown as typeof fetch;
    const started = Date.now();
    expect(await askDial("x", { fetchImpl: hang, timeoutMs: 50 })).toEqual({ kind: "unavailable" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("parseAskResponse", () => {
  it("rejects unknown sources, empty answers and non-string IDs", () => {
    expect(parseAskResponse({ answer: "a", evidenceIds: [], source: "guess" })).toBeNull();
    expect(parseAskResponse({ answer: "  ", evidenceIds: [], source: "model" })).toBeNull();
    expect(parseAskResponse({ answer: "a", evidenceIds: [1], source: "model" })).toBeNull();
    expect(parseAskResponse(null)).toBeNull();
  });
});

describe("evidence", () => {
  const ids = new Set(seedContext().txns.map((t) => t.id));
  it("drops IDs the account does not have", () => {
    expect(knownEvidence(["t051", "t999", "t052"], ids)).toEqual(["t051", "t052"]);
  });
  it("builds the Stage 4 highlight URL", () => {
    expect(evidenceHref(["t051", "t052"])).toBe("/account/spending?highlight=t051,t052");
  });
});

describe("offline fallback (backend unavailable)", () => {
  it("every suggested question maps to facts with real evidence", () => {
    for (const { question, intent } of SUGGESTED_QUESTIONS) {
      expect(intentForQuestion(question.toUpperCase())).toBe(intent);
      const off = offlineFacts(intent, seedContext());
      expect(off.facts.length).toBeGreaterThan(0);
      expect(knownEvidence(off.evidenceIds, ids())).toEqual(off.evidenceIds);
    }
    function ids() {
      return new Set(seedContext().txns.map((t) => t.id));
    }
  });
  it("the Tesco question falls back to the two Tesco charges", () => {
    const off = offlineFacts("duplicates", seedContext());
    expect(off.evidenceIds).toEqual(["t051", "t052"]);
    expect(off.facts[0].value).toBe("Tesco, £38.62, on Thursday 5 November and Friday 6 November");
  });
  it("free text has no offline intent", () => expect(intentForQuestion("What is my credit score?")).toBeNull());
});

describe("voice feature detection", () => {
  class Rec {}
  it("finds standard and webkit recognition, or none", () => {
    expect(getRecognition({ SpeechRecognition: Rec })).toBe(Rec);
    expect(getRecognition({ webkitSpeechRecognition: Rec })).toBe(Rec);
    expect(getRecognition({})).toBeNull();
    expect(getRecognition(undefined)).toBeNull();
  });
  it("read-aloud needs both speechSynthesis and the utterance constructor", () => {
    expect(canSpeak({ speechSynthesis: {}, SpeechSynthesisUtterance: Rec })).toBe(true);
    expect(canSpeak({ speechSynthesis: {} })).toBe(false);
    expect(canSpeak({})).toBe(false);
  });
  it("prefers en-GB, then any English, else default", () => {
    const v = (lang: string) => ({ lang, name: lang });
    expect(pickVoice([v("en-US"), v("en_GB"), v("fr-FR")])?.lang).toBe("en_GB");
    expect(pickVoice([v("fr-FR"), v("en-AU")])?.lang).toBe("en-AU");
    expect(pickVoice([v("fr-FR")])).toBeNull();
  });
  it("explains recognition errors in plain English", () => {
    expect(voiceErrorMessage("not-allowed")).toMatch(/type your question/);
    expect(voiceErrorMessage("aborted")).toBe("");
  });
});
