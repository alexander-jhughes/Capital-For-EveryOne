import { describe, expect, it } from "vitest";
import { segment } from "./segment";

// A stand-in for the planner: a part is standalone when it starts with an instruction word.
const standalone = (part: string) => /^(take|open|show|make|use|go|compare|what|how|hide|put)\b/i.test(part);

describe("segment", () => {
  it.each([
    ["Show my groceries for October and then take me to settings", ["Show my groceries for October", "take me to settings"]],
    ["Open goals then show my spending", ["Open goals", "show my spending"]],
    ["Make it bigger, and use more contrast", ["Make it bigger", "use more contrast"]],
    ["Open settings and also make it bigger", ["Open settings", "make it bigger"]],
    ["Open settings. Show my spending.", ["Open settings.", "Show my spending."]],
    ["What did I spend? How much is my bill?", ["What did I spend?", "How much is my bill?"]],
    ["Hide the chart and put my bill at the top", ["Hide the chart", "put my bill at the top"]],
  ])("%s", (text, parts) => {
    expect(segment(text, standalone)).toEqual(parts);
  });

  it.each(["Show groceries and eating out", "Compare October and September", "Compare October, and September", "Show my spending, also known as outgoings"])(
    "keeps %s whole",
    (text) => {
      expect(segment(text, standalone)).toEqual([text]);
    },
  );

  it("joins only the part that can't stand alone, keeping the other splits", () => {
    expect(segment("Show October, and September, then open settings", standalone)).toEqual(["Show October, and September", "open settings"]);
  });

  it("is empty for empty input", () => {
    expect(segment("  ", standalone)).toEqual([]);
  });
});
