# Capital For EveryOne

A WHACK 2026 prototype for Capital One's "Make Credit Accessible" challenge: one credit card account, two ways to see it.

**Simple mode removes the interface, not the information.** The **Dial** (top-right of every screen) switches between Simple view and Complex view over the same account. Anything the dense screen shows, the assistant can tell you in a sentence. **Spend Pause** is a check-in you set for yourself. It steps in *before* a purchase you've said you want to think twice about.

- Support is offered, never guessed. You choose the view, and Spend Pause is off until you turn it on.
- The AI never does maths. Every figure comes from a tested, deterministic finance layer (`lib/finance`).
- Works fully offline, with no API key.

## Tell Dial what's hard

People rarely say "set contrast to high". They say **"I have trouble seeing at night"**, "my hands shake", "I'm
dyslexic", "u talk 2 fast". Dial understands that by meaning, on the phone, and offers the changes that help, each with
a reason, before anything is kept.

- **On-device AI.** A small sentence-embedding model (all-MiniLM-L6-v2, 8-bit, 23 MB, served from `public/models`) runs
  in the browser with Transformers.js. It compares what the person said with example sentences for 16 situations
  (`lib/access/catalogue.ts`): night vision, low vision, screen reader, colour vision, reading, tremor, one hand,
  sunlight, migraine, focus, memory, money anxiety, hearing, speech speed, second language and unclear speech. Health
  details never leave the phone and are never stored: only the settings the person keeps.
- **When it applies.** "At night" makes a night look that switches on by itself from 7pm to 7am; "on the bus" is just
  for now; anything else is saved.
- **Safe by design.** The AI only names a situation; fixed, tested code decides the changes. Commands and money
  questions go to the precise rules first, so "I can't see my refund" is never turned into a display change.
- **Measured.** On a blind test set: **88% of described situations recognised exactly** (old keyword rules: 15%),
  **0 money questions or commands hijacked** (old rules: 18%). See [docs/ACCESS-EVALUATION.md](docs/ACCESS-EVALUATION.md);
  rerun with `npm run access:eval`.
- **Cloud backup.** If the on-device model isn't sure, Groq may name a situation, but only from the same list.
- **Clearer voice.** People whose speech the browser struggles with (accents, stammers, slurred or slow speech) can
  choose Groq's Whisper (`POST /api/transcribe`); each sentence is sent, transcribed and thrown away.

New settings it can use (also in Settings): easier reading, colour-safe palette, voice speed, read every reply aloud,
thumb reach, ignore accidental double taps, vibration, and the night look. Demo the night look at any time of day with
`/account?hour=21`.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
```

The app works fully without an API key. To add AI-phrased answers, see below.

## Ask Dial backend

`POST /api/ask` takes `{ "question": "..." }` and returns `{ answer, evidenceIds, source }`. The AI runs on [Groq](https://console.groq.com)'s free tier (Llama 3.3 70B by default, OpenAI-compatible API), on the server only.

The finance layer works out every figure. Groq only turns the verified facts into a sentence. Every reply is checked on the server before it is used, and evidence IDs always come from the facts.

### What it can answer

- **Spending, bills and subscriptions:** the 8 intents from the facts layer.
- **One shop:** "What did I spend on Argos?" or "Show me my Amazon transactions." Other businesses that share a name, such as Tesco Mobile, are not matched.
- **Refunds:** "Did I get my Amazon refund?" Each refund is reported as pending or completed, with the purchase it reverses, and a pending refund is never described as arrived.
- **Each figure is checked against what it belongs to.** Every amount in a reply has to match the shop, date, meaning and status of its fact, not just appear somewhere in the data (`lib/ai/claims.ts`).
- **Balances:** the current balance, statement balance and minimum payment are kept separate. "How much do I owe?" always uses a fixed template built from the facts, so that it explains all three.

### Set up Groq

1. Create a free key at [console.groq.com/keys](https://console.groq.com/keys). No card is needed.
2. Run `cp .env.example .env.local`.
3. Set `GROQ_API_KEY` in `.env.local`. This file is ignored by Git, so never commit it, and never give the variable a `NEXT_PUBLIC_` prefix.
4. Optionally set `GROQ_MODEL`. The default is `llama-3.3-70b-versatile`, with `openai/gpt-oss-20b` and `llama-3.1-8b-instant` as backups when one is rate limited.

### Test it

```bash
npm run lint
npm run typecheck
npm test                                # unit tests, mocked Groq
npm run build && npm run test:http      # production build against a fake Groq API, no key or network needed
npm run dev                             # then, in a second terminal:
npm run test:ask                        # 10 questions against the running server; real API calls if a key is set
```

### When Groq is unavailable

| Situation | What happens |
|---|---|
| The 4 core demo questions | Always a fixed answer (`source: "cache"`), with no API call |
| No key, invalid key, quota or rate limit, API error, or more than 4 seconds | A template sentence built from the same verified facts (`source: "template"`) |
| Malformed, empty or blocked reply | Template sentence |
| Reply with a figure, date or name not in the facts, the wrong balance, or advice | Rejected, then a template sentence |
| "How much do I owe?" | Always a template sentence built from the facts, with no API call |
| More than 20 Groq calls a minute from one visitor | Template sentence, with no error |
| A question the facts can't answer | "I can't tell that from your transactions." with no evidence |

The figures and evidence stay the same in every case. Only the wording changes.

## Stack

Next.js 15 (App Router), TypeScript, Tailwind CSS v4, shadcn/ui on Radix, Vitest. No database, no auth: seeded data and a fixed demo date (Sun 8 Nov 2026).

## Inspiration

Spend Pause is inspired by [ShopperONE](https://github.com/Nicholas-Lin/shopperONE), a Chrome extension that won Capital One's SES Hackathon in 2020 by warning Amazon shoppers about items over their budget. No code was copied.

The difference: ShopperONE lived inside one shop's web page. Capital For EveryOne moves the pause to the card itself, so in principle it works wherever you shop, and makes it accessible in both Simple and Complex view.
