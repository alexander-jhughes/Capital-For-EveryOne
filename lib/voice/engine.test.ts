// MOCKED speech tests. A fake SpeechRecognition class, a fake document and a fake clock stand in for the browser:
// nothing here opens a real microphone or runs a real recogniser. They pin down the engine's rules (when an utterance
// ends, what is delivered, echo, restarts, errors, privacy). How real browsers time their results still needs a
// person with a microphone.

import { describe, expect, it, vi } from "vitest";
import { recognitionError } from "../assistant/speech";
import { createVoiceEngine, detectBackend, type VoiceEngineOptions } from "./engine";
import type { ListenMode, TranscriptSnapshot, Utterance, VoiceError, VoiceState } from "./types";

type Timer = ReturnType<typeof setTimeout>;

class FakeClock {
  t = 0;
  private id = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = ((fn: () => void, ms: number) => {
    this.timers.set(++this.id, { at: this.t + ms, fn });
    return this.id as unknown as Timer;
  }) as unknown as typeof setTimeout;
  clearTimeout = ((id: Timer) => void this.timers.delete(id as unknown as number)) as typeof clearTimeout;
  now = () => this.t;
  tick(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

type Part = string | [string, "final"];
type Handlers = Pick<FakeRec, "onstart" | "onaudiostart" | "onresult" | "onerror" | "onend">;

class FakeRec {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  processLocally?: boolean;
  onstart: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onresult: ((e: { resultIndex?: number; results: unknown }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  closed = false;
  /** The handlers when start() ran: the browser may still fire them after the engine lets go (queued events). */
  private h: Handlers | null = null;
  constructor(private world: World) {}
  start() {
    if (this.started) throw new Error("InvalidStateError");
    this.started = true;
    this.h = { onstart: this.onstart, onaudiostart: this.onaudiostart, onresult: this.onresult, onerror: this.onerror, onend: this.onend };
    this.world.open++;
    this.world.maxOpen = Math.max(this.world.maxOpen, this.world.open);
  }
  stop() {
    this.close();
  }
  abort() {
    this.aborted = true;
    this.close();
  }
  private close() {
    if (this.started && !this.closed) this.world.open--;
    this.closed = true;
  }
  // Browser-side events, fired through the handlers captured at start().
  begin() {
    this.h?.onstart?.();
  }
  /** The whole result list for this session, as browsers send it: each string interim, [text, "final"] final. */
  hear(...parts: Part[]) {
    const results = parts.map((p) => Object.assign([{ transcript: typeof p === "string" ? p : p[0] }], { isFinal: typeof p !== "string" }));
    this.h?.onresult?.({ resultIndex: 0, results });
  }
  error(code: string) {
    this.h?.onerror?.({ error: code });
  }
  end() {
    this.close();
    this.h?.onend?.();
  }
}

interface World {
  recs: FakeRec[];
  open: number;
  maxOpen: number;
}

function setup(o: { available?: string; allowCloud?: boolean; noRecognition?: boolean; timing?: VoiceEngineOptions["timing"] } = {}) {
  const world: World = { recs: [], open: 0, maxOpen: 0 };
  const Rec = class extends FakeRec {
    constructor() {
      super(world);
      world.recs.push(this);
    }
  } as unknown as { new (): FakeRec; available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string> };
  const available = o.available === undefined ? undefined : vi.fn(async () => o.available as string);
  if (available) Rec.available = available;

  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    hide() {
      this.visibilityState = "hidden";
      for (const fn of [...listeners]) fn();
    },
  };
  const win = o.noRecognition ? { document: doc } : { SpeechRecognition: Rec, document: doc };
  const clock = new FakeClock();
  const log = { states: [] as VoiceState[], snapshots: [] as TranscriptSnapshot[], utterances: [] as Utterance[], interrupts: [] as string[], errors: [] as VoiceError[] };
  const engine = createVoiceEngine({
    win,
    allowCloud: o.allowCloud ?? true,
    clock,
    timing: o.timing,
    events: {
      onState: (s) => log.states.push(s),
      onTranscript: (s) => log.snapshots.push(s),
      onUtterance: (u) => log.utterances.push(u),
      onInterrupt: (r) => log.interrupts.push(r),
      onError: (e) => log.errors.push(e),
    },
  });
  const rec = () => world.recs.at(-1)!;
  const listen = (mode: ListenMode = "tap") => {
    engine.start(mode);
    rec()?.begin();
  };
  return { engine, world, clock, log, rec, listen, doc, listeners, available };
}

const texts = (u: Utterance[]) => u.map((x) => x.text);

describe("ending an utterance", () => {
  it("shows interim words live and delivers once the pause passes after a final", () => {
    const { engine, log, clock, rec } = setup();
    engine.start("tap");
    expect(engine.state).toBe("requesting-permission");
    rec().begin();
    expect(engine.state).toBe("listening");
    rec().hear("how much");
    expect(log.snapshots.at(-1)).toEqual({ utteranceId: 1, finalText: "", interimText: "how much", text: "how much", corrected: false });
    expect(engine.state).toBe("transcribing");
    rec().hear(["how much do I owe", "final"]);
    clock.tick(1099);
    expect(log.utterances).toEqual([]);
    clock.tick(1);
    expect(log.utterances).toEqual([{ utteranceId: 1, text: "how much do I owe", corrected: false, origin: "voice" }]);
    // Tap: one utterance, then the microphone closes.
    expect(rec().aborted).toBe(true);
    expect(engine.state).toBe("idle");
  });

  it("doesn't cut the question at a natural pause between finals", () => {
    const { log, clock, rec, listen } = setup();
    listen();
    rec().hear(["how much did I spend", "final"]);
    clock.tick(900);
    rec().hear(["how much did I spend", "final"], [" on groceries", "final"]);
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["how much did I spend on groceries"]);
  });

  it("keeps the words when the browser ends the session mid-question (Android), and restarts", () => {
    const { log, clock, rec, world, listen } = setup();
    listen("continuous");
    rec().hear(["how much did I spend", "final"]);
    rec().end();
    clock.tick(200);
    expect(world.recs).toHaveLength(2);
    rec().begin();
    rec().hear(["on groceries", "final"]);
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["how much did I spend on groceries"]);
  });

  it("delivers a stable interim after the pause, without waiting for a final", () => {
    const { log, clock, rec, listen } = setup();
    listen();
    rec().hear("what's my balance");
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["what's my balance"]);
  });

  it("waits longer when the words trail off on 'and'", () => {
    const { log, clock, rec, listen } = setup();
    listen();
    rec().hear(["show me food and", "final"]);
    clock.tick(1500);
    expect(log.utterances).toEqual([]);
    clock.tick(500);
    expect(texts(log.utterances)).toEqual(["show me food and"]);
  });

  it("delivers the corrected words and what they replaced", () => {
    const { log, clock, rec, listen } = setup();
    listen();
    rec().hear(["How much on food? Actually, groceries", "final"]);
    expect(log.snapshots.at(-1)).toMatchObject({ text: "groceries", corrected: true });
    clock.tick(1100);
    expect(log.utterances).toEqual([{ utteranceId: 1, text: "groceries", corrected: true, replaces: "How much on food?", origin: "voice" }]);
  });

  it("never delivers an empty utterance", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("hold");
    rec().hear(" ", ["...", "final"]);
    clock.tick(3000);
    engine.stop();
    expect(log.utterances).toEqual([]);
    expect(log.snapshots).toEqual([]);
  });
});

describe("delivery and sessions", () => {
  it("delivers each utterance at most once, with increasing ids", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("continuous");
    rec().hear(["how much do I owe", "final"]);
    clock.tick(1100);
    // The browser repeats a result that was already handed over: not a new utterance.
    rec().hear(["how much do I owe", "final"]);
    clock.tick(1100);
    engine.stop();
    expect(log.utterances.map((u) => u.utteranceId)).toEqual([1]);

    engine.start("continuous");
    rec().begin();
    rec().hear(["and my bill", "final"]);
    engine.stop();
    engine.stop();
    expect(log.utterances.map((u) => [u.utteranceId, u.text])).toEqual([
      [1, "how much do I owe"],
      [2, "and my bill"],
    ]);
  });

  it("splits continuous listening into separate utterances on the same session", () => {
    const { log, clock, rec, world, listen } = setup();
    listen("continuous");
    rec().hear(["what's my balance", "final"]);
    clock.tick(1100);
    rec().hear(["what's my balance", "final"], ["and when is it due", "final"]);
    clock.tick(2000);
    expect(log.utterances.map((u) => [u.utteranceId, u.text])).toEqual([
      [1, "what's my balance"],
      [2, "and when is it due"],
    ]);
    expect(world.recs).toHaveLength(1);
  });

  it("never runs two sessions when start() is called twice", () => {
    const { engine, world } = setup();
    engine.start("tap");
    engine.start("tap");
    engine.start("continuous");
    expect(world.recs).toHaveLength(1);
    expect(world.maxOpen).toBe(1);
  });

  it("ignores events from an instance it has let go of", () => {
    const { engine, log, clock, rec, world, listen } = setup();
    listen("continuous");
    const first = rec();
    first.end();
    clock.tick(200);
    const second = rec();
    expect(second).not.toBe(first);
    // Queued events from the first session arrive late.
    first.hear(["stale words", "final"]);
    first.error("not-allowed");
    first.end();
    clock.tick(5000);
    expect(log.snapshots).toEqual([]);
    expect(log.errors).toEqual([]);
    expect(world.recs).toHaveLength(2);
    expect(world.maxOpen).toBe(1);
    // And after cancel, the cancelled session is stale too.
    engine.cancel();
    second.hear(["late", "final"]);
    clock.tick(5000);
    expect(log.utterances).toEqual([]);
  });

  it("restarts with back-off when the browser ends sessions, and gives up after maxRestarts", () => {
    const { engine, log, clock, rec, world, listen } = setup({ timing: { maxRestarts: 3 } });
    listen("continuous");
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = world.recs.length;
      rec().end();
      const t0 = clock.t;
      while (world.recs.length === before) clock.tick(100);
      gaps.push(clock.t - t0);
    }
    expect(gaps).toEqual([200, 400, 800]);
    expect(world.maxOpen).toBe(1);
    rec().end();
    clock.tick(10_000);
    expect(world.recs).toHaveLength(4);
    expect(log.errors.map((e) => e.code)).toEqual(["failed"]);
    expect(engine.state).toBe("failed");
  });

  it("resets the back-off when words arrive", () => {
    const { clock, rec, world, listen } = setup();
    listen("continuous");
    rec().end();
    clock.tick(200);
    rec().end();
    clock.tick(400);
    rec().hear("hello");
    rec().end();
    clock.tick(199);
    expect(world.recs).toHaveLength(3);
    clock.tick(1);
    expect(world.recs).toHaveLength(4);
  });

  it("cancel() drops the pending words", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen();
    rec().hear(["how much", "final"]);
    engine.cancel();
    clock.tick(5000);
    expect(log.utterances).toEqual([]);
    expect(log.snapshots.at(-1)).toEqual({ utteranceId: 1, finalText: "", interimText: "", text: "", corrected: false });
    expect(rec().aborted).toBe(true);
    expect(engine.state).toBe("idle");
  });

  it("stop() delivers pending words straight away, interim included", () => {
    const { engine, log, rec, listen } = setup();
    listen();
    rec().hear(["how much", "final"], " do I owe");
    engine.stop();
    expect(texts(log.utterances)).toEqual(["how much do I owe"]);
    expect(engine.state).toBe("idle");
  });

  it("hold mode listens through pauses and delivers on stop()", () => {
    const { engine, log, clock, rec, world, listen } = setup();
    listen("hold");
    rec().hear(["how much did I spend", "final"]);
    clock.tick(5000);
    rec().error("no-speech"); // silence while holding is not an error
    rec().end();
    clock.tick(200);
    rec().hear(["on groceries", "final"]);
    clock.tick(5000);
    expect(log.utterances).toEqual([]);
    expect(log.errors).toEqual([]);
    engine.stop();
    expect(texts(log.utterances)).toEqual(["how much did I spend on groceries"]);
    expect(world.maxOpen).toBe(1);
  });

  it("keeps listening while processing in continuous mode, and delivers a new utterance", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("continuous");
    rec().hear(["what's my balance", "final"]);
    clock.tick(1100);
    engine.setProcessing(true);
    expect(engine.state).toBe("processing");
    expect(rec().aborted).toBe(false);
    rec().hear(["what's my balance", "final"], ["no, my bill", "final"]);
    expect(engine.state).toBe("transcribing");
    clock.tick(1100);
    expect(log.utterances.map((u) => u.utteranceId)).toEqual([1, 2]);
    expect(engine.state).toBe("processing");
    engine.setProcessing(false);
    expect(engine.state).toBe("listening");
  });

  it("tap mode gives up quietly when nothing is heard", () => {
    const { engine, log, clock, listen } = setup();
    listen("tap");
    clock.tick(8000);
    expect(log.errors).toEqual([expect.objectContaining({ code: "no-speech", recoverable: true })]);
    expect(engine.state).toBe("failed");
  });
});

describe("Dial speaking", () => {
  const SAID = "Your bill is £120.50, due on Friday 20 November.";

  it("ignores Dial's own voice coming back through the microphone", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("continuous");
    engine.setSpeaking(SAID);
    expect(engine.state).toBe("responding");
    rec().hear(["your bill is 120.50 due on", "final"]);
    clock.tick(3000);
    expect(log.snapshots).toEqual([]);
    expect(log.interrupts).toEqual([]);
    expect(log.utterances).toEqual([]);
  });

  it("still ignores Dial's last words just after it stops speaking", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("continuous");
    engine.setSpeaking(SAID);
    engine.setSpeaking(null);
    rec().hear(["friday 20 november", "final"]);
    clock.tick(3000);
    expect(log.utterances).toEqual([]);
    rec().hear(["friday 20 november", "final"], ["what about groceries", "final"]);
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["what about groceries"]);
  });

  it("a stop word interrupts Dial and is not delivered", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("continuous");
    engine.setSpeaking(SAID);
    rec().hear(["stop", "final"]);
    expect(log.interrupts).toEqual(["stop-word"]);
    expect(engine.state).toBe("interrupted");
    clock.tick(3000);
    expect(log.utterances).toEqual([]);
    expect(engine.state).toBe("responding");
  });

  it("other speech barges in once, then is captured as a new utterance", () => {
    const { engine, log, clock, rec, listen } = setup();
    listen("continuous");
    engine.setSpeaking(SAID);
    rec().hear("what did I spend");
    rec().hear(["what did I spend on groceries", "final"]);
    expect(log.interrupts).toEqual(["user-speech"]);
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["what did I spend on groceries"]);
  });

  it("when Dial isn't speaking, 'stop' is an ordinary utterance", () => {
    const { log, clock, rec, listen } = setup();
    listen();
    rec().hear(["stop", "final"]);
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["stop"]);
    expect(log.interrupts).toEqual([]);
  });
});

describe("the page going to the background", () => {
  it("interrupts, stops listening and drops pending words", () => {
    const { engine, log, clock, rec, world, listen, doc } = setup();
    listen("continuous");
    rec().hear(["how much", "final"]);
    doc.hide();
    expect(log.interrupts).toEqual(["backgrounded"]);
    expect(engine.state).toBe("interrupted");
    expect(rec().aborted).toBe(true);
    clock.tick(10_000);
    expect(log.utterances).toEqual([]);
    expect(world.recs).toHaveLength(1);
    expect(engine.state).toBe("idle");
  });

  it("does nothing when idle", () => {
    const { log, doc } = setup();
    doc.hide();
    expect(log.interrupts).toEqual([]);
  });
});

describe("errors", () => {
  it.each([
    ["not-allowed", "not-allowed", false],
    ["service-not-allowed", "not-allowed", false],
    ["audio-capture", "no-microphone", false],
    ["network", "network", true],
    ["no-speech", "no-speech", true],
    ["language-not-supported", "language-unavailable", false],
    ["bad-grammar", "failed", true],
  ] as const)("maps %s to %s", (browser, code, recoverable) => {
    const { engine, log, rec, listen } = setup();
    listen("tap");
    rec().error(browser);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toMatchObject({ code, recoverable });
    expect(log.errors[0].message).toMatch(/\w/);
    expect(engine.state).toBe("failed");
    expect(rec().aborted).toBe(true);
    expect(recognitionError(browser)).toEqual(log.errors[0]);
  });

  it("never shows 'aborted'", () => {
    const { log, rec, listen } = setup();
    listen("tap");
    rec().error("aborted");
    rec().end();
    expect(log.errors).toEqual([]);
    expect(recognitionError("aborted")).toBeNull();
  });

  it("restarts silently after no-speech in continuous mode", () => {
    const { engine, log, clock, rec, world, listen } = setup();
    listen("continuous");
    rec().error("no-speech");
    rec().end();
    clock.tick(200);
    expect(log.errors).toEqual([]);
    expect(world.recs).toHaveLength(2);
    expect(engine.state).toBe("listening");
  });

  it("a recogniser that never reports anything after start() fails as 'not-started' instead of waiting for ever", () => {
    // Seen with the real recogniser in headless Chromium: start() returns, then no start, error or end event ever
    // arrives. A permission prompt the person hasn't answered looks the same from here.
    const { engine, log, clock, world, rec } = setup({ allowCloud: true });
    engine.start("tap");
    expect(engine.state).toBe("requesting-permission");
    clock.tick(6999);
    expect(log.errors).toEqual([]);
    clock.tick(1);
    expect(log.errors).toEqual([expect.objectContaining({ code: "not-started", recoverable: true })]);
    expect(log.errors[0].message).toMatch(/permission|address bar/i);
    expect(engine.state).toBe("failed");
    expect(rec().aborted).toBe(true);
    expect(world.recs).toHaveLength(1);
  });

  it("the start timeout is cancelled as soon as the browser says anything", () => {
    const { engine, log, clock, rec, listen } = setup({ allowCloud: true });
    listen("tap"); // begin() fires onstart
    clock.tick(7500); // past the 7s start timeout, before tap mode's 8s no-speech timer
    expect(log.errors).toEqual([]);
    expect(engine.state).toBe("listening");
    // An early error, before onstart, also cancels it: one error, not two.
    const second = setup({ allowCloud: true });
    second.engine.start("tap");
    second.rec().error("not-allowed");
    second.clock.tick(10_000);
    expect(second.log.errors).toHaveLength(1);
    expect(second.log.errors[0].code).toBe("not-allowed");
    void rec;
  });

  it("stop() or cancel() during the wait clears the timeout", () => {
    const { engine, log, clock } = setup({ allowCloud: true });
    engine.start("tap");
    engine.cancel();
    clock.tick(10_000);
    expect(log.errors).toEqual([]);
    expect(engine.state).toBe("idle");
  });

  it("a fresh start() clears a failure", () => {
    const { engine, rec, listen } = setup();
    listen("tap");
    rec().error("network");
    expect(engine.state).toBe("failed");
    listen("tap");
    expect(engine.state).toBe("listening");
  });
});

describe("privacy: where speech is recognised", () => {
  // SpeechRecognition.available() is never called: it crashed Chromium in testing. On-device is simply tried, and a
  // missing language pack comes back as a recogniser error.
  it("uses on-device recognition when the person chose it, starting inside the click without probing", () => {
    const { engine, rec, available } = setup({ available: "available", allowCloud: false });
    engine.start("tap");
    expect(available).not.toHaveBeenCalled();
    expect(engine.backend).toBe("on-device");
    expect(rec().processLocally).toBe(true);
    expect(rec().lang).toBe("en-GB");
    expect(rec().continuous).toBe(true);
    expect(rec().interimResults).toBe(true);
  });

  it("with the online service allowed, starts at once inside the click, without asking about on-device support", () => {
    const { engine, world, available, rec } = setup({ available: "available", allowCloud: true });
    engine.start("tap");
    expect(world.recs).toHaveLength(1);
    expect(available).not.toHaveBeenCalled();
    expect(engine.backend).toBe("cloud");
    expect(rec().processLocally).not.toBe(true);
  });

  it("on-device without the language pack: the recogniser's error becomes 'language-unavailable', and it isn't retried", () => {
    const { engine, log, world, rec } = setup({ available: "downloadable", allowCloud: false });
    engine.start("continuous");
    rec().begin();
    rec().error("language-not-supported");
    expect(log.errors).toEqual([expect.objectContaining({ code: "language-unavailable", recoverable: false })]);
    expect(log.errors[0].message).toMatch(/Display and voice/);
    expect(engine.state).toBe("failed");
    expect(world.recs).toHaveLength(1);
  });

  it("without an on-device API (Safari), cloud needs consent", () => {
    const allowed = setup({ allowCloud: true });
    allowed.engine.start("tap");
    expect(allowed.engine.backend).toBe("cloud");
    expect(allowed.world.recs).toHaveLength(1);
    const refused = setup({ allowCloud: false });
    refused.engine.start("tap");
    expect(refused.world.recs).toHaveLength(0);
    expect(refused.log.errors).toEqual([expect.objectContaining({ code: "language-unavailable", recoverable: false })]);
  });

  it("reports 'unsupported' when there is no speech recognition at all", () => {
    const { engine, log } = setup({ noRecognition: true });
    expect(engine.backend).toBe("none");
    engine.start("tap");
    expect(log.errors).toEqual([expect.objectContaining({ code: "unsupported", recoverable: false })]);
  });

  it("detectBackend answers without opening the microphone", async () => {
    const make = (available?: string) => {
      const Rec = class {} as unknown as { available?: () => Promise<string> };
      if (available) Rec.available = async () => available;
      return { SpeechRecognition: Rec };
    };
    expect(await detectBackend(make("available"), "en-GB", false)).toBe("on-device");
    expect(await detectBackend(make("downloadable"), "en-GB", true)).toBe("cloud");
    expect(await detectBackend(make("downloadable"), "en-GB", false)).toBe("none");
    expect(await detectBackend(make(), "en-GB", true)).toBe("cloud");
    expect(await detectBackend({}, "en-GB", true)).toBe("none");
  });
});

describe("lifecycle", () => {
  it("dispose() aborts recognition, clears every timer and removes listeners", () => {
    const { engine, log, clock, rec, listen, listeners, doc } = setup();
    expect(listeners.size).toBe(1);
    listen("continuous");
    engine.setSpeaking("Your bill is £120.");
    rec().hear(["what about groceries", "final"]); // barge-in: interrupted timer and pause timer running
    expect(clock.timers.size).toBeGreaterThan(0);
    const before = log.states.length;
    engine.dispose();
    expect(rec().aborted).toBe(true);
    expect(clock.timers.size).toBe(0);
    expect(listeners.size).toBe(0);
    rec().hear(["late", "final"]);
    rec().end();
    doc.hide();
    engine.start("tap");
    clock.tick(10_000);
    expect(log.utterances).toEqual([]);
    expect(log.states.length).toBe(before);
  });
});

describe("continuous listening stops when it's quiet", () => {
  const quiet = { quietMs: 120_000 };

  it("closes the microphone after the quiet period with nothing said, and says why", () => {
    const { engine, log, clock, rec, world, listen } = setup({ timing: quiet });
    listen("continuous");
    // Chrome ends quiet sessions every few seconds; the engine restarts them, but they don't count as speech.
    for (let i = 0; i < 20; i++) {
      clock.tick(5000);
      rec().end();
      clock.tick(200);
      rec().begin();
    }
    clock.tick(120_000 - 20 * 5200 - 1);
    expect(engine.state).toBe("listening");
    clock.tick(1);
    expect(engine.state).toBe("failed");
    expect(world.open).toBe(0);
    expect(log.errors.at(-1)).toMatchObject({ code: "no-speech", recoverable: true });
    expect(log.errors.at(-1)!.message).toMatch(/quiet/);
  });

  it("counts from the last words the person said, not from start", () => {
    const { engine, log, clock, rec, listen } = setup({ timing: quiet });
    listen("continuous");
    clock.tick(100_000);
    rec().hear(["what's my balance", "final"]);
    clock.tick(1100);
    expect(texts(log.utterances)).toEqual(["what's my balance"]);
    clock.tick(100_000);
    expect(engine.state).toBe("listening");
    clock.tick(20_000);
    expect(engine.state).toBe("failed");
  });

  it("doesn't count Dial's own voice as the person speaking", () => {
    const { engine, clock, rec, listen } = setup({ timing: quiet });
    listen("continuous");
    clock.tick(60_000);
    engine.setSpeaking("your balance is two hundred pounds");
    rec().hear("your balance is two hundred pounds");
    engine.setSpeaking(null);
    clock.tick(60_000);
    expect(engine.state).toBe("failed");
  });

  it("waits while Dial is still answering", () => {
    const { engine, clock, listen } = setup({ timing: quiet });
    listen("continuous");
    engine.setProcessing(true);
    clock.tick(120_000);
    expect(engine.state).toBe("processing");
    engine.setProcessing(false);
    clock.tick(120_000);
    expect(engine.state).toBe("failed");
  });

  it("never applies to tap or push-to-talk", () => {
    const { engine, clock, listen } = setup({ timing: { ...quiet, noSpeechMs: 10 ** 9 } });
    listen("hold");
    clock.tick(300_000);
    expect(engine.state).toBe("listening");
    engine.stop();
  });
});
