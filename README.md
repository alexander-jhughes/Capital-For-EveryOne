# Capital For EveryOne

A WHACK 2026 prototype for Capital One's "Make Credit Accessible" challenge: one credit card account, two ways to see it.

**Simple mode removes the interface, not the information.** The **Dial** (top-right of every screen) switches between Simple view and Complex view over the same account. Anything the dense screen shows, the assistant can tell you in a sentence. **Spend Pause** is a check-in you set for yourself. It steps in *before* a purchase you've said you want to think twice about.

- Support is offered, never guessed. You choose the view, and Spend Pause is off until you turn it on.
- The AI never does maths. Every figure comes from a tested, deterministic finance layer (`lib/finance`).
- Works fully offline, with no API key.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
```

The app works fully without an API key. To add AI-phrased answers, see below.

## Ask Dial backend

`POST /api/ask` takes `{ "question": "..." }` and returns `{ answer, evidenceIds, source }`. Google Gemini is the only AI provider, and it runs on the server only.

The finance layer works out every figure. Gemini only turns the verified facts into a sentence. Every reply is checked on the server before it is used, and evidence IDs always come from the facts.

### What it can answer

- **Spending, bills and subscriptions:** the 8 intents from the facts layer.
- **One shop:** "What did I spend on Argos?" or "Show me my Amazon transactions." Other businesses that share a name, such as Tesco Mobile, are not matched.
- **Refunds:** "Did I get my Amazon refund?" Each refund is reported as pending or completed, with the purchase it reverses, and a pending refund is never described as arrived.
- **Balances:** the current balance, statement balance and minimum payment are kept separate. "How much do I owe?" always uses a fixed template built from the facts, so that it explains all three.

### Set up Gemini

1. Create a key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Run `cp .env.example .env.local`.
3. Set `GEMINI_API_KEY` in `.env.local`. This file is ignored by Git, so never commit it, and never give the variable a `NEXT_PUBLIC_` prefix.
4. Optionally set `GEMINI_MODEL`. The default is `gemini-3.5-flash-lite`.

### Test it

```bash
npm run lint
npm run typecheck
npm test                                # unit tests, mocked Gemini
npm run build && npm run test:http      # production build against a fake Gemini API, no key or network needed
npm run dev                             # then, in a second terminal:
npm run test:ask                        # 10 questions against the running server; real API calls if a key is set
```

### When Gemini is unavailable

| Situation | What happens |
|---|---|
| The 4 core demo questions | Always a fixed answer (`source: "cache"`), with no API call |
| No key, invalid key, quota or rate limit, API error, or more than 4 seconds | A template sentence built from the same verified facts (`source: "template"`) |
| Malformed, empty or blocked reply | Template sentence |
| Reply with a figure, date or name not in the facts, the wrong balance, or advice | Rejected, then a template sentence |
| "How much do I owe?" | Always a template sentence built from the facts, with no API call |
| A question the facts can't answer | "I can't tell that from your transactions." with no evidence |

The figures and evidence stay the same in every case. Only the wording changes.

## Stack

Next.js 15 (App Router), TypeScript, Tailwind CSS v4, shadcn/ui on Radix, Vitest. No database, no auth: seeded data and a fixed demo date (Sun 8 Nov 2026).

## Inspiration

Spend Pause is inspired by [ShopperONE](https://github.com/Nicholas-Lin/shopperONE), a Chrome extension that won Capital One's SES Hackathon in 2020 by warning Amazon shoppers about items over their budget. No code was copied.

The difference: ShopperONE lived inside one shop's web page. Capital For EveryOne moves the pause to the card itself, so in principle it works wherever you shop, and makes it accessible in both Simple and Complex view.
