# Capital For EveryOne

A credit card app prototype built at WHACK 2026 for Capital One's "Make Credit Accessible" challenge: help customers
with accessibility needs manage their account on their own.

One account, two views. **Simple** view shows the few things that matter in plain words. **Detailed** view shows the
full account: transactions, categories, statements and payments. **Dial**, the assistant in the corner of every screen,
answers questions about the account by text or voice, takes you to the right screen, and changes how the app looks
when you tell it what you need.

The rule the whole app follows: **figures come from tested, deterministic code. The AI only understands requests and
words answers.** It never does maths, and every figure it writes is checked against the account before it is shown.

## What's in it

- **Dial, on Groq.** Ask "How much did I spend on groceries?", "Did I get my Amazon refund?" or "When is my bill
  due?". Groq (Llama 3.3 70B by default) classifies the question and phrases the answer from verified facts. If Groq
  is slow, rate limited or not configured, Dial falls back to cached or template answers built from the same facts, so
  the app works fully offline with no API key.
- **Voice.** Talk to Dial with the browser's own speech recogniser: live transcript, pause and resume, corrections
  ("no, I meant Tesco"), follow-ups, and read-aloud for any reply.
- **Accessibility engine, on the device.** Describe your situation in your own words ("I can't use a mouse", "this
  screen is overwhelming") and a small sentence model (all-MiniLM-L6-v2 via Transformers.js, running in the browser)
  works out which settings would help. Every change is previewed with a reason and kept only when you say so.
- **ML personalisation.** A random forest trained on synthetic data suggests display settings you might like (larger
  text, a calmer home screen, talking to Dial first) based on settings you have chosen. It is off until you turn it
  on, runs on the device, and only ever asks; it never changes anything by itself.
- **Profile model.** An optional "About you" page feeds a softmax model that picks one of six person types (for
  example "Building your credit" or "Staying on top when money is tight") to tailor Home and Dial's wording.
- **Similar-user insights.** A demo that compares your display choices to three synthetic sample profiles with a
  plain, explainable similarity score.
- **Spend Pause.** A check-in you set for yourself that steps in before a purchase you want to think twice about.
  Inspired by [ShopperONE](https://github.com/Nicholas-Lin/shopperONE), but on the card rather than in one shop's
  page. No code was copied.
- **Pay, Goals and the Credit Learning Lab.** Simulated card payments, goals with milestones (pay down, use less of
  the limit, pay on time, save), and calculators for utilisation, minimum payments, APR and statements.
- **Synthetic demo users.** Switch between fictional people at `/demo/users` to see the profile and personalisation
  features with different histories.

Everything runs on seeded data and a fixed demo date (Sun 8 Nov 2026). There is no database and no sign-in: each
visitor's payments, purchases and settings live in a signed session cookie.

## Run it

Requires Node 22.15 or later.

```bash
npm install
npm run dev        # http://localhost:3000
```

The app works without an API key. To turn on Groq:

1. Create a free key at [console.groq.com/keys](https://console.groq.com/keys) (no card needed).
2. `cp .env.example .env.local`
3. Set `GROQ_API_KEY` in `.env.local`. Never commit it and never give it a `NEXT_PUBLIC_` prefix.
4. Optionally set `GROQ_MODEL` (default `llama-3.3-70b-versatile`) and `GROQ_FALLBACK_MODELS`.

In production, also set `SESSION_SECRET` to a random string of at least 32 characters.

## Test it

```bash
npm run lint
npm run typecheck
npm test                              # unit tests (Groq mocked)
npm run build && npm run test:http    # production build against a fake Groq API
npm run test:ask                      # questions against a running dev server; real Groq calls if a key is set
npm run access:eval                   # accuracy of the on-device accessibility model
```

There are also Playwright browser checks for each area (`test:product`, `test:voice`, `test:access`, `test:pay`,
`test:demo-users` and others in `package.json`). Each one expects a running server.

To retrain the ML personalisation model and check the committed one matches:

```bash
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/personalisation/train.ts --check
```

## How a question is answered

```
typed or spoken text
   │
   ├─ on-device rules and the accessibility engine   display changes: preview, then "Keep it"
   ├─ Pay and Spend Pause                            answered from live account state
   └─ POST /api/ask
        interpret the intent (rules first, Groq only to classify)
        → facts from lib/finance and lib/insights
        → Groq words the answer
        → validator checks every figure, date and name against its fact
        → otherwise a template sentence from the same facts
```

Anything with money consequences, like a payment or turning Spend Pause off, is never done by Dial. Dial explains
and links to the screen where you confirm it.

## Project layout

| Path | What |
|---|---|
| `app/` | Next.js routes: the account screens under `(dial)/account`, API routes under `api/`, demo pages under `demo/` |
| `components/` | UI, including `dial/` (assistant panel), `voice/`, `home/`, `learn/`, `goals/` |
| `lib/finance`, `lib/insights` | Deterministic figures and evidence-backed observations |
| `lib/ai` | Groq client, intent matching, facts, answer validation, templates and fallbacks |
| `lib/dial`, `lib/voice` | Dial's planner and runner, and the speech engine |
| `lib/access` | On-device accessibility engine |
| `lib/personalisation` | ML display suggestions (random forest) |
| `lib/profile` | Person-type profile model |
| `lib/server` | Signed session cookie, account and profile storage |
| `docs/` | Design notes and evaluations, listed below |

## Docs

- [Architecture](docs/ARCHITECTURE.md) and [AI and backend](docs/BACKEND-AI.md)
- [`/api/ask` contract](docs/AI-UI-CONTRACT.md) and [account backend](docs/BACKEND.md)
- [Accessibility engine](docs/ACCESSIBILITY-ENGINE.md) and its [evaluation](docs/ACCESS-EVALUATION.md)
- [ML personalisation](docs/ml-personalisation/README.md) and [profile model](docs/profile-model/README.md)
- [Voice testing](docs/VOICE-TESTING.md), [Pay](docs/PAY.md), [Spend Pause](docs/SPEND-PAUSE.md), [Product screens](docs/PRODUCT.md)

## Limitations

This is a hackathon prototype. Both ML models are trained on synthetic data only and have not been validated with
real people. Voice has been tested with a simulated recogniser, not a real microphone across devices. All account
data is made up.

## Stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v4, shadcn/ui on Base UI, Transformers.js, Vitest and
Playwright. AI by Groq (OpenAI-compatible API, server side only).

## Team

Built at WHACK 2026 by Alexander Hughes, Zain Kashif, Samrath Arora and Sam (@Sam151811).
