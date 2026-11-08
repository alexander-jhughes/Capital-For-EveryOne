# Dial: master build prompt v2 (mobile app edition)

This is the authoritative brief. It supersedes the v1 "Capital For EveryOne" prompt.

We are building **Dial**, a hackathon prototype for Capital One's WHACK challenge: "Make Credit Accessible. Help customers with accessibility requirements independently manage their account." Judged in a strict 3-minute live demo by two Capital One software engineers. Dial is a **mobile-first installable web app** (add to home screen, runs standalone) for one credit card account, with two interface modes, Simple and Complex, from one component tree.

## Status

- Phase 1 (foundation) and Stage 1b (v2 alignment: Dial shell, cookie-only mode, Base UI) are merged into `main` (PR #1).
- Stage 2 (seed additions, `findPriceChanges` / `monthOverMonth` / `daysUntilDue` / `budgetStatus`, `lib/ai/facts.ts`, contract types) is merged into `main` (PR #2).
- Stage 4 (Complex Home and Spending, `flagTransactions`, account context, `?highlight=` evidence hook) is merged into `main` (PR #3). It reuses Alexander's TransactionTable and four Base UI components from `origin/complex-mode`, adapted to `lib/`; that branch itself is untouched.
- Redesign (Capital for Everyone identity, accessibility preferences, personal layout, Dial Voice Mode) is on `feat/redesign-voice-adaptive`, in review. See `docs/INTEGRATION.md`.
- Stage 5 (Simple Home and Spending, Ask Dial sheet with voice and read-aloud, evidence links) is on `feat/stage-5-simple-mode`, in review. Integration status and contracts for every stage: `docs/INTEGRATION.md`.
- Stage 5 hand-off: the assistant links to `/account/spending?highlight=<AskResponse.evidenceIds joined by commas>` to highlight evidence rows in Complex mode.
- Stage 3 (AI backend: `POST /api/ask`, intent matching, model call, output guard, demo cache, `scripts/test-ask.ts`) is in review. `npm run test:ask` runs the 10 questions against a running server.

## Team split

- **Alexander:** Stage 3 (AI backend): `app/api/ask/route.ts`, intent matching, model call, number guard, cache, `scripts/test-ask.ts`.
- **Zain:** all other stages. Contract between the two: `AskResponse` in `lib/types.ts` and `buildFacts` in `lib/ai/facts.ts` (Stage 2).

## Thesis

"Simple mode removes the interface, not the information. Everything the dense screen told you, the assistant will tell you in a sentence." Every task possible in Complex mode is possible in Simple mode: check what's owed, understand spending, spot problems, pay the bill, set and respond to Spend Pause.

## Rules

- **Do not rewrite lib/types.ts.** Add new types alongside (e.g. `AskResponse`) and ask before changing an existing one. Keep all existing tests passing. Add tests for anything new in lib/finance.
- One component tree, two token sets, switched by `data-mode` on `<html>`. Only use a mode conditional where content genuinely differs, and keep each in one place.
- **The mode cookie is the single source of truth.** localStorage only for Spend Pause settings and session state, always in try/catch, and the app must render correctly without it.
- **Support is offered, never guessed.** The mode choice on first run happens before sign-in, with live previews. Spend Pause is off until the user enables it (the demo reset can pre-enable it). Never infer needs from behaviour.
- The Dial switch sits in the same fixed position in both modes (top-right of the header), always reachable.
- **Mobile first:** designed at 390px wide, fine on desktop (centred phone-width column with comfortable margins). Respect safe-area insets (`env(safe-area-inset-*)`).
- Accessibility is structural: semantic HTML, labels, visible focus, full keyboard operation, aria-live for assistant answers and confirmations, contrast at 7:1, 64px targets in Simple, no time limits, respect `prefers-reduced-motion`, reflow at 400% zoom.
- **Brand:** "Dial", with its own simple text wordmark and one accent colour. No Capital One logos, swoosh or name in the UI. The card is shown as "Credit card ending 4417".
- **The AI never does arithmetic or picks evidence by itself.** lib/finance computes every total, count, date and evidence row. The model only phrases sentences.
- No emojis in the UI. Plain English, no jargon in Simple mode (explain "APR" if it appears).

## App shell (mobile)

- Top: header with Dial wordmark (left) and the Dial mode switch (right).
- Bottom: a tab bar with Home, Spending, Pay, Pause. Real links, a current-page indicator with text and shape (not colour alone), and 64px targets in Simple.
- Assistant: a docked "Ask Dial" bar above the tab bar that expands into a bottom sheet (focus moves into the sheet, Escape closes it, focus returns afterwards). Available in both modes. In Simple mode it's the main way to get detail.
- Page transitions are subtle and disabled under reduced motion.

## Stages

Work on a branch per stage (`feat/stage-N-name`). At the end of each stage, run lint, type-check, tests and `next build`, give a commit message, and stop. Merges to main deploy on Vercel.

**Stage 2: Seed additions + facts layer**
- Add to the seed WITHOUT changing the planted Tesco duplicate (£38.62 on 5 and 6 Nov), the statement balance (£486.20), the minimum (£25), the due date (Fri 13 Nov) or November spend (£402.35). Add: a subscription whose price rose (e.g. a streaming service £10.99 in October → £12.99 in November, offset elsewhere so the November total stays £402.35), one large one-off purchase in October, and one pending refund. Extend the history to two months if needed. Update tests accordingly.
- lib/finance additions: `findPriceChanges(txns)` (same merchant, recurring, amount changed), `monthOverMonth(txns, today)`, `daysUntilDue`.
- lib/ai/facts.ts: builds a facts object per intent (spend this/last month, top 3 items, duplicate candidates, price changes, days until due, minimum payment, Spend Pause decision). Each fact carries the transaction IDs that support it.

**Stage 3: AI backend** (Alexander)
- New type `AskResponse { answer, evidenceIds, source: 'model' | 'template' | 'cache' }`.
- `POST /api/ask` with an optional question. No question → default spending summary.
- Flow: question → intent (keyword match first; fall back to the model only to CLASSIFY intent from a fixed list) → facts + their evidence IDs → model phrases at most two plain sentences, using only numbers in the facts, and says "I can't tell that from your transactions" when facts don't cover it. No financial advice.
- `evidenceIds` come from the facts, never from the model. If the model's reply contains any amount or date not in the facts, use the template sentence instead.
- Use a fast Gemini model via `GEMINI_MODEL`, with Gemini as the only AI provider. (Superseded on 8 Nov 2026: Groq replaced Gemini; see README "Set up Groq".) 4-second timeout. Hard-coded cache for the demo questions ("Did I pay Tesco twice this month?", "What did I spend this month?", "Has any subscription gone up?", "When is my bill due?") used ahead of the model so the live demo can't vary, with `source: 'cache'`.
- `scripts/test-ask.ts`: runs 10 questions (including 2 the data can't answer) and prints answer, source and evidence.

**Stage 4: Complex mode**
- Home: balance, limit, available credit, APR, statement vs current balance, minimum and due date, month-to-date spend vs budget, a simple accessible spending chart (with a text/table alternative), and recent transactions.
- Spending: full transaction table (semantic `<table>` in a horizontally scrolling container on mobile, or a card list at 390px with the same data and a sort/filter toolbar), sortable, searchable, filterable by category, with pending items, possible duplicates and price changes flagged with text + icon.

**Stage 5: Simple mode** (same components via data-mode)
- Home: "You owe £486.20. Due Friday 13 November." in large type, ONE primary button "Pay my bill", the Spend Pause status line.
- Spending: one assistant sentence + the three biggest items. No table.
- Assistant sheet: suggested question chips first, a text box, voice input via the Web Speech API, read-aloud via `speechSynthesis` (en-GB voice preferred, never auto-play). Feature-detect each and hide unsupported controls cleanly.
- **Evidence:** when an answer has `evidenceIds`, show those transactions as a small evidence list under the answer (Simple), or highlight those exact rows in the table and scroll to them (Complex). This is the moment where "same answer, both modes" becomes visible, so make it obvious.

**Stage 6: Pay + Spend Pause**
- Pay. Complex: minimum / statement / custom options with a payoff estimate for each. Simple: one card per step ("Pay £486.20, your full bill?" → confirm → done). Both: confirm step, aria-live success, the balance updates, Undo for the rest of the session.
- Spend Pause (inspired by ShopperONE, Capital One SES Hackathon 2020; credit it in the README; don't copy its code). Settings: threshold presets £50/£100/£200/Other, optional monthly budget, optional quiet hours. Simple asks one question per screen; Complex uses one form.
- `/demo/shop`: a clearly fictional shop (invented name, no real brands) with "Wireless headphones £120" and a "Buy" button that creates a pending purchase.
- Pause flow: `evaluatePurchase` decides. Simple shows a full-screen card ("Quick check. This £120 purchase is over the £100 you asked us to check, and would take you £22.35 over your monthly budget.") with large "Go ahead" / "Cancel it" buttons and Read aloud. Complex shows an alert dialog with merchant, amount, reasons, balance after, available credit after and budget remaining. No countdowns, no alarm-red-only styling, no shaming copy. The outcome is announced and appears in transactions.

**Stage 7: Onboarding + app install**
- First run: "How would you like Dial to look?" Two live previews rendering real scaled-down components, then a fake sign-in whose button goes to Home.
- PWA: `app/manifest.ts` (name "Dial", short_name "Dial", display standalone, theme and background colours, icons 192/512 + maskable in public/), viewport meta with `viewport-fit=cover`, apple-touch-icon, iOS standalone meta tags. No service worker needed.
- `/compare`: both modes side by side on the same account at phone width (the Devpost cover image).

**Stage 8: Demo + quality**
- Hidden Reset demo (`?demo=reset`) that clears the mode cookie, localStorage and session state, and restores the seed and configured Spend Pause state.
- Loading skeletons, empty and error states.
- Add `@axe-core/react` in dev only and fix every issue. Walk the full demo path keyboard-only. Check 400% zoom and dark mode. If a web app testing skill is available, script the demo path with Playwright and save screenshots (Simple home, Complex table with evidence highlighted, pause card, /compare) to docs/screenshots/.
- Verify the app works with NO API key (cache and template answers).
- Finally: `npm run build && npm start`, then curl `POST /api/ask` for each demo question and show the output.
- README: what Dial is, how to run it, the architecture in one paragraph (one tree, two token sets, cookie mode, facts-then-phrasing AI with evidence), the demo script below, and Inspiration crediting ShopperONE.

## Demo script (must work end to end, under 100 seconds, on a phone)

1. Fresh reset → choose Simple → sign in → home shows £486.20 due Friday.
2. Ask "Did I pay Tesco twice this month?" (chip or voice) → one sentence + the two Tesco charges as evidence → Read aloud.
3. Switch Dial to Complex → the same two rows are highlighted in the table → switch back.
4. Open the shop → buy £120 headphones → Simple pause card → "Cancel it".
5. "Pay my bill" → confirm → done.

## Out of scope

Database, auth, real bank/Capital One/Nessie APIs, a browser extension, real card blocking, push notifications, a service worker or offline mode, gamification, automatic detection of needs, multiple accounts. No deploy commands; Vercel is handled by the team.

## If we run late, cut in this order

Quiet hours → monthly budget → voice input → /compare → onboarding previews → Complex chart. Never cut: mode switching, one assistant answer with evidence, the pause card, the pay flow.

## Execution discipline

- This brief is authoritative over previous instructions.
- Do not silently change requirements to make implementation easier.
- If a requirement conflicts with the existing architecture, explain the conflict and propose the smallest solution.
- Prioritise a working end-to-end demo over decorative features.
- Never claim a test, accessibility audit, build or browser check passed unless it was actually run.
- At the end of each stage, report changed files, tests and results, known limitations, and the proposed commit message. Then stop for approval.
