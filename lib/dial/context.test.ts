import { describe, expect, it } from "vitest";
import { afterAnswer, nextSubject, withPending, withRoute } from "./context";
import { EMPTY_CONTEXT } from "./types";

describe("afterAnswer", () => {
  it("keeps the backend's resolved question, or the person's own words", () => {
    expect(afterAnswer(EMPTY_CONTEXT, { question: "And last month?", resolvedQuestion: "What did I spend last month?" }).lastQuestion).toBe("What did I spend last month?");
    expect(afterAnswer(EMPTY_CONTEXT, { question: " Is my spending OK? " }).lastQuestion).toBe("Is my spending OK?");
    expect(afterAnswer(EMPTY_CONTEXT, { question: "x", resolvedQuestion: "  " }).lastQuestion).toBe("x");
  });
  it("caps the length and ignores an empty question", () => {
    expect(afterAnswer(EMPTY_CONTEXT, { question: "a".repeat(400) }).lastQuestion).toHaveLength(300);
    const ctx = { ...EMPTY_CONTEXT, lastQuestion: "before" };
    expect(afterAnswer(ctx, { question: "  " })).toBe(ctx);
  });
  it("changes nothing else", () => {
    const ctx = { ...EMPTY_CONTEXT, subject: { category: "Groceries" as const }, route: "/account" as const };
    expect(afterAnswer(ctx, { question: "q" })).toEqual({ ...ctx, lastQuestion: "q" });
  });
});

describe("withRoute and withPending", () => {
  it("records the page and view", () => {
    expect(withRoute(EMPTY_CONTEXT, "/account/spending", "complex")).toMatchObject({ route: "/account/spending", mode: "complex" });
    expect(withRoute(EMPTY_CONTEXT, null, "simple")).toBe(EMPTY_CONTEXT);
  });
  it("sets and clears a pending step", () => {
    const ctx = withPending(EMPTY_CONTEXT, { type: "back" });
    expect(ctx.pending).toEqual({ type: "back" });
    expect(withPending(ctx, null).pending).toBeNull();
  });
});

describe("nextSubject", () => {
  const prev = { category: "Groceries" as const, months: ["2026-10"] };
  it("a fresh request that names something replaces the subject", () => {
    expect(nextSubject(prev, { category: "Transport" }, false)).toEqual({ category: "Transport" });
  });
  it("a follow-up keeps what it doesn't change", () => {
    expect(nextSubject(prev, { category: "Eating out" }, true)).toEqual({ category: "Eating out", months: ["2026-10"] });
    expect(nextSubject(prev, { months: ["2026-09"] }, true)).toEqual({ category: "Groceries", months: ["2026-09"] });
  });
  it("a shop and a category don't both stand", () => {
    expect(nextSubject(prev, { merchant: "Tesco" }, true)).toEqual({ merchant: "Tesco", months: ["2026-10"] });
  });
  it("naming nothing changes nothing", () => {
    expect(nextSubject(prev, {}, false)).toBe(prev);
  });
});
