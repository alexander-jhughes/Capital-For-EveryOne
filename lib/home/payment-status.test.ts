import { describe, expect, it } from "vitest";
import { paymentStatus, whenText } from "./payment-status";

describe("paymentStatus", () => {
  it("counts payments made since the statement towards the minimum", () => {
    expect(paymentStatus(48620, 2500, 0, 5).text).toBe("Not paid yet. At least £25.00 is due in 5 days.");
    expect(paymentStatus(47620, 2500, 1000, 5).text).toBe("£10.00 paid. £15.00 more is needed to cover the minimum, due in 5 days.");
    expect(paymentStatus(46120, 2500, 2500, 5).text).toBe("Minimum paid. £461.20 of the bill is still to pay.");
    expect(paymentStatus(0, 0, 48620, 5).text).toBe("Your bill is paid in full.");
  });
  it("only warns about a late payment when the due date has passed and the minimum isn't covered", () => {
    expect(paymentStatus(48620, 2500, 0, -2).text).toBe("£25.00 of the minimum was due 2 days ago and hasn't been paid.");
    expect(paymentStatus(46120, 2500, 2500, -2).state).toBe("paid");
  });
  it("words the days", () => {
    expect([0, 1, 5, -1].map(whenText)).toEqual(["today", "tomorrow", "in 5 days", "1 day ago"]);
  });
});
