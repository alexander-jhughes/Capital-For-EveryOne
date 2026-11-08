import { describe, expect, it } from "vitest";
import { isWidgetShown } from "./schema";
import {
  applyAction,
  applyActions,
  dialStyle,
  decodePrefs,
  DEFAULT_PREFS,
  describeActions,
  encodePrefs,
  prefAttributes,
  sanitize,
  visibleWidgets,
} from "./schema";

describe("sanitize (untrusted input)", () => {
  it("keeps only allowlisted values", () => {
    const p = sanitize({ textSize: 999, contrast: "neon", theme: "dark", layout: { pinned: ["bill", "evil", "bill"], emphasis: "x", density: "calm" }, script: "alert(1)" });
    expect(p.textSize).toBe(100);
    expect(p.contrast).toBe("standard");
    expect(p.theme).toBe("dark");
    expect(p.layout.pinned).toEqual(["bill"]);
    expect(p.layout.emphasis).toBeNull();
    expect(p.layout.density).toBe("calm");
    expect(p).not.toHaveProperty("script");
  });
  it("survives garbage", () => {
    for (const bad of [null, 5, "x", [], { layout: 7 }]) expect(sanitize(bad)).toEqual(DEFAULT_PREFS);
  });
  it("round-trips through the cookie and rejects oversized or broken cookies", () => {
    const p = applyActions(DEFAULT_PREFS, [{ type: "textSize", value: 150 }, { type: "moveToTop", widget: "recent" }]);
    expect(decodePrefs(encodePrefs(p))).toEqual(p);
    expect(decodePrefs("%7Bbroken")).toEqual(DEFAULT_PREFS);
    expect(decodePrefs("x".repeat(3000))).toEqual(DEFAULT_PREFS);
    expect(decodePrefs(undefined)).toEqual(DEFAULT_PREFS);
  });
});

describe("applyAction", () => {
  it("is pure", () => {
    const before = JSON.stringify(DEFAULT_PREFS);
    applyAction(DEFAULT_PREFS, { type: "hide", widget: "chart" });
    expect(JSON.stringify(DEFAULT_PREFS)).toBe(before);
  });
  it("hide undoes pin, show and emphasis for that widget", () => {
    let p = applyActions(DEFAULT_PREFS, [{ type: "moveToTop", widget: "chart" }, { type: "emphasize", widget: "chart" }]);
    p = applyAction(p, { type: "hide", widget: "chart" });
    expect(p.layout).toMatchObject({ pinned: [], hidden: ["chart"], emphasis: null });
  });
  it("reset returns the defaults", () => {
    expect(applyAction(applyAction(DEFAULT_PREFS, { type: "contrast", value: "high" }), { type: "reset" })).toEqual(DEFAULT_PREFS);
  });
});

describe("visibleWidgets: layout is independent of the view", () => {
  it("each view has its own defaults", () => {
    expect(visibleWidgets("simple", DEFAULT_PREFS.layout)).toEqual(["bill", "insights", "pause"]);
    expect(visibleWidgets("complex", DEFAULT_PREFS.layout)[0]).toBe("balance");
  });
  it("the same layout applies to both views", () => {
    const l = applyActions(DEFAULT_PREFS, [{ type: "moveToTop", widget: "recent" }, { type: "hide", widget: "pause" }]).layout;
    expect(visibleWidgets("simple", l)).toEqual(["recent", "bill", "insights"]);
    expect(visibleWidgets("complex", l)[0]).toBe("recent");
    expect(visibleWidgets("complex", l)).not.toContain("pause");
  });
  it("calm keeps the first three without switching view", () => {
    const l = applyAction(DEFAULT_PREFS, { type: "density", value: "calm" }).layout;
    expect(visibleWidgets("complex", l)).toEqual(["balance", "bill", "insights"]);
  });
});

describe("describeActions and attributes", () => {
  it("reads naturally", () => {
    expect(describeActions([{ type: "moveToTop", widget: "bill" }, { type: "emphasize", widget: "bill" }])).toBe(
      "put your bill and next payment at the top and make your bill and next payment stand out",
    );
    expect(describeActions([{ type: "textSize", value: 125 }])).toBe("make the text 125% of the standard size");
  });
  it("maps to data attributes", () => {
    expect(prefAttributes(DEFAULT_PREFS)).toEqual({
      "data-text": "100",
      "data-contrast": "standard",
      "data-spacing": "standard",
      "data-motion": "system",
      "data-theme": "system",
      "data-targets": "standard",
      "data-reading": "standard",
      "data-colours": "standard",
      "data-reach": "standard",
      "data-tap-guard": "false",
    });
  });
});

describe("clearEmphasis", () => {
  it("removes the highlight only", () => {
    const p = applyActions(DEFAULT_PREFS, [{ type: "moveToTop", widget: "bill" }, { type: "emphasize", widget: "bill" }, { type: "clearEmphasis" }]);
    expect(p.layout).toMatchObject({ emphasis: null, pinned: ["bill"] });
  });
});

describe("assistant preferences (explanations, voice first, onboarding)", () => {
  it("default off, allowlisted, and round-trip through the cookie", () => {
    expect(DEFAULT_PREFS).toMatchObject({ explanations: "standard", voiceFirst: false, onboarding: "unset" });
    const p = sanitize({ explanations: "stepByStep", voiceFirst: true, onboarding: "done" });
    expect(p).toMatchObject({ explanations: "stepByStep", voiceFirst: true, onboarding: "done" });
    expect(decodePrefs(encodePrefs(p))).toEqual(p);
    expect(sanitize({ explanations: "essay", voiceFirst: "yes", onboarding: "forced" })).toMatchObject({ explanations: "standard", voiceFirst: false, onboarding: "unset" });
  });
  it("actions apply and describe", () => {
    const p = applyActions(DEFAULT_PREFS, [{ type: "explanations", value: "stepByStep" }, { type: "voiceFirst", value: true }]);
    expect(p).toMatchObject({ explanations: "stepByStep", voiceFirst: true });
    expect(describeActions([{ type: "voiceFirst", value: true }])).toBe("make talking to Dial the first option");
  });
});

describe("Dial upgrade preferences (answer style, listening, speech consent)", () => {
  it("default to standard answers, tap to talk, and not asked about speech yet", () => {
    expect(DEFAULT_PREFS).toMatchObject({ answerStyle: "standard", listenMode: "tap", speechInput: "unset" });
  });
  it("are allowlisted and round-trip through the cookie", () => {
    const p = sanitize({ answerStyle: "brief", listenMode: "continuous", speechInput: "on-device" });
    expect(decodePrefs(encodePrefs(p))).toEqual(p);
    expect(sanitize({ answerStyle: "essay", listenMode: "always", speechInput: "yes" })).toMatchObject({ answerStyle: "standard", listenMode: "tap", speechInput: "unset" });
  });
  it("dialStyle: step by step wins, then brief, else standard", () => {
    expect(dialStyle({ explanations: "stepByStep", answerStyle: "brief" })).toBe("stepByStep");
    expect(dialStyle({ explanations: "standard", answerStyle: "brief" })).toBe("brief");
    expect(dialStyle(DEFAULT_PREFS)).toBe("standard");
  });
  it("actions apply and describe", () => {
    const p = applyActions(DEFAULT_PREFS, [{ type: "answerStyle", value: "brief" }, { type: "listenMode", value: "hold" }]);
    expect(p).toMatchObject({ answerStyle: "brief", listenMode: "hold" });
    expect(describeActions([{ type: "answerStyle", value: "brief" }])).toBe("keep my answers short");
  });
});

describe("isWidgetShown (the settings tick)", () => {
  const layout = { ...DEFAULT_PREFS.layout };
  it("follows the view's defaults, not just the hidden list", () => {
    expect(isWidgetShown("simple", layout, "balance")).toBe(false); // Simple leaves it off by default
    expect(isWidgetShown("complex", layout, "balance")).toBe(true);
    expect(isWidgetShown("simple", layout, "bill")).toBe(true);
  });
  it("a shown widget is ticked in Simple, a hidden one is not ticked in Detailed, and calm density doesn't change ticks", () => {
    expect(isWidgetShown("simple", { ...layout, shown: ["balance"] }, "balance")).toBe(true);
    expect(isWidgetShown("complex", { ...layout, hidden: ["chart"] }, "chart")).toBe(false);
    expect(isWidgetShown("complex", { ...layout, density: "calm" }, "recent")).toBe(true);
  });
  it("ticking an unticked Simple widget is a show action that puts it on Home", () => {
    const next = applyActions(DEFAULT_PREFS, [{ type: "show", widget: "balance" }]);
    expect(visibleWidgets("simple", next.layout)).toContain("balance");
    expect(isWidgetShown("simple", next.layout, "balance")).toBe(true);
  });
});
