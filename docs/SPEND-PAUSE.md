# Spend Pause

Stage 6B. A moment to think before a big purchase, in the demo shop. The person always makes the final choice.

## What it is, and isn't

Spend Pause is a simulated check. It runs inside Dial and the made-up demo shop at `/demo/shop`. It isn't connected to a card network, so it can't stop a purchase anywhere else, and it can't change anything already bought. The screens say this. Keep it that way in any copy or demo script.

## How it works

1. The person chooses what to check: an amount, a monthly budget, quiet hours, or any mix.
2. They buy something in the demo shop. `addPendingPurchase` runs `evaluatePurchase` from `lib/finance`.
3. If a check applies, they go to `/account/spend-pause/check`. Simple shows a full-screen card, and Complex shows a dialog.
4. "Go ahead" adds a pending transaction. "Cancel it" adds nothing.

If no check applies, or Spend Pause is off, the purchase goes straight through, and the shop says so.

## Shared state

Everything lives in `useAccount()` in `lib/state/account-context.tsx`, following the contract in `docs/INTEGRATION.md`.

| Addition | Purpose |
|---|---|
| `updateSettings(next)` | Save settings |
| `addPendingPurchase(p)` | Runs `evaluatePurchase` and holds the purchase. Returns the decision |
| `resolvePurchase(id, outcome)` | `"go"` or `"cancel"`. Safe to call twice |
| `pendingPurchase` | The purchase waiting for an answer |
| `pauseHistory` | Finished purchases this session. Not in the contract: added for "Your recent choices" |
| `ready`, `settingsSaved` | Not in the contract: added for the loading and can't-save states |

State rules are pure and tested in `lib/spend-pause/state.ts`. Seed data is never edited. `account.currentBalance` is the seed balance plus approved purchases, because the check states the balance after the purchase and has to be true.

**Storage:** settings are in `localStorage` under `cfe-spend-pause-settings`, and purchases are in `sessionStorage` under `cfe-spend-pause-session`. Stage 8's reset needs to clear both. Everything read is validated, and the app runs from the demo settings if storage is blocked or damaged.

## For Dial

`lib/spend-pause/dial.ts` has no AI and no dependency on the backend. **Nothing in it changes a setting.** Dial must not call `updateSettings` to turn Spend Pause on or off.

```ts
matchSpendPauseRequest("Turn on Spend Pause.")  // "turn_on", or "status", "turn_off", "can_turn_off", "help", null
spendPauseStatus(settings)                      // A sentence for Dial to say
proposeSpendPause(settings, true)               // { href, message }, or null if it's already on
```

To turn it on or off, send the person to `proposal.href`:

- `/account/spend-pause?confirm=on` or `?confirm=off` opens the confirmation. They still have to answer it.
- The link does nothing if the change wouldn't change anything.
- If nothing is chosen yet, `proposeSpendPause` sends them to choose first.

For "Can I turn it off?", say yes, and offer the proposal. For "Help me avoid unnecessary spending", explain Spend Pause using `spendPauseStatus`, and offer it only if it's off. Never present it as blocking real purchases.

The `POST /api/ask` route answers from seed data, so it won't reflect these settings until it accepts client state. Dial screens can use `spendPauseStatus(settings)`, which reads live state.

## Tests

```bash
npm test                              # logic: state, validation, storage, Dial actions
npm run build && npm run test:browser # real Chrome: both modes, keyboard, zoom, axe
```

`test:browser` needs Chrome installed. It adds no project dependency.
