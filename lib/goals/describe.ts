// Plain-English names for goals, used as their titles everywhere (Goals screen, Dial confirmations, progress).
import { DEMO_TODAY } from "../demo-clock";
import { monthName } from "../dial/months";
import type { GoalSpec } from "../dial/types";
import { formatPence } from "../format";
import type { ISODate, Pence } from "../types";

/** "£80" for whole pounds, "£80.50" otherwise. Same style as the Spend Pause amounts. */
export const goalAmount = (p: Pence) => formatPence(p).replace(/\.00$/, "");

/** e.g. "Spend under £80 on eating out each month". `today` only decides whether a month needs its year. */
export function describeGoal(spec: GoalSpec, today: ISODate = DEMO_TODAY): string {
  switch (spec.kind) {
    case "category_cap":
      return `Spend under ${goalAmount(spec.monthlyLimit)} on ${spec.category.toLowerCase()} each month`;
    case "spend_reduction":
      return `Spend ${goalAmount(spec.target)} less than in ${monthName(spec.baselineMonth, today)}, in total, by the end of ${monthName(spec.by, today)}`;
    case "stay_in_budget":
      return "Stay within your Spend Pause monthly budget";
    case "pay_down":
      return spec.target === 0
        ? `Pay off your card balance by the end of ${monthName(spec.by, today)}`
        : `Bring your card balance down to ${goalAmount(spec.target)} by the end of ${monthName(spec.by, today)}`;
    case "utilisation":
      return `Use no more than ${spec.percent}% of your credit limit by the end of ${monthName(spec.by, today)}`;
    case "save_up":
      return spec.purpose === "emergency"
        ? `Build an emergency fund of ${goalAmount(spec.target)} by the end of ${monthName(spec.by, today)}`
        : `Save ${goalAmount(spec.target)} for ${spec.label || "a purchase"} by the end of ${monthName(spec.by, today)}`;
    case "pay_on_time":
      return "Pay at least the minimum on time, every bill";
  }
}
