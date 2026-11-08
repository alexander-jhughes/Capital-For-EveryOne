// Phase 0 contract: optional /api/ask additions (style, resolvedQuestion, followUps, experience.insights, cancellation).
import { describe, expect, it, vi } from "vitest";
import { askDial, parseFollowUps, parseResolvedQuestion } from "./client";
import { parseExperience } from "./experience";

const ok = { answer: "You have spent £402.35 so far this month.", evidenceIds: ["t042"], source: "template" };
const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
const sent = (f: ReturnType<typeof reply>) => JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

describe("request additions", () => {
  it("sends an allowlisted style and nothing else new", async () => {
    const f = reply(ok);
    await askDial("How much did I spend?", { fetchImpl: f as unknown as typeof fetch, style: "brief" });
    expect(sent(f)).toEqual({ question: "How much did I spend?", style: "brief" });
  });
  it("drops an unknown style", async () => {
    const f = reply(ok);
    await askDial("x", { fetchImpl: f as unknown as typeof fetch, style: "shouty" as never });
    expect(Object.keys(sent(f))).toEqual(["question"]);
  });
});

describe("response additions are optional and validated", () => {
  it("passes resolvedQuestion and followUps through", async () => {
    const f = reply({ ...ok, resolvedQuestion: "How much did I spend on groceries this month?", followUps: ["Has that gone up?", "What about last month?"] });
    const r = await askDial("What about groceries?", { fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: "answer", resolvedQuestion: "How much did I spend on groceries this month?", followUps: ["Has that gone up?", "What about last month?"] });
  });
  it("missing additions still give the answer", async () => {
    const r = await askDial("x", { fetchImpl: reply(ok) as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: "answer", resolvedQuestion: undefined, followUps: [] });
  });
  it("bad additions are dropped, never the answer", () => {
    expect(parseResolvedQuestion("<script>")).toBeUndefined();
    expect(parseResolvedQuestion("x".repeat(301))).toBeUndefined();
    expect(parseResolvedQuestion(42)).toBeUndefined();
    expect(parseFollowUps(["Ok?", "ok?", "<b>no</b>", 3, "x".repeat(121), "A?", "B?", "C?"])).toEqual(["Ok?", "A?", "B?"]);
    expect(parseFollowUps("nope")).toEqual([]);
  });
  it("experience.insights keeps only well-formed ids, at most 5", () => {
    const e = parseExperience({ template: "spending", intent: "spending_insights", insights: ["category_change:Groceries", "spending_change", "bad id!", 7, "x:<script>"] });
    expect(e.insights).toEqual(["category_change:Groceries", "spending_change"]);
    expect(parseExperience({ template: "spending" }).insights).toBeUndefined();
  });
});

describe("cancellation", () => {
  it("an aborted signal returns cancelled, not unavailable", async () => {
    const ctrl = new AbortController();
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const p = askDial("x", { fetchImpl: f as unknown as typeof fetch, signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toEqual({ kind: "cancelled" });
  });
  it("already-aborted signal never sends", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = reply(ok);
    expect(await askDial("x", { fetchImpl: f as unknown as typeof fetch, signal: ctrl.signal })).toEqual({ kind: "cancelled" });
    expect(f).not.toHaveBeenCalled();
  });
});
