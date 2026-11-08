# Integration checklist

Owner of this file: frontend lead (Zain). Update it when a stage changes state. Last updated with Stage 5.

| Stage | Owner | State | Branch / PR | Depends on |
|---|---|---|---|---|
| 1 Foundation + 1b shell | Zain | Merged | PR #1 | - |
| 2 Seed + facts | Zain | Merged | PR #2 | 1 |
| 3 AI backend (`POST /api/ask`) | Alexander | In review | `feat/stage-3-ai-backend`, PR #4 | 2 |
| 4 Complex mode | Zain | Merged | PR #3 | 2 |
| 5 Simple mode + Ask Dial | Zain | In review | `feat/stage-5-simple-mode` | 2, 4; uses 3 when merged |
| Redesign: Capital for Everyone identity, preferences, Dial Voice Mode | Zain | In review | `feat/redesign-voice-adaptive` (stacked on Stage 5) | 5 |
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

## Redesign architecture (feat/redesign-voice-adaptive)

Three independent layers, all on `<html>` and all read by the same component tree:

1. **View** (`data-mode`, cookie `cfe-mode`): Simple / Detailed. Unchanged internally (`simple` / `complex`); people see "Simple / Detailed".
2. **Accessibility preferences** (`data-text`, `data-contrast`, `data-spacing`, `data-motion`, `data-theme`, `data-targets`): `lib/preferences/schema.ts` (allowlisted schema, pure reducer, tests). Saved in cookie `cfe-prefs` and applied by the server, so a saved look never flashes; changes kept only for this visit live in `sessionStorage`.
3. **Personal layout** (`Preferences.layout`): which Home widgets show, which are pinned first, which is highlighted, and a calmer three-section mode. Same schema; applies to both views.

`PreferencesProvider` (`lib/preferences/provider.tsx`) is the single source of truth: preview -> accept/reject -> undo -> save -> reset.

**Dial Voice Mode** (`components/voice/voice-mode.tsx`): speech (Web Speech API, en-GB, only after a tap) -> `lib/voice/interpret.ts` (deterministic, local, 70+ phrasing tests) -> one of: allowlisted interface actions (previewed, then confirmed), a view switch (offered), navigation, a control command, or a money question passed unchanged to `POST /api/ask` (Stage 3 contract, facts fallback when unavailable). No AI decides interface changes; nothing in this path can touch payments or account data.

### Decisions that affect other workstreams

- **Pay (6A) and Spend Pause (6B):** build with the new tokens in `app/globals.css` (`bg-primary`, `bg-card`, `elevated`, `hairline`, `text-muted-foreground`, `bg-attention-surface`, `--target-min`, `--space`) and the shared `Money` and `FlagBadges` components. Never set font sizes in px; use `text-sm/base/lg/xl` so text-size preferences work. The token sheet is on the concept board.
- **Alexander (Stage 3):** no contract change. Voice Mode sends money questions to `/api/ask` exactly as the Ask sheet does; interface commands never reach the backend.
- **Navigation:** the bottom dock and Ask bar are replaced by one `AppNav` (phone tab bar with a raised Dial button, desktop side rail). Ask Dial opens from the Dial button; Voice Mode from "Talk to Dial".
- **New route:** `/account/settings` (Display and voice).

## `experience` field on `POST /api/ask` (frontend side, `feat/hackathon-adaptive-ui`)

The frontend now reads an **optional** `experience` field next to `answer`, `evidenceIds` and `source`. Nothing in `app/api`, `lib/ai` or `lib/types` was changed; the parser lives in `lib/assistant/experience.ts`.

```json
{ "answer": "...", "evidenceIds": ["t051", "t052"], "source": "model",
  "experience": { "template": "transaction", "intent": "transaction_investigation" } }
```

| template | intent | card shows (all figures from `lib/finance`, never from the model) |
|---|---|---|
| `statement` | `statement_balance` | current and statement balance, minimum, due date, evidence transactions |
| `spending` | `spending_insights` | month-to-date total, comparison with same days last month, categories, top shops |
| `subscriptions` | `subscription_query` | each subscription, current price, previous price and change |
| `transaction` | `transaction_investigation` | the `evidenceIds` transactions: shop, amount, date, status, refund, possible duplicate |
| `payment` | `payment_planning` | due date, statement balance, minimum, other-amount range, minimum-only payoff estimate |
| `general` | `general` | no card (plain Dial answer) |

Rules the frontend applies:
- `template` must be one of the six strings exactly; otherwise the answer is shown as `general`. A bad `experience` never hides the answer.
- `intent` is optional; unknown values are ignored (the template still applies).
- Extra fields are ignored. Nothing in `experience` is executed or used to change app state.
- The `transaction` card needs `evidenceIds`; with none (or only unknown ids) it shows a "Dial didn't point to a specific transaction" state.

Backend asks: please send exactly these strings; send `evidenceIds` for `transaction` answers; leave `experience` out rather than guessing.

## Product workstream (`feat/product-ux`): changes that touch other workstreams

Everything else on this branch is in product-owned files (`components/{home,learn,goals,onboarding,settings}`, `lib/learn`,
`lib/goals`, `lib/home`, `lib/preferences`, `app/(dial)`, `app/globals.css`). These four changes reach into shared or
other owners' files, all additive. Please review them before merging.

### 1. Goal kinds added for the product workstream (Alex: `lib/dial/types.ts`; backend: `lib/server/session.ts`)

`GoalSpec` gains four kinds. The three existing kinds are unchanged, and Dial's `registry.ts` still creates only those
three (it returns `null` for the others, so nothing in Dial changes until you choose to add them).

| Kind | Shape | Measured from |
|---|---|---|
| `pay_down` | `{ target, by, startBalance }` | `account.currentBalance` |
| `utilisation` | `{ percent (1-100), by, startBalance }` | `currentBalance / creditLimit` |
| `save_up` | `{ purpose: "emergency" \| "purchase", target, by, saved, log: [date, saved][] (max 6), label? }` | the amount the person enters (the app can't see savings) |
| `pay_on_time` | `{}` | this bill's minimum vs payments made in the app |

- Validation: `sanitizeSpec` in `lib/goals/store.ts` (shared by the browser and `lib/server/account.ts`). Labels are
  plain words only, 24 characters at most.
- Session wire tags added in `lib/server/session.ts`: `d`, `u`, `s`, `t`. Old cookies decode exactly as before. Round
  trip and validation tested in `lib/goals/new-kinds.test.ts`.
- Goal titles for Dial come from `describeGoal`, which now covers every kind. Goals never reach the AI provider (Groq).

### 2. Home sections and two display preferences (Alex: voice and the command model read these)

- `WIDGETS` gains `categories`, `upcoming`, `payments` and `progress`. Detailed view shows all 11 by default; Simple
  still shows bill, insights and Spend Pause. `HOME_SECTIONS` in `lib/dial/types.ts` is **not** changed, so
  `?focus=` and Dial's "show me…" don't know the new sections yet. `lib/ai/command-model.ts` picks up the new ids
  automatically for show/hide/move/emphasise; its prompt line describing Home is unchanged.
- `Preferences` gains `charts: "show" | "hide"` and `learning: "on" | "off"`, with matching `UiAction`s. `sanitize`
  defaults old cookies to `show` and `on`.
- `scripts/test-ml-browser.mjs`: one expected count updated (Detailed Home before the preview is now 10 sections, not 6).

### 3. Demo reset (`app/demo/reset/route.ts`)

`/?demo=reset`, or "Start the demo again" on the More page, clears this visitor's `cfe-session`, `cfe-prefs` and
`cfe-mode` cookies and `cfe-*` browser storage, then turns Spend Pause back on with `RESET_SPEND_PAUSE` through the
normal `PUT /api/spend-pause`. It only touches the visitor's own cookies.

### 4. Browser suites that were already failing before this branch

On a clean copy of `c5b7a0c`, `test:pay` (16 pass, stops at "Your bill is paid"), `test:browser` (Spend Pause: 1 pass,
3 fail) and `test:stage6` (5 pass, 7 fail) fail the same way as on this branch. They seem to predate the server-side
session. Owners: 6A and 6B.

  Probable cause: those three suites start `next start` without `SESSION_SECRET`, and production refuses to sign
  sessions without one. With `SESSION_SECRET` set, `test:stage6` gets to 40 passes (3 failures) instead of 5.

### 5. Gemini replaced by Groq (ported from Mate 3's `feat/groq-adaptive-access`, commit `9e532ed`)

Asked for by the project lead on 8 Nov 2026. This touches Alex's `lib/ai` area, so please review.

- Ported as a patch of Mate 3's migration commit, not a cherry-pick. It applied cleanly because both branches start
  at `c5b7a0c`. Also ported: the warmer answer prompt from his `29e993a` (wording only; the rules are unchanged).
- Not ported: his on-device accessibility engine (`lib/access`, `1de9e33`), Groq Whisper speech-to-text (`da09593`)
  and small talk (`lib/dial/social.ts`, `29e993a`). Each is a separate feature.
- `lib/ai/groq.ts` is the only file that calls Groq: a plain `fetch` to the OpenAI-compatible endpoint, with no SDK.
  `@google/genai` was removed from `package.json`.
- Models: `llama-3.3-70b-versatile`, then `openai/gpt-oss-20b`, then `llama-3.1-8b-instant`. Overridden with
  `GROQ_MODEL` / `GROQ_FALLBACK_MODELS`; `GROQ_BASE_URL` is for the fake server in tests only.
- Contracts are unchanged: `/api/ask` and `/api/dial` take and return the same shapes. One exception: `GET /api/ask`
  now reports `{ ai: "groq", groq, model, backups }` instead of `{ gemini, model, backups }`.
- Added tests: a rate-limited main model falls back to the backup over real requests, and a bad key (Groq's 401) is
  not retried. The fake server's "invalid key" is now 401, as Groq sends, and the old 400 case is kept as "bad-request".

### 6. Needed from Alex before the demo (found driving Dial with live Groq, 8 Nov 2026)

1. **Dial can't open the Learning Lab or More.** "take me to the learning lab" gets "I can't open that", and Groq
   returns no steps because the page isn't in its list. Needed: add `/account/learn`, `/account/learn/<topic>`
   (`utilisation`, `minimum-payments`, `interest`, `statement`, `quiz`; the list is `TOPICS` in `lib/learn/topics.ts`)
   and `/account/more` to the page registry in `lib/dial/registry.ts`, and to the page line of the prompt in
   `lib/ai/command-model.ts` (line 54).
2. **"How much did I spend on groceries compared to last month?" compares October with September.** Groq returned no
   steps for this, so it came from the on-device planner (`lib/dial`). Expected: November so far against the same
   days of October, as Home's categories card shows.
3. **`HOME_SECTIONS` doesn't know `categories`, `upcoming`, `payments` or `progress`** (see section 2). "show me my
   progress" shows the budget card instead.
