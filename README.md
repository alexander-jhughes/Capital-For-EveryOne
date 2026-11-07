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
npm test           # finance unit tests
```

Optional: copy `.env.example` to `.env.local` and add `ANTHROPIC_API_KEY` for AI-phrased answers. Without it, the app uses cached and template answers.

## Stack

Next.js 15 (App Router), TypeScript, Tailwind CSS v4, shadcn/ui on Radix, Vitest. No database, no auth: seeded data and a fixed demo date (Sun 8 Nov 2026).

## Inspiration

Spend Pause is inspired by [ShopperONE](https://github.com/Nicholas-Lin/shopperONE), a Chrome extension that won Capital One's SES Hackathon in 2020 by warning Amazon shoppers about items over their budget. No code was copied.

The difference: ShopperONE lived inside one shop's web page. Capital For EveryOne moves the pause to the card itself, so in principle it works wherever you shop, and makes it accessible in both Simple and Complex view.
