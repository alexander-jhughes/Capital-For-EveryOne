import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyActions,
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
    });
  });
});

describe("clearEmphasis", () => {
  it("removes the highlight only", () => {
    const p = applyActions(DEFAULT_PREFS, [{ type: "moveToTop", widget: "bill" }, { type: "emphasize", widget: "bill" }, { type: "clearEmphasis" }]);
    expect(p.layout).toMatchObject({ emphasis: null, pinned: ["bill"] });
  });
});
