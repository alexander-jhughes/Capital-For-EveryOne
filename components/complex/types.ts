// TEMP: replace with import from @/lib/types once Stage 1 is on main.
// Every other file in components/complex imports types only from here,
// so the swap is a one line change.

export type Transaction = {
  id: string
  /** ISO 8601 timestamp. */
  date: string
  merchant: string
  /** Integer pence. Positive is spend, negative is a refund. */
  amountPence: number
  category: string
  pending: boolean
}

export type Account = {
  balancePence: number
  limitPence: number
  /** Annual percentage rate as a percentage, for example 24.9. */
  apr: number
  /** ISO 8601 timestamp. */
  dueDate: string
  minimumPaymentPence: number
}
