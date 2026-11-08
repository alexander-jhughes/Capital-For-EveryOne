// The accessibility engine's guarantees, without the model: safety of adaptations, asking instead of guessing, what is
// listed as "your changes", turning one off, pausing them all, and that the look can never touch money.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toSteps } from "../ai/command-model";
import { validateStep } from "../dial/registry";
import type { DialStep } from "../dial/types";
import { applyActions, decodePrefs, DEFAULT_PREFS, describeActions, encodePrefs, pausedLook, prefAttributes, sanitize, visibleWidgets, WIDGETS, type UiAction } from "../preferences/schema";
import { activeChanges, turnOff } from "./active";
import { SITUATIONS } from "./catalogue";
import { clarify, WHAT_WOULD_HELP } from "./clarify";
import { PROTECTED_NOTE, PROTECTED_WIDGETS, withoutProtectedHides } from "./safety";
import { changesFor } from "./understand";

describe("safety: essential financial information stays", () => {
  it("no situation ever hides the bill, Spend Pause or Dial's warnings, or touches money", () => {
    for (const s of SITUATIONS)
      for (const { action } of s.changes) {
        expect(action.type === "hide" && PROTECTED_WIDGETS.includes(action.widget), `${s.id}: ${JSON.stringify(action)}`).toBe(false);
        expect(action.type, s.id).not.toBe("reset");
      }
  });

  it("a calmer home screen always keeps the bill, whatever was moved above it, in both views", () => {
    for (const mode of ["simple", "complex"] as const) {
      const p = applyActions(DEFAULT_PREFS, [
        { type: "moveToTop", widget: "chart" },
        { type: "moveToTop", widget: "recent" },
        { type: "moveToTop", widget: "categories" },
        { type: "density", value: "calm" },
      ]);
      const shown = visibleWidgets(mode, p.layout);
      expect(shown, mode).toContain("bill");
      expect(shown.slice(0, 3), mode).toEqual(["categories", "recent", "chart"]);
    }
  });

  it("every situation's changes leave the bill on Home in both views", () => {
    for (const s of SITUATIONS)
      for (const mode of ["simple", "complex"] as const) {
        const p = applyActions(DEFAULT_PREFS, changesFor([s.id]).map((c) => c.action));
        expect(visibleWidgets(mode, p.layout), `${s.id} ${mode}`).toContain("bill");
      }
  });

  it("a model's step can't hide a protected section; other changes in the same step survive", () => {
    const steps: DialStep[] = [
      { type: "preferences", actions: [{ type: "hide", widget: "pause" }, { type: "density", value: "calm" }, { type: "hide", widget: "chart" }] },
      { type: "navigate", to: "/account" },
    ];
    const r = withoutProtectedHides(steps);
    expect(r.removed).toBe(true);
    expect(r.steps).toEqual([{ type: "preferences", actions: [{ type: "density", value: "calm" }, { type: "hide", widget: "chart" }] }, { type: "navigate", to: "/account" }]);
    for (const w of PROTECTED_WIDGETS) {
      const only = withoutProtectedHides([{ type: "preferences", actions: [{ type: "hide", widget: w }] }]);
      expect(only).toEqual({ steps: [], removed: true });
    }
    expect(withoutProtectedHides([{ type: "preferences", actions: [{ type: "textSize", value: 150 }] }]).removed).toBe(false);
    expect(PROTECTED_NOTE).toMatch(/Settings/);
  });

  it("rejects invalid or hostile model output: unknown settings, CSS, code and out-of-range values never become a step", () => {
    const hostile = [
      { do: "display", setting: "css", value: "body{display:none}" },
      { do: "display", setting: "textSize", value: "900" },
      { do: "display", setting: "contrast", value: "<script>alert(1)</script>" },
      { do: "display", setting: "focusRing", value: "javascript:alert(1)" },
      { do: "situation", situation: "diagnose_user" },
      { do: "eval", code: "document.body.remove()" },
    ];
    expect(toSteps(hostile, { route: "/account", mode: "simple", textSize: 100 })).toEqual([]);
    expect(validateStep({ type: "preferences", actions: [{ type: "focusRing", value: "huge" }] })).toBeNull();
    expect(validateStep({ type: "preferences", actions: [{ type: "focusRing", value: "strong" }] })).not.toBeNull();
    expect(validateStep({ type: "adapt", situations: ["navigation"], scope: "always", extra: "x" })).toBeNull();
  });

  it("the look can never change a figure: nothing in lib/finance reads preferences", () => {
    const dir = fileURLToPath(new URL("../finance/", import.meta.url));
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) expect(readFileSync(dir + f, "utf8"), f).not.toMatch(/preferences|lib\/access|from "\.\.\/access/);
  });
});

describe("asking instead of guessing", () => {
  it("asks about a contradiction on one thing", () => {
    expect(clarify("make the text bigger and smaller")).toBe("Do you want it bigger or smaller?");
    expect(clarify("switch to dark mode and light mode")).toBe("Would you like a dark screen or a light one?");
    expect(clarify("more contrast but less contrast")).toMatch(/stronger contrast or softer/);
  });

  it("doesn't ask when two different things are named, or when the problem is described then one fix asked for", () => {
    expect(clarify("make the text bigger and the buttons smaller")).toBeNull();
    expect(clarify("it's too dark, make it lighter")).toBeNull();
    expect(clarify("everything is too small, make it bigger")).toBeNull();
    expect(clarify("did I spend more or less than last month")).toBeNull();
  });

  it("offers real options for a vague request, but not for a specific one", () => {
    for (const t of ["make it better", "Change it.", "can you fix this please", "I don't like it", "It's not working for me"]) expect(clarify(t), t).toBe(WHAT_WOULD_HELP);
    for (const t of ["make it better for my eyes", "make the text bigger", "I can't see the text", "how much did I spend"]) expect(clarify(t), t).toBeNull();
  });
});

describe("your changes", () => {
  it("lists nothing for the standard look, and each change in plain words", () => {
    expect(activeChanges(DEFAULT_PREFS)).toEqual([]);
    const p = applyActions(DEFAULT_PREFS, [
      { type: "textSize", value: 150 },
      { type: "focusRing", value: "strong" },
      { type: "density", value: "calm" },
      { type: "moveToTop", widget: "bill" },
      { type: "hide", widget: "chart" },
      { type: "nightLook", actions: [{ type: "theme", value: "dark" }] },
      { type: "onboarding", value: "done" },
    ]);
    const list = activeChanges(p);
    expect(list).toEqual([
      { type: "textSize", value: 150 },
      { type: "focusRing", value: "strong" },
      { type: "nightLook", actions: [{ type: "theme", value: "dark" }] },
      { type: "density", value: "calm" },
      { type: "moveToTop", widget: "bill" },
      { type: "hide", widget: "chart" },
    ]);
    for (const a of list) expect(describeActions([a]).length).toBeGreaterThan(5);
  });

  it("turning each change off brings that setting back to standard and leaves the rest", () => {
    const actions: UiAction[] = [
      { type: "textSize", value: 200 },
      { type: "contrast", value: "high" },
      { type: "tapGuard", value: true },
      { type: "focusRing", value: "strong" },
      { type: "density", value: "calm" },
      { type: "emphasize", widget: "bill" },
      { type: "hide", widget: "chart" },
      { type: "nightLook", actions: [{ type: "theme", value: "dark" }] },
    ];
    const p = applyActions(DEFAULT_PREFS, actions);
    for (const a of activeChanges(p)) {
      const off = turnOff(a)!;
      expect(off, JSON.stringify(a)).not.toBeNull();
      const after = applyActions(p, [off]);
      expect(activeChanges(after), JSON.stringify(a)).not.toContainEqual(a);
      // Turning off a hide uses "show", which then lists as shown in both views; everything else simply goes.
      if (a.type !== "hide") expect(activeChanges(after)).toHaveLength(activeChanges(p).length - 1);
    }
    expect(turnOff({ type: "moveToTop", widget: "bill" })).toBeNull();
  });
});

describe("pausing and the focus ring", () => {
  it("pausing shows the standard look but keeps consent and setup choices", () => {
    const p = applyActions(DEFAULT_PREFS, [
      { type: "textSize", value: 200 },
      { type: "speechInput", value: "on-device" },
      { type: "onboarding", value: "done" },
      { type: "listenMode", value: "hold" },
      { type: "density", value: "calm" },
    ]);
    const look = pausedLook(p);
    expect(prefAttributes(look)).toEqual(prefAttributes(DEFAULT_PREFS));
    expect(look.layout).toEqual(DEFAULT_PREFS.layout);
    expect([look.speechInput, look.onboarding, look.listenMode]).toEqual(["on-device", "done", "hold"]);
    expect(p.textSize).toBe(200); // nothing kept is changed
  });

  it("the focus ring is allowlisted, reaches the page as an attribute and survives the cookie", () => {
    expect(sanitize({ focusRing: "strong" }).focusRing).toBe("strong");
    expect(sanitize({ focusRing: "outline: none" }).focusRing).toBe("standard");
    const p = applyActions(DEFAULT_PREFS, [{ type: "focusRing", value: "strong" }]);
    expect(prefAttributes(p)["data-focus-ring"]).toBe("strong");
    expect(decodePrefs(encodePrefs(p)).focusRing).toBe("strong");
  });

  it("a cookie with every adaptation on still fits the size the server reads", () => {
    const all = applyActions(DEFAULT_PREFS, [
      ...SITUATIONS.flatMap((s) => s.changes.map((c) => c.action)),
      ...WIDGETS.map((w) => ({ type: "moveToTop", widget: w }) as UiAction),
      { type: "nightLook", actions: [{ type: "theme", value: "dark" }, { type: "contrast", value: "high" }, { type: "textSize", value: 150 }] },
    ]);
    expect(encodePrefs(all).length).toBeLessThanOrEqual(2000);
    expect(decodePrefs(encodePrefs(all))).toEqual(all);
  });
});
