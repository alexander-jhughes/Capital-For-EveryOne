# Integration checklist

Owner of this file: frontend lead (Zain). Update it when a stage changes state. Last updated with Stage 5.

| Stage | Owner | State | Branch / PR | Depends on |
|---|---|---|---|---|
| 1 Foundation + 1b shell | Zain | Merged | PR #1 | - |
| 2 Seed + facts | Zain | Merged | PR #2 | 1 |
| 3 AI backend (`POST /api/ask`) | Alexander | In review | `feat/stage-3-ai-backend`, PR #4 | 2 |
| 4 Complex mode | Zain | Merged | PR #3 | 2 |
| 5 Simple mode + Ask Dial | Zain | In review | `feat/stage-5-simple-mode` | 2, 4; uses 3 when merged |
| 6A Pay | Pay developer | Not started on GitHub | - | 1, account-state contract below |
| 6B Spend Pause + shop + pause flow | Spend Pause developer | Not started on GitHub | - | 1, 2, account-state contract below |
| 7 Onboarding + PWA | Unassigned | Not started | - | 5 |
| 8 Demo + QA | Zain | Not started | - | all |

## Merge order

1. Stage 5 and Stage 3 in either order. They share no files. Stage 5 works without Stage 3 (facts fallback) and uses it automatically once merged.
2. Stage 6A and 6B after the account-state contract below is agreed. Whoever merges second rebases on the first.
3. Stage 7, then Stage 8.

## Contracts already in force

- **Assistant (Stage 3 <-> Stage 5):** `POST /api/ask` with `{ question?: string }` returns `AskResponse { answer, evidenceIds, source: "model" | "template" | "cache" }` (200) or `{ error }` (400 friendly message, 500). `evidenceIds` are always copied from `buildFacts(...).evidenceIds`. The frontend (`lib/assistant/client.ts`) accepts only that exact shape; anything else, a 404/5xx, a network error or an 8-second timeout counts as unavailable and falls back to the facts layer for the suggested questions.
- **Evidence URL:** `/account/spending?highlight=<comma-separated transaction ids>`. Works in both modes and survives a Dial switch. Unknown IDs are ignored.
- **Data:** `lib/types.ts` is frozen (new types only, after asking). Figures come from `lib/finance` (pure, tested). Demo date comes from `lib/demo-clock.ts`. Never `new Date()` for account dates.
- **Mode:** read with `useMode()`; branch content once per page with `<ModeView simple={...} complex={...} />`. Tokens do the sizing; don't add per-mode sizes.

## Proposed: account-state contract for 6A and 6B (to agree before either merges)

All account changes go through `lib/state/account-context.tsx` (shared file, owned by the frontend lead; 6A/6B add their actions there in their PRs, reviewed together). Screens never keep their own copy of the balance, transactions or settings.

```ts
// added to useAccount()
makePayment(amount: Pence, kind: Payment["kind"]): Payment   // 6A
undoPayment(id: string): void                                 // 6A, for the rest of the session
updateSettings(next: SpendPauseSettings): void                // 6B
addPendingPurchase(p: PendingPurchase): PauseDecision         // 6B, runs evaluatePurchase
resolvePurchase(id: string, outcome: "go" | "cancel"): void   // 6B; "go" adds a pending Transaction
pendingPurchase: PendingPurchase | null                       // 6B, drives the pause card/dialog
```

- **Payment effects (6A):** `currentBalance` and `statementBalance` go down by the amount (statement not below zero), `lastPayment` updates, and a `Payments` transaction (negative amount, `pending`) is added so it appears in Spending. Announce with `useAnnounce()`. Simple Home's "You owe" reads `statementBalance`, so it updates with no extra work.
- **Persistence:** payments and purchases in `sessionStorage` (session-only, Undo lasts the session); Spend Pause settings in `localStorage`. Every read and write in try/catch; the app must render from the seed if storage is unavailable. Stage 8's `?demo=reset` clears both.
- **Pause explanation (6B):** build it from `buildFacts("spend_pause", { ...ctx, purchase })` in the browser (the facts layer is pure). The backend route uses seed data only, so it can't see a pending purchase.
- **Pause UI placement (6B):** the pause card/dialog must render inside the `(dial)` layout so the Dial switch, focus management and announcer apply. `/demo/shop` sits outside the Dial shell on purpose.

## File ownership

| Area | Owner | Files |
|---|---|---|
| Shell, header, Dial switch, dock, tabs | Zain | `app/(dial)/layout.tsx`, `components/{bottom-dock,tab-bar,mode-switch,mode-view,wordmark}.tsx` |
| Home, Spending (both modes) | Zain | `app/(dial)/account/page.tsx`, `app/(dial)/account/spending/*`, `components/account/*` |
| Ask Dial UI and client | Zain | `components/assistant/*`, `lib/assistant/*` |
| Assistant backend | Alexander | `app/api/ask/*`, `lib/ai/*` except `facts.ts` |
| Facts layer | Zain (shared with Alexander) | `lib/ai/facts.ts` |
| Pay | 6A | `app/(dial)/account/pay/*`, `components/pay/*` |
| Spend Pause, shop, pause flow | 6B | `app/(dial)/account/spend-pause/*`, `components/spend-pause/*`, `app/demo/shop/*`, `components/pause-flow/*` |
| Shared state | Zain reviews; 6A/6B add actions | `lib/state/account-context.tsx` |
| Finance | Shared, additive only, with tests | `lib/finance/*` |

## Open issues

- **Facts evidence for "What did I spend this month?" includes October rows** (the "same days last month" comparison fact contributes its own IDs; 30 IDs in total). The UI shows the first three and a "Show all" link, so nothing breaks, but the full list mixes months. Fix belongs in `lib/ai/facts.ts`; agree with Alexander first because his tests may assert evidence counts.
- Stage 3 route answers from seed data only, so answers won't reflect Stage 6 payments or settings until the route accepts client state (needs a contract change; agree with Alexander).
