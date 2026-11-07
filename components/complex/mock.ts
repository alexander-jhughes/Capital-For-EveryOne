// TEMP: mock data for the Complex mode preview. Remove once real data from
// Stage 1 is on main. All money is integer pence.
//
// Planted for the demo:
// - txn-031 and txn-032: two identical Tesco charges in the same month
// - txn-004 and txn-029: a subscription (Spotify) whose price rose
// - txn-018: one large one-off purchase (Currys)
// - txn-037: one pending refund (ASOS)

import type { Account, Transaction } from "./types"

export const mockAccount: Account = {
  balancePence: 189_587,
  limitPence: 500_000,
  apr: 24.9,
  dueDate: "2026-11-24T12:00:00.000Z",
  minimumPaymentPence: 3_792,
}

export const mockTransactions: Transaction[] = [
  // October 2026
  { id: "txn-001", date: "2026-10-01T08:12:00.000Z", merchant: "TfL Travel Charge", amountPence: 860, category: "Transport", pending: false },
  { id: "txn-002", date: "2026-10-01T12:34:00.000Z", merchant: "Pret A Manger", amountPence: 745, category: "Eating out", pending: false },
  { id: "txn-003", date: "2026-10-02T18:05:00.000Z", merchant: "Sainsbury's", amountPence: 5_312, category: "Groceries", pending: false },
  { id: "txn-004", date: "2026-10-03T06:00:00.000Z", merchant: "Spotify", amountPence: 1_199, category: "Subscriptions", pending: false },
  { id: "txn-005", date: "2026-10-03T19:48:00.000Z", merchant: "Nando's", amountPence: 3_240, category: "Eating out", pending: false },
  { id: "txn-006", date: "2026-10-05T07:58:00.000Z", merchant: "TfL Travel Charge", amountPence: 1_020, category: "Transport", pending: false },
  { id: "txn-007", date: "2026-10-06T06:00:00.000Z", merchant: "Netflix", amountPence: 1_299, category: "Subscriptions", pending: false },
  { id: "txn-008", date: "2026-10-07T17:22:00.000Z", merchant: "Boots", amountPence: 1_875, category: "Health", pending: false },
  { id: "txn-009", date: "2026-10-08T06:00:00.000Z", merchant: "Vodafone", amountPence: 2_400, category: "Bills", pending: false },
  { id: "txn-010", date: "2026-10-09T18:41:00.000Z", merchant: "Aldi", amountPence: 3_968, category: "Groceries", pending: false },
  { id: "txn-011", date: "2026-10-10T13:15:00.000Z", merchant: "Waterstones", amountPence: 2_198, category: "Shopping", pending: false },
  { id: "txn-012", date: "2026-10-11T20:02:00.000Z", merchant: "Odeon Cinemas", amountPence: 2_580, category: "Entertainment", pending: false },
  { id: "txn-013", date: "2026-10-12T08:03:00.000Z", merchant: "Trainline", amountPence: 4_650, category: "Transport", pending: false },
  { id: "txn-014", date: "2026-10-13T12:48:00.000Z", merchant: "Greggs", amountPence: 485, category: "Eating out", pending: false },
  { id: "txn-015", date: "2026-10-14T06:00:00.000Z", merchant: "British Gas", amountPence: 8_500, category: "Bills", pending: false },
  { id: "txn-016", date: "2026-10-15T17:55:00.000Z", merchant: "Waitrose", amountPence: 6_127, category: "Groceries", pending: false },
  { id: "txn-017", date: "2026-10-16T19:30:00.000Z", merchant: "Wagamama", amountPence: 2_865, category: "Eating out", pending: false },
  { id: "txn-018", date: "2026-10-17T11:26:00.000Z", merchant: "Currys", amountPence: 89_900, category: "Shopping", pending: false },
  { id: "txn-019", date: "2026-10-19T08:09:00.000Z", merchant: "Shell", amountPence: 5_640, category: "Transport", pending: false },
  { id: "txn-020", date: "2026-10-20T18:17:00.000Z", merchant: "Lidl", amountPence: 3_421, category: "Groceries", pending: false },
  { id: "txn-021", date: "2026-10-21T14:02:00.000Z", merchant: "Amazon", amountPence: 2_799, category: "Shopping", pending: false },
  { id: "txn-022", date: "2026-10-23T09:37:00.000Z", merchant: "Amazon", amountPence: -2_799, category: "Shopping", pending: false },
  { id: "txn-023", date: "2026-10-24T20:44:00.000Z", merchant: "The Red Lion", amountPence: 3_650, category: "Eating out", pending: false },
  { id: "txn-024", date: "2026-10-26T18:29:00.000Z", merchant: "Co-op", amountPence: 2_214, category: "Groceries", pending: false },
  { id: "txn-025", date: "2026-10-28T13:11:00.000Z", merchant: "ASOS", amountPence: 6_800, category: "Shopping", pending: false },
  { id: "txn-026", date: "2026-10-30T07:52:00.000Z", merchant: "TfL Travel Charge", amountPence: 1_020, category: "Transport", pending: false },

  // November 2026
  { id: "txn-027", date: "2026-11-01T11:18:00.000Z", merchant: "Costa Coffee", amountPence: 640, category: "Eating out", pending: false },
  { id: "txn-028", date: "2026-11-02T08:04:00.000Z", merchant: "TfL Travel Charge", amountPence: 1_020, category: "Transport", pending: false },
  { id: "txn-029", date: "2026-11-03T06:00:00.000Z", merchant: "Spotify", amountPence: 1_299, category: "Subscriptions", pending: false },
  { id: "txn-030", date: "2026-11-03T12:27:00.000Z", merchant: "Pret A Manger", amountPence: 815, category: "Eating out", pending: false },
  { id: "txn-031", date: "2026-11-03T18:36:00.000Z", merchant: "Tesco", amountPence: 4_783, category: "Groceries", pending: false },
  { id: "txn-032", date: "2026-11-03T18:37:00.000Z", merchant: "Tesco", amountPence: 4_783, category: "Groceries", pending: false },
  { id: "txn-033", date: "2026-11-04T06:00:00.000Z", merchant: "Vodafone", amountPence: 2_400, category: "Bills", pending: false },
  { id: "txn-034", date: "2026-11-04T19:52:00.000Z", merchant: "Dishoom", amountPence: 5_460, category: "Eating out", pending: false },
  { id: "txn-035", date: "2026-11-05T06:00:00.000Z", merchant: "Netflix", amountPence: 1_299, category: "Subscriptions", pending: false },
  { id: "txn-036", date: "2026-11-05T17:43:00.000Z", merchant: "Boots", amountPence: 1_245, category: "Health", pending: false },
  { id: "txn-037", date: "2026-11-05T21:10:00.000Z", merchant: "ASOS", amountPence: -6_800, category: "Shopping", pending: true },
  { id: "txn-038", date: "2026-11-06T08:15:00.000Z", merchant: "Trainline", amountPence: 3_875, category: "Transport", pending: false },
  { id: "txn-039", date: "2026-11-06T13:02:00.000Z", merchant: "Sainsbury's", amountPence: 2_968, category: "Groceries", pending: true },
  { id: "txn-040", date: "2026-11-06T19:21:00.000Z", merchant: "Vue Cinemas", amountPence: 2_150, category: "Entertainment", pending: true },
]

/** The two planted Tesco charges, for trying out highlightIds. */
export const mockDuplicateIds = ["txn-031", "txn-032"]
