// MOCKED: a fake SpeechRecognition class and fake timers. No microphone, no real recogniser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_START_MS, chooseBackend, createVoiceEngine, FINISH_GRACE_MS, INTERRUPTED_MS, SILENCE_LIMIT_MS, toVoiceError } from "./engine";
import type { Utterance, VoiceEngineEvents, VoiceState } from "./types";
import { PAUSE_MS } from "./utterance";

type Result = [transcript: string, isFinal: boolean];

class FakeRec {
  static made: FakeRec[] = [];
  static status = "available";
  static available = vi.fn(async () => FakeRec.status);
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  processLocally = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRec.made.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  open() {
    this.onstart?.();
  }
  hear(...results: Result[]) {
    this.onresult?.({ results: results.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
  }
  end(error?: string) {
    if (error) this.onerror?.({ error });
    this.onend?.();
  }
}
/** Safari-like: recognition through the online service only. */
class CloudOnlyRec {
  start() {}
  stop() {}
}

const latest = () => FakeRec.made.at(-1)!;

function setup(speechInput: "on-device" | "cloud" | "unset" | "typing" = "cloud", Rec: unknown = FakeRec) {
  const listeners = new Set<() => void>();
  const document = {
    hidden: false,
    addEventListener: (_: string, f: () => void) => void listeners.add(f),
    removeEventListener: (_: string, f: () => void) => void listeners.delete(f),
  };
  const log = { states: [] as VoiceState[], utterances: [] as Utterance[], interrupts: [] as string[], errors: [] as string[], transcripts: [] as string[] };
  const events: VoiceEngineEvents = {
    onState: (s) => log.states.push(s),
    onTranscript: (t) => log.transcripts.push(t.text),
    onUtterance: (u) => log.utterances.push(u),
    onInterrupt: (r) => log.interrupts.push(r),
    onError: (e) => log.errors.push(e.code),
  };
  const engine = createVoiceEngine({ SpeechRecognition: Rec, document }, events, { speechInput });
  const hide = () => {
    document.hidden = true;
    for (const f of listeners) f();
  };
  return { engine, log, hide, listeners };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRec.made = [];
  FakeRec.status = "available";
});
afterEach(() => vi.useRealTimers());

describe("MOCKED backend selection", () => {
  it("follows the person's choice and what the browser supports", () => {
    expect(chooseBackend({ SpeechRecognition: FakeRec }, "on-device")).toBe("on-device");
    expect(chooseBackend({ SpeechRecognition: FakeRec }, "cloud")).toBe("cloud");
    expect(chooseBackend({ webkitSpeechRecognition: CloudOnlyRec }, "cloud")).toBe("cloud");
    // On-device was chosen but this browser can't do it: don't fall back to the cloud without asking.
    expect(chooseBackend({ webkitSpeechRecognition: CloudOnlyRec }, "on-device")).toBe("none");
    expect(chooseBackend({ SpeechRecognition: FakeRec }, "unset")).toBe("none");
    expect(chooseBackend({ SpeechRecognition: FakeRec }, "typing")).toBe("none");
    expect(chooseBackend({}, "cloud")).toBe("none");
  });
  it("on-device recognises locally when the language pack is available", async () => {
    const { engine } = setup("on-device");
    await vi.runAllTimersAsync();
    engine.start("tap");
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toMatchObject({ processLocally: true, continuous: true, interimResults: true, lang: "en-GB" });
    expect(FakeRec.available).toHaveBeenCalledWith({ langs: ["en-GB"], processLocally: true });
  });
  it("on-device fails plainly when the pack isn't downloaded, without using the cloud", async () => {
    FakeRec.status = "downloadable";
    const { engine, log } = setup("on-device");
    engine.start("tap");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeRec.made).toHaveLength(0);
    expect(log.errors).toEqual(["language-unavailable"]);
    expect(engine.state).toBe("failed");
  });
  it("cloud never asks for local processing", () => {
    const { engine } = setup("cloud");
    engine.start("tap");
    expect(latest().processLocally).toBe(false);
    expect(latest().started).toBe(true);
  });
  it("unsupported or not chosen: backend none, and start reports it", () => {
    const { engine, log } = setup("cloud", null);
    expect(engine.backend).toBe("none");
    engine.start("tap");
    expect(log.errors).toEqual(["unsupported"]);
    expect(setup("unset").engine.backend).toBe("none");
  });
});

describe("MOCKED tap mode", () => {
  it("permission, listening, transcribing, one utterance after the pause, then processing", () => {
    const { engine, log } = setup();
    engine.start("tap");
    expect(engine.state).toBe("requesting-permission");
    latest().open();
    expect(engine.state).toBe("listening");
    latest().hear(["how much do I", false]);
    expect(engine.state).toBe("transcribing");
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(log.utterances).toHaveLength(0);
    latest().hear(["how much do I owe", false]);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(log.utterances.map((u) => u.text)).toEqual(["how much do I owe"]);
    expect(latest().aborted).toBe(true);
    expect(engine.state).toBe("processing");
    engine.setProcessing(false);
    expect(engine.state).toBe("idle");
    expect(log.states).toEqual(["requesting-permission", "listening", "transcribing", "processing", "idle"]);
  });
  it("results from the stopped recogniser are ignored", () => {
    const { engine, log } = setup();
    engine.start("tap");
    const r = latest();
    r.open();
    r.hear(["what do I owe", true]);
    vi.advanceTimersByTime(PAUSE_MS);
    r.hear(["what do I owe", true], ["and my bill", true]);
    vi.advanceTimersByTime(PAUSE_MS * 3);
    expect(log.utterances).toHaveLength(1);
  });
  it("silence in tap mode ends with a recoverable no-speech error", () => {
    const { engine, log } = setup();
    engine.start("tap");
    latest().open();
    latest().end("no-speech");
    expect(log.errors).toEqual(["no-speech"]);
    expect(toVoiceError("no-speech").recoverable).toBe(true);
    expect(engine.state).toBe("failed");
    expect(FakeRec.made).toHaveLength(1);
  });
  it("stop() delivers the words heard so far once the recogniser finishes", () => {
    const { engine, log } = setup();
    engine.start("tap");
    latest().open();
    latest().hear(["what did I spend", false]);
    engine.stop();
    expect(latest().stopped).toBe(true);
    latest().hear(["what did I spend on food", true]);
    latest().end();
    expect(log.utterances.map((u) => u.text)).toEqual(["what did I spend on food"]);
  });
  it("cancel() drops the pending words", () => {
    const { engine, log } = setup();
    engine.start("tap");
    latest().open();
    latest().hear(["pay my", false]);
    engine.cancel();
    vi.advanceTimersByTime(PAUSE_MS * 3);
    expect(log.utterances).toHaveLength(0);
    expect(log.transcripts.at(-1)).toBe("");
    expect(engine.state).toBe("idle");
  });
  it("a self-correction arrives with what it replaced", () => {
    const { engine, log } = setup();
    engine.start("tap");
    latest().open();
    latest().hear(["How much did I spend on food?", true], [" Actually, groceries specifically", true]);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(log.utterances[0]).toMatchObject({ text: "groceries specifically", replaces: "How much did I spend on food?", corrected: true });
  });
});

describe("MOCKED push-to-talk (hold)", () => {
  it("never ends on a pause; release delivers", () => {
    const { engine, log } = setup();
    engine.start("hold");
    latest().open();
    latest().hear(["what did I spend on", false]);
    vi.advanceTimersByTime(PAUSE_MS * 5);
    expect(log.utterances).toHaveLength(0);
    engine.stop();
    latest().hear(["what did I spend on groceries", true]);
    latest().end();
    expect(log.utterances.map((u) => u.text)).toEqual(["what did I spend on groceries"]);
  });
  it("delivers what was shown if the recogniser never finishes", () => {
    const { engine, log } = setup();
    engine.start("hold");
    latest().open();
    latest().hear(["when is my bill due", false]);
    engine.stop();
    vi.advanceTimersByTime(FINISH_GRACE_MS);
    expect(log.utterances.map((u) => u.text)).toEqual(["when is my bill due"]);
  });
  it("keeps the words if the recogniser restarts while still held", () => {
    const { engine, log } = setup();
    engine.start("hold");
    latest().open();
    latest().hear(["how much did I spend", true]);
    latest().end();
    vi.advanceTimersByTime(0);
    expect(FakeRec.made).toHaveLength(2);
    latest().open();
    latest().hear(["on food", false]);
    engine.stop();
    latest().end();
    expect(log.utterances.map((u) => u.text)).toEqual(["how much did I spend on food"]);
  });
});

describe("MOCKED continuous mode", () => {
  it("keeps listening after each utterance, each with its own id", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    const r = latest();
    r.open();
    r.hear(["what do I owe", true]);
    vi.advanceTimersByTime(PAUSE_MS);
    engine.setProcessing(false);
    expect(engine.state).toBe("listening");
    r.hear(["what do I owe", true], [" and when is it due", true]);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(log.utterances.map((u) => u.text)).toEqual(["what do I owe", "and when is it due"]);
    expect(log.utterances[1].utteranceId).toBeGreaterThan(log.utterances[0].utteranceId);
    expect(r.aborted).toBe(false);
  });
  it("restarts straight away after a normal end, with back-off after failures, and gives up after 4", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    latest().open();
    latest().end(); // normal end (e.g. the browser's own time limit)
    vi.advanceTimersByTime(0);
    expect(FakeRec.made).toHaveLength(2);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      latest().end("network"); // never started: a failed session
      const before = FakeRec.made.length;
      let waited = 0;
      while (FakeRec.made.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([BACKOFF_START_MS, BACKOFF_START_MS * 2, BACKOFF_START_MS * 4]);
    latest().end("network");
    vi.advanceTimersByTime(10_000);
    expect(FakeRec.made).toHaveLength(5);
    expect(log.errors).toEqual(["network"]);
    expect(engine.state).toBe("failed");
  });
  it("a success resets the back-off", () => {
    const { engine } = setup();
    engine.start("continuous");
    latest().end("network");
    vi.advanceTimersByTime(BACKOFF_START_MS);
    latest().open();
    latest().end();
    vi.advanceTimersByTime(0);
    expect(FakeRec.made).toHaveLength(3);
  });
  it("no-speech between utterances is normal: restart without back-off", () => {
    const { engine } = setup();
    engine.start("continuous");
    latest().open();
    latest().end("no-speech");
    vi.advanceTimersByTime(0);
    expect(FakeRec.made).toHaveLength(2);
  });
  it("not-allowed gives up at once and can't be retried", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    latest().end("not-allowed");
    vi.advanceTimersByTime(10_000);
    expect(FakeRec.made).toHaveLength(1);
    expect(log.errors).toEqual(["not-allowed"]);
    expect(toVoiceError("not-allowed")).toMatchObject({ recoverable: false, message: expect.stringMatching(/type/) });
    expect(engine.state).toBe("failed");
  });
  it("stops after 2 minutes of silence", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    latest().open();
    vi.advanceTimersByTime(SILENCE_LIMIT_MS);
    expect(log.errors).toEqual(["no-speech"]);
    expect(latest().aborted).toBe(true);
  });
  it("the page going to the background stops listening, keeps the transcript and sends nothing", () => {
    const { engine, log, hide } = setup();
    engine.start("continuous");
    latest().open();
    latest().hear(["how much did I", false]);
    const shown = log.transcripts.length;
    hide();
    expect(log.interrupts).toEqual(["backgrounded"]);
    expect(latest().aborted).toBe(true);
    expect(engine.state).toBe("interrupted");
    vi.advanceTimersByTime(INTERRUPTED_MS + 20);
    expect(engine.state).toBe("idle");
    vi.advanceTimersByTime(10_000);
    expect(log.utterances).toHaveLength(0);
    expect(log.transcripts).toHaveLength(shown);
    expect(FakeRec.made).toHaveLength(1);
  });
});

describe("MOCKED echo and barge-in", () => {
  const SPOKEN = "Your bill is £486.20, due on Friday 20 November.";
  it("Dial's own words don't count; the person's words interrupt it", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    const r = latest();
    r.open();
    engine.setSpeaking(SPOKEN);
    expect(engine.state).toBe("responding");
    r.hear(["your bill is 486", false]);
    expect(log.interrupts).toEqual([]);
    expect(engine.state).toBe("responding");
    r.hear(["your bill is 486", true], [" what about groceries", false]);
    expect(log.interrupts).toEqual(["user-speech"]);
    expect(engine.state).toBe("interrupted");
    engine.setSpeaking(null);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(log.utterances.map((u) => u.text)).toEqual(["what about groceries"]);
  });
  it("echo alone is dropped after Dial stops", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    latest().open();
    engine.setSpeaking(SPOKEN);
    latest().hear(["due on Friday", true]);
    engine.setSpeaking(null);
    vi.advanceTimersByTime(5000);
    expect(log.utterances).toHaveLength(0);
    expect(engine.state).toBe("listening");
  });
  it("a stop word while Dial is working interrupts it and is never sent", () => {
    const { engine, log } = setup();
    engine.start("continuous");
    latest().open();
    engine.setProcessing(true);
    latest().hear(["stop", false]);
    expect(log.interrupts).toEqual(["stop-word"]);
    vi.advanceTimersByTime(PAUSE_MS * 3);
    expect(log.utterances).toHaveLength(0);
    expect(engine.listening).toBe(true);
  });
  it("'stop' with Dial quiet is an ordinary utterance (the pipeline handles it)", () => {
    const { engine, log } = setup();
    engine.start("tap");
    latest().open();
    latest().hear(["stop", true]);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(log.interrupts).toEqual([]);
    expect(log.utterances.map((u) => u.text)).toEqual(["stop"]);
  });
});

describe("MOCKED lifecycle", () => {
  it("dispose stops listening and removes the visibility listener", () => {
    const { engine, listeners } = setup();
    engine.start("continuous");
    latest().open();
    engine.dispose();
    expect(latest().aborted).toBe(true);
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(FakeRec.made).toHaveLength(1);
  });
  it("starting again after a failure clears it", () => {
    const { engine } = setup();
    engine.start("tap");
    latest().end("not-allowed");
    expect(engine.state).toBe("failed");
    engine.start("tap");
    expect(engine.state).toBe("requesting-permission");
  });
});
