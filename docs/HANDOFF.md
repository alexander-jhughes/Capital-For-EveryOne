# Capital for Everyone: hand-off for the two-person split

Branch: `claude/serene-rubin-2badwa` (not merged into `main`, no pull request yet).
Everything below is on that branch. Start from it.

## What the app is

A credit card app prototype for Capital One's "Make Credit Accessible" challenge. One account, two views (Simple and
Detailed). **Dial** is the assistant: you type or talk to it, it answers questions about the account, takes you to
screens, shows charts, runs what-if sums, and changes how the app looks.

The rule everything follows: **figures come from deterministic code. Gemini only understands requests and words
answers. It never calculates, and every figure it writes is checked against the account.**

## Run it

```bash
git fetch origin
git checkout claude/serene-rubin-2badwa
npm install
cp .env.example .env.local     # then put your key in it (never commit it)
npm run build && npm start     # http://localhost:3000, use Chrome
```

`.env.local`:

```
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.5-flash-lite
# optional, tried when the main model is rate limited (each model has its own quota):
# GEMINI_FALLBACK_MODELS=gemini-3.1-flash-lite,gemini-3-flash-preview
```

Without a key the app still works (fixed answers from the account figures, no Gemini).

Checks: `npm test` (about 7,000 unit tests), `npm run typecheck`, `npm run lint`. Browser scripts are in `scripts/`.
Delete any `.claude/worktrees` folder if you have one, or the test runner picks up duplicate tests.

## Where things are

| Area | Files |
|---|---|
| Money logic (deterministic) | `lib/finance`, `lib/insights`, `lib/payments`, `lib/spend-pause`, `lib/types.ts` (frozen shapes) |
| Demo data | `lib/data/seed.ts`, fixed demo date 8 Nov 2026 in `lib/demo-clock.ts` |
| Gemini answers (`POST /api/ask`) | `lib/ai/*` (Alex's backend): intent, facts, wording, guard, templates |
| Gemini commands (`POST /api/dial`) | `lib/ai/command-model.ts`, `command-handler.ts` |
| Model fallback and rate limits | `lib/ai/model-chain.ts`, `lib/ai/rate-limit.ts` |
| Request planning (rules first) | `lib/dial/plan.ts`, `entities.ts`, `segment.ts`, `registry.ts` (the allowed actions and routes) |
| Running steps safely | `lib/dial/runner.ts`, `components/dial/session.tsx` |
| Charts, what-if, goals | `lib/dial/visuals.ts`, `what-if.ts`, `lib/goals/*` |
| Voice | `lib/voice/engine.ts`, `use-voice-engine.ts`, `components/dial/use-dial-voice.ts` |
| Dial panel | `components/voice/voice-mode.tsx`, `components/assistant/ask-dial.tsx`, `components/dial/dial-reply.tsx` |
| Display preferences | `lib/preferences/*` (one store for text size, contrast, layout, voice settings) |
| ML personalisation | `lib/personalisation/*`, `docs/ml-personalisation/*` (random forest, on device, needs consent) |
| Screens and styling | `app/(dial)/*`, `components/*`, `app/globals.css` |

More detail: `docs/ARCHITECTURE.md`, `docs/AI-UI-CONTRACT.md`, `docs/INTEGRATION.md`.

## How a request flows

```
typed text or speech
  -> plan()            on the device, deterministic (lib/dial/plan.ts)
  -> steps             only from the allowed list in lib/dial/types.ts, each checked by validateStep()
  -> runStep()         trusted app code: navigate, preview a display change, show a chart, run a what-if
  -> money questions   POST /api/ask  -> facts from lib/finance -> Gemini words it -> guard checks every figure
  -> requests the rules can't read   POST /api/dial -> Gemini picks from the allowed actions -> validated again
```

Display changes and goals are previewed and need "Keep it". Gemini cannot pay, change Spend Pause or open any
screen that isn't in the registry.

## Split of work

### Friend: AI and UI

Start here (all of this works today, it needs hardening and polish):

1. **Test the voice on a real microphone.** It has only been tested with a fake speech recogniser. Check Chrome's
   permission prompt, live words, pauses, "actually..." corrections, and talking over Dial to interrupt.
2. **Tune Gemini.** Prompts are in `lib/ai/model.ts` (answers) and `lib/ai/command-model.ts` (commands). Add more
   question types (they must come from verified facts: add them in `lib/ai/answer-facts.ts`, `intent.ts`,
   `templates.ts`, `claims.ts`, and a test for each). Only 8 of 10 test questions are worded by Gemini today, the
   other two are refused on purpose (advice and off-topic).
3. **The key has a low request limit.** Under rapid use Gemini returns 429 and the app falls back to fixed wording.
   Fallback models are in place, the reply says when Gemini is busy. A quota or billing increase fixes it properly.
4. **UI polish.** Capital One look is in `app/globals.css` (navy `#004977`, red `#d03027`). Check every screen at
   100%, 150%, 200% text, on a phone, in dark mode and high contrast. Known bug: on `/account/settings` the Home
   widget checkboxes show widgets as ticked that Simple view hides (`components/settings/display-settings.tsx`).
5. **Accessibility pass** with a screen reader. Every chart has a text version, keep it that way.

### You: backend, database and machine learning

There is **no database and no auth yet**. State lives in the browser (`localStorage` and cookies) and the seed.

1. **Database.** Replace the seed with stored accounts and transactions. Keep the shapes in `lib/types.ts`
   (`Account`, `Transaction`, `Payment`, `SpendPauseSettings`) and `lib/goals/store.ts` (`Goal`). Today these are
   read in `lib/state/account-context.tsx`, saved by `lib/payments/storage.ts`, `lib/spend-pause/storage.ts`,
   `lib/goals/store.ts`.
2. **Move the trust boundary to the server.** `/api/ask` currently builds its facts from the seed plus a
   `state` object the browser sends (`lib/assistant/live-state.ts`, parsed in `lib/ai/live-state.ts`). With a real
   database, `/api/ask` should read the signed-in person's data on the server and ignore anything the browser
   claims about balances. Also do this for payments: money actions must be validated and written server-side.
3. **Auth.** Per-person data and per-person rate limits (`lib/ai/rate-limit.ts` is a per-IP in-memory limit).
   Never cache one person's answers for another (`lib/dial/ask-cache.ts` is per tab, in memory only, keep it so).
4. **Machine learning.** `lib/personalisation` suggests display settings from how someone uses the app. It trains
   on synthetic data, runs on the device and is off until the person consents. It never sees money, questions or
   answers. Evaluation is in `docs/ml-personalisation/EVALUATION.md`. Retrain with `scripts/personalisation/train.ts`.
   Anything learned must still be shown as a preview that the person keeps or rejects.
5. **Backend tests.** `npm run test:http` runs the API against a fake Gemini server with no key. Add database and
   auth tests next to it.

## The contract between the two halves

Keep these stable so you can work in parallel:

- `lib/types.ts` and `lib/dial/types.ts` (the allowed steps, routes, visuals, goals). Change them together.
- `POST /api/ask` request and response: `docs/AI-UI-CONTRACT.md`. New optional fields only.
- `POST /api/dial`: body `{ text, screen: { route, mode, textSize } }`, reply `{ steps, source, busy? }`.
- The preferences store (`lib/preferences/schema.ts`) is the only place display settings live.

## Rules that must not break

- Figures are never produced by Gemini. Every amount and date in an answer is checked (`lib/ai/guard.ts`, `claims.ts`).
- Dial never makes a payment or turns Spend Pause off. It explains and links to the screen where the person confirms.
- Voice: the browser's speech service is used only after the person chooses it (a notice says speech goes to the
  browser maker). Dial never records audio. Typing always works.
- Machine learning needs consent and never sees money or conversations.
- Never commit `.env.local` or any key. The repo is public.

## Known limits

- Voice and the microphone are untested on a real device.
- Gemini rate limits on the current key (see above).
- Demo data only: 28 Sep to 8 Nov 2026. September has 3 days and November 8, so partial months are labelled.
- Rules for understanding requests are English only.
