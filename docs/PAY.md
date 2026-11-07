# Pay

Stage 6A. A simulated card payment. No bank, card network or real money is involved, and the screens say so.

## How it works

1. **Choose:** suggested amounts come from the live account, plus any other amount up to the current balance.
2. **Review:** the amount, the card, and the balances after. Nothing is paid yet.
3. **Confirm:** one payment is recorded, and the result is shown and announced. It can be undone for the rest of the session.

Simple and Detailed share one flow, the same state and the same figures. Detailed adds available credit, payoff estimates and an explanation of the two balances.

## Rules

Everything is in `lib/payments/rules.ts`: pure, integer pence, tested.

| Rule | Detail |
|---|---|
| Current balance | Falls by the amount paid |
| Statement balance | Falls by the amount paid, and stops at £0 |
| Minimum payment | `min(seed minimum, statement balance)`, so £25 stays after a £25 payment |
| Most you can pay | The current balance. There's no credit balance |
| Least you can pay | 1p. Below the minimum is allowed, with a warning at review |
| Due date, limit, APR | Never change |

These must stay the same as `accountAfter` in `lib/ai/live-state.ts` on the backend.

**Nothing is stored as a figure.** `account` is worked out from the seed and the events. Undo removes the event, so every figure returns without being restored by hand, and the seed is never edited.

## Payments aren't spending

A payment is a `Transaction` with category `Payments`, merchant `Payment received`, a negative amount and status `pending`. `isSpending` in `lib/finance` excludes that category from every total, so spending, categories, charts, merchants, budgets and duplicate checks don't change. This isn't a display filter: `lib/payments/payments.test.ts` checks the calculations.

There's no settlement in the demo, so a payment made here stays `pending`, and the balance updates at once.

## Repeats

Each review takes one `id`, and that id can only be paid once. The screen blocks a second tap, and `recordPayment` returns the first payment for a repeated id.

## Shared state

Added to `useAccount()` in `lib/state/account-context.tsx`:

| Addition | Purpose |
|---|---|
| `makePayment(amount, kind, id)` | Returns `{ ok: true, payment, ... }` or `{ ok: false, message }`. Differs from the proposed contract so a failure can't be mistaken for a payment, and so a repeat is safe |
| `undoPayment(id)` | Safe to repeat |
| `payments` | This session's payments, oldest first. The backend treats the last as the latest |
| `ready`, `paymentsSaved` | For the loading and can't-save states |

`Payment["kind"]` is frozen and has no value for the full balance, so that's recorded as `custom`.

**Storage:** `sessionStorage` under `cfe-payments-session`, so a refresh keeps payments and a new session starts from the seed. Everything read is checked. If any part is wrong, all of it is ignored, so a balance is never half restored. Stage 8's reset needs to clear it.

## For Dial

`lib/payments/dial.ts` answers "How much did I just pay?", "Has my payment been recorded?" and "Did my spending increase after that payment?" from live state, in the Ask sheet and Voice Mode, before `POST /api/ask` is called. Everything else goes to the backend, which needs PR #8 and the `ClientState` contract to see payments (see `docs/SPEND-PAUSE.md` on the Stage 6B branch).

## Tests

```bash
npm test                          # rules, integrity, validation, storage
npm run build && npm run test:pay # real Chrome: both modes, keyboard, axe, layouts, preferences
```

`test:pay` needs Chrome installed. It adds no project dependency.
