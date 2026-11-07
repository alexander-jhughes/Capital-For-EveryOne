import { describe, expect, it } from "vitest";
import { SEED_TRANSACTIONS as txns } from "../data/seed";
import { flagTransactions } from "./index";

const flags = flagTransactions(txns);
const idsWhere = (pred: (f: ReturnType<typeof flags.get> & object) => boolean) =>
  [...flags].filter(([, f]) => pred(f)).map(([id]) => txns.find((t) => t.id === id)!);

describe("flagTransactions", () => {
  it("flags every transaction exactly once", () => {
    expect(flags.size).toBe(txns.length);
  });

  it("possible duplicate: both Tesco £38.62 charges and nothing else", () => {
    const d = idsWhere((f) => f.possibleDuplicate);
    expect(d.map((t) => [t.merchant, t.amount, t.date])).toEqual([
      ["Tesco", 3862, "2026-11-05"],
      ["Tesco", 3862, "2026-11-06"],
    ]);
  });

  it("price change: only the November Netflix charge, up £2.00", () => {
    const p = idsWhere((f) => f.priceChange !== null);
    expect(p.map((t) => [t.merchant, t.date, flags.get(t.id)!.priceChange])).toEqual([["Netflix", "2026-11-04", 200]]);
    const octNetflix = txns.find((t) => t.merchant === "Netflix" && t.date === "2026-10-04")!;
    expect(flags.get(octNetflix.id)!.priceChange).toBeNull();
  });

  it("pending: the three 8 Nov items, including the Amazon refund", () => {
    const p = idsWhere((f) => f.pending);
    expect(p.map((t) => [t.merchant, t.amount])).toEqual([
      ["TfL", 290],
      ["Sainsbury's", 1875],
      ["Amazon", -1999],
    ]);
  });

  it("refunds: Amazon only; the card payment is a payment, not a refund", () => {
    const r = idsWhere((f) => f.refund);
    expect(r.map((t) => [t.merchant, t.amount, t.status])).toEqual([
      ["Amazon", -1499, "posted"],
      ["Amazon", -1999, "pending"],
    ]);
    const pay = idsWhere((f) => f.payment);
    expect(pay.map((t) => [t.merchant, t.amount, flags.get(t.id)!.refund])).toEqual([["Payment received", -18000, false]]);
  });

  it("ordinary charges have no flags", () => {
    const greggs = txns.find((t) => t.merchant === "Greggs")!;
    expect(flags.get(greggs.id)).toEqual({ pending: false, refund: false, payment: false, possibleDuplicate: false, priceChange: null });
  });
});
