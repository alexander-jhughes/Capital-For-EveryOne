import { ApiError } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { interpretCommand, type CommandModel } from "./command-model";
import { isRateLimit, modelChain, withModelFallback } from "./model-chain";
import { answerQuestion } from "./ask";
import { seedContext } from "./facts";
import type { AskModel } from "./model";

const api = (status: number) => new ApiError({ message: `status ${status}`, status });

describe("modelChain", () => {
  it("is the main model, then the backups, without repeats", () => {
    expect(modelChain({})).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview"]);
    expect(modelChain({ GEMINI_MODEL: "gemini-3.1-flash-lite" })).toEqual(["gemini-3.1-flash-lite", "gemini-3-flash-preview"]);
    expect(modelChain({ GEMINI_MODEL: "a", GEMINI_FALLBACK_MODELS: "b, c ,a" })).toEqual(["a", "b", "c"]);
    expect(modelChain({ GEMINI_MODEL: "a", GEMINI_FALLBACK_MODELS: "" })).toEqual(["a"]);
  });
});

describe("withModelFallback", () => {
  it("moves to the next model on a rate limit, an overload or a missing model", async () => {
    for (const status of [429, 503, 404, 500]) {
      const call = vi.fn(async (m: string) => {
        if (m === "a") throw api(status);
        return `ok from ${m}`;
      });
      expect(await withModelFallback(["a", "b"], call)).toBe("ok from b");
    }
  });

  it("stops at once for errors another model won't fix (bad key, bad request, timeouts)", async () => {
    for (const error of [api(400), api(401), api(403), new Error("timeout")]) {
      const call = vi.fn(async () => {
        throw error;
      });
      await expect(withModelFallback(["a", "b", "c"], call)).rejects.toBe(error);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("throws the last error when every model is out of quota", async () => {
    const call = vi.fn(async () => {
      throw api(429);
    });
    await expect(withModelFallback(["a", "b", "c"], call)).rejects.toSatisfy(isRateLimit);
    expect(call).toHaveBeenCalledTimes(3);
  });
});

describe("telling the person when Gemini is busy", () => {
  it("answers from the account checks and says Gemini was busy", async () => {
    const busy: AskModel = { classify: vi.fn(async () => null), phrase: vi.fn(async () => { throw api(429); }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await answerQuestion("Has Netflix gone up in price lately?", { model: busy, ctx: seedContext() });
    warn.mockRestore();
    expect(r.source).toBe("template");
    expect(r.modelBusy).toBe(true);
    expect(r.answer).toContain("£12.99");
  });

  it("does not claim busy when Gemini simply answered", async () => {
    const ok: AskModel = { classify: vi.fn(async () => null), phrase: vi.fn(async () => "Yes, Netflix went up from £10.99 to £12.99, which is £2.00 more, charged on Wednesday 4 November.") };
    const r = await answerQuestion("Has Netflix gone up in price lately?", { model: ok, ctx: seedContext() });
    expect(r.source).toBe("model");
    expect(r.modelBusy).toBeUndefined();
  });

  it("/api/dial reports busy so the browser can say so", async () => {
    const model: CommandModel = { interpret: async () => { throw api(429); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await interpretCommand("make it nicer", { route: "/account", mode: "simple", textSize: 100 }, model);
    warn.mockRestore();
    expect(out).toEqual({ steps: [], source: "failed", busy: true });
    const other: CommandModel = { interpret: async () => { throw api(400); } };
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await interpretCommand("x", { route: null, mode: "simple", textSize: 100 }, other)).busy).toBeUndefined();
    warn2.mockRestore();
  });
});
