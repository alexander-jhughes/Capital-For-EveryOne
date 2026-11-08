// Gemini is replaced by a fake model here: these tests check what happens to whatever it says, not Gemini itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCommandCache, askGeminiForSteps } from "../assistant/command-client";
import { handleDial, parseBody } from "./command-handler";
import { interpretCommand, toSteps, toUiAction, type CommandModel, type ScreenInfo } from "./command-model";
import { resetRateLimit } from "./rate-limit";

const screen: ScreenInfo = { route: "/account", mode: "complex", textSize: 100 };
const fake = (reply: unknown): CommandModel => ({ interpret: vi.fn(async () => reply as never) });

describe("toSteps: Gemini's flat actions become validated steps", () => {
  it("opens real pages, with Home focus and Spending filters", () => {
    expect(toSteps([{ do: "go", page: "/account/spending", category: "Groceries", month: "2026-10" }], screen)).toEqual([
      { type: "navigate", to: "/account/spending", filters: { category: "Groceries", month: "2026-10" } },
    ]);
    expect(toSteps([{ do: "go", page: "/account", focus: "bill" }], screen)).toEqual([{ type: "navigate", to: "/account", focus: "bill" }]);
    expect(toSteps([{ do: "go", page: "back" }], screen)).toEqual([{ type: "back" }]);
  });

  it("drops pages, settings and values that don't exist, rather than repairing them", () => {
    const bad = [
      { do: "go", page: "/admin" },
      { do: "go", page: "/account/pay/confirm" },
      { do: "display", setting: "fontFamily", value: "comic" },
      { do: "display", setting: "textSize", value: "9000" },
      { do: "display", setting: "theme", value: "neon" },
      { do: "pay", amount: 5000 },
      { do: "go" },
      "navigate",
      null,
    ];
    expect(toSteps(bad, screen)).toEqual([]);
  });

  it("steps text size from the current size, and merges display changes into one preview", () => {
    const steps = toSteps(
      [
        { do: "display", setting: "textSize", value: "bigger" },
        { do: "display", setting: "contrast", value: "high" },
        { do: "display", setting: "hide", value: "chart" },
      ],
      { ...screen, textSize: 125 },
    );
    expect(steps).toEqual([{ type: "preferences", actions: [{ type: "textSize", value: 150 }, { type: "contrast", value: "high" }, { type: "hide", widget: "chart" }] }]);
    expect(toUiAction("textSize", "bigger", 200)).toEqual({ type: "textSize", value: 200 });
    expect(toUiAction("textSize", "smaller", 100)).toEqual({ type: "textSize", value: 100 });
  });

  it("covers view switching and charts, and ignores a malformed month", () => {
    expect(toSteps([{ do: "view", mode: "simple" }], screen)).toEqual([{ type: "setMode", mode: "simple" }]);
    expect(toSteps([{ do: "chart", chart: "category_trend", category: "Eating out", month: "2026-10" }], screen)).toEqual([
      { type: "visual", request: { kind: "category_trend", category: "Eating out", months: ["2026-10"] } },
    ]);
    expect(toSteps([{ do: "chart", chart: "monthly_trend", month: "October" }], screen)).toEqual([{ type: "visual", request: { kind: "monthly_trend" } }]);
  });

  it("returns at most three steps, and never anything that moves money", () => {
    const many = Array.from({ length: 10 }, () => ({ do: "go", page: "/account/pay" }));
    const steps = toSteps(many, screen);
    expect(steps.length).toBeLessThanOrEqual(3);
    // Opening Pay is only navigation: the person confirms any payment on that screen.
    expect(steps.every((s) => s.type === "navigate")).toBe(true);
    expect(JSON.stringify(steps)).not.toMatch(/amount|payment"|makePayment/);
  });
});

describe("interpretCommand", () => {
  it("returns steps from the model, and tells the model nothing about the account", async () => {
    const model = fake({ actions: [{ do: "display", setting: "contrast", value: "high" }] });
    const out = await interpretCommand("it's hard to see this <b>screen</b>", screen, model);
    expect(out).toEqual({ steps: [{ type: "preferences", actions: [{ type: "contrast", value: "high" }] }], source: "model" });
    expect(model.interpret).toHaveBeenCalledWith("it's hard to see this  b screen /b", screen, 4000);
    // Only the words and the three screen facts reach the model: no balances, merchants or history.
    expect(Object.keys(screen).sort()).toEqual(["mode", "route", "textSize"]);
  });

  it("reports no key, a failure and a useless reply without throwing", async () => {
    expect(await interpretCommand("x", screen, null)).toEqual({ steps: [], source: "none" });
    const boom: CommandModel = { interpret: async () => { throw new Error("secret details"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await interpretCommand("x", screen, boom)).toEqual({ steps: [], source: "failed" });
    expect(warn.mock.calls.join(" ")).not.toContain("secret details");
    warn.mockRestore();
    expect(await interpretCommand("x", screen, fake(null))).toEqual({ steps: [], source: "model" });
    expect(await interpretCommand("x", screen, fake({ actions: "go to /admin" }))).toEqual({ steps: [], source: "model" });
  });
});

describe("POST /api/dial", () => {
  beforeEach(resetRateLimit);
  const post = (body: unknown, model: CommandModel | null) =>
    handleDial(new Request("http://x/api/dial", { method: "POST", body: JSON.stringify(body) }), () => model);

  it("validates the body", () => {
    expect(parseBody({ text: "" })).toBeNull();
    expect(parseBody({ text: "a".repeat(301) })).toBeNull();
    expect(parseBody("hi")).toBeNull();
    expect(parseBody({ text: " make it bigger ", screen: { route: "/account/spending", mode: "simple", textSize: 150 } })).toEqual({
      text: "make it bigger",
      screen: { route: "/account/spending", mode: "simple", textSize: 150 },
    });
    expect(parseBody({ text: "hi", screen: { route: "<script>", textSize: 77 } })?.screen).toEqual({ route: null, mode: "complex", textSize: 100 });
  });

  it("answers with steps, or an empty result without a key, and rejects junk with a friendly 400", async () => {
    const ok = await post({ text: "bigger please", screen }, fake({ actions: [{ do: "display", setting: "textSize", value: "bigger" }] }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ source: "model", steps: [{ type: "preferences" }] });
    expect(await (await post({ text: "hello", screen }, null)).json()).toEqual({ steps: [], source: "none" });
    const bad = await post({ nope: 1 }, null);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/couldn't read/);
  });

  it("stops spending Gemini calls over the per-minute limit, without failing the request", async () => {
    process.env.ASK_MODEL_CALLS_PER_MINUTE = "2";
    const model = fake({ actions: [] });
    for (let i = 0; i < 4; i++) await post({ text: `hi ${i}`, screen }, model);
    // Calls 3 and 4 are over the limit: they still get a reply, but no model is used.
    expect(model.interpret).toHaveBeenCalledTimes(2);
    delete process.env.ASK_MODEL_CALLS_PER_MINUTE;
  });
});

describe("browser client", () => {
  beforeEach(clearCommandCache);
  const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

  it("keeps only steps that pass validation, and asks once for the same words on the same screen", async () => {
    const fetchImpl = reply({ source: "model", steps: [{ type: "navigate", to: "/account/spending" }, { type: "eval", code: "alert(1)" }, { type: "navigate", to: "/nope" }] });
    const a = await askGeminiForSteps("Show my spending", screen, { fetchImpl });
    const b = await askGeminiForSteps("show my spending!", screen, { fetchImpl });
    expect(a).toEqual([{ type: "navigate", to: "/account/spending" }]);
    expect(b).toEqual(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats errors, a missing key and a cancelled request as no answer, and keeps none of them", async () => {
    expect(await askGeminiForSteps("a", screen, { fetchImpl: reply({}, false) })).toBeNull();
    expect(await askGeminiForSteps("b", screen, { fetchImpl: reply({ source: "none", steps: [] }) })).toBeNull();
    const c = new AbortController();
    c.abort();
    expect(await askGeminiForSteps("c", screen, { fetchImpl: reply({ source: "model", steps: [] }), signal: c.signal })).toBeNull();
    const retry = reply({ source: "model", steps: [{ type: "back" }] });
    expect(await askGeminiForSteps("a", screen, { fetchImpl: retry })).toEqual([{ type: "back" }]);
  });
});
