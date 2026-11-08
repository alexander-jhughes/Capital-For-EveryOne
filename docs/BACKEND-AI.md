# AI and backend integration

How Dial's AI (Groq), the account backend and the profile personalisation fit together on `feat/product-ux`.
Start here, then see `docs/BACKEND.md` (account API), `docs/AI-UI-CONTRACT.md` (`/api/ask` contract) and
`docs/profile-model/README.md` (the person-type model).

## 1. Architecture

```
Browser (Dial panel, screens)                               Server (Next.js route handlers, Node runtime)
──────────────────────────────                              ────────────────────────────────────────────────
plan() on device: rules first ──────────────────────────────►  POST /api/ask  ─┐
  money question                                                                │ facts: lib/finance on the session's
  request the rules can't read ─────────────────────────────►  POST /api/dial  │ account (seed + signed events)
                                                                                │ wording: Groq (lib/ai/model.ts)
screens ─── GET/POST/PUT/DELETE /api/account, payments, ...  ►  lib/server/*    │ checks: guard + validator
About you ── GET/PUT/DELETE /api/profile, POST .../usage ──►  lib/server/profile.ts ─► profile model (lib/profile)
                                                                                │
cookies: cfe-session (account events), cfe-profile (consented profile), both HMAC-signed and HttpOnly
```

- **One source of figures.** Every amount and date comes from `lib/finance` applied to the seed account plus the
  session's events. Groq only classifies questions and words answers. Every figure in a Groq reply is checked against
  the facts; any mismatch falls back to fixed wording built from the same facts.
- **No database.** Account events and the profile live in signed cookies, which works on Vercel with no setup.
  `SessionStore` and `ProfileStore` are two-method interfaces a database store can implement later without API changes.
- **Synthetic users** (`lib/demo-users`) are 18 fictional people stored as events on the same demo account, built
  through the same validated functions as the API.

## 2. Endpoints

| Method and path | Body | Reply | Notes |
|---|---|---|---|
| `POST /api/ask` | `{ question?, state?, previousQuestion?, style? }` | `{ answer, evidenceIds, source, experience?, modelBusy?, signposted?, tailored? }` | `docs/AI-UI-CONTRACT.md`. Reads the account and profile from cookies, never from the body when a session exists |
| `GET /api/ask` | | `{ ai: "groq", groq: "configured" \| "not configured", model, backups }` | Never shows the key |
| `POST /api/dial` | `{ text, screen: { route?, mode, textSize } }` | `{ steps, source: "model" \| "none" \| "failed", busy? }` | Only allowlisted, validated steps. Can't pay, transfer or change Spend Pause |
| `GET /api/account` | | Account state | `docs/BACKEND.md` |
| `POST /api/payments`, `DELETE /api/payments/:id` | `{ id, amount, kind }` | Account state | Only the Pay screen calls these, after the person confirms |
| `PUT /api/spend-pause`, `POST /api/purchases`, `GET/PUT /api/goals` | | Account state | Unchanged |
| `GET /api/profile` | | `{ consent, sensitiveConsent, needs, chosen, result, saved }` | `result` is null without consent |
| `PUT /api/profile` | any of `{ consent, sensitiveConsent, needs, chosen }` | Same as GET | Unknown keys, unknown needs, health needs without the extra consent: 400, nothing saved. `consent: false` deletes everything |
| `DELETE /api/profile` | | Same as GET, empty | Clears the cookie |
| `POST /api/profile/usage` | `{ kind: "dial" \| "learn" \| "whatIf" \| "goals" \| "detailed" }` | `{ counted }` | Only with consent; capped at 10 each |
| `POST /demo/reset` | | 303 to `/` | Clears session, prefs, view and profile cookies |
| `POST /demo/user/:id` | | 303 to `/account` | Demo only: become a synthetic user. Picker at `/demo/users` |

## 3. Environment variables

Set these in Vercel under **Project, Settings, Environment Variables**, ticking **Preview** and **Production**.
Never commit them; `.env*` is git-ignored apart from `.env.example`.

| Name | Required | Default | What it does |
|---|---|---|---|
| `GROQ_API_KEY` | For live AI | none | Server-side only, never `NEXT_PUBLIC_`. Without it Dial answers from cached and template wording |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Main model |
| `GROQ_FALLBACK_MODELS` | No | `openai/gpt-oss-20b,llama-3.1-8b-instant` | Comma separated; empty string turns fallback off |
| `SESSION_SECRET` | **Yes in production** | dev key in development | At least 32 characters (`openssl rand -base64 32`). Signs `cfe-session` and `cfe-profile`. Without it, production refuses to save account changes, profiles or demo users |
| `ASK_MODEL_CALLS_PER_MINUTE` | No | 60 | Per-visitor Groq call limit, for long test runs |
| `GROQ_BASE_URL` | No | Groq | Tests only (a local fake). Leave unset on Vercel |

Use a different `SESSION_SECRET` for Preview and Production so cookies from one can't be used on the other.
After changing variables, redeploy. Check with `GET /api/ask`: it should say `"groq": "configured"`.

## 4. Groq models and fallback

`lib/ai/groq.ts` is the only file that calls Groq (plain `fetch`, JSON mode, `temperature: 0`).
`lib/ai/model-chain.ts` decides the order and when to move on:

| Situation | What happens | Person sees |
|---|---|---|
| Main model answers | One call | Groq's wording, checked (`source: "model"`) |
| 429 rate limit, 500/502/503, 404 unknown model | Next model in the chain, one attempt each | Backup's wording, or fixed wording if all fail |
| Every model 429 | All three tried | Fixed wording, `modelBusy: true` ("Groq is busy") |
| 401 bad key, 400, 403 | Stops at once (another model won't fix it) | Fixed wording |
| Timeout | One 4-second deadline covers the whole chain; not retried | Fixed wording within about 4.6 s |
| Network error | Stops | Fixed wording |
| No key | No call | Fixed wording |

`/api/dial` uses the same chain and deadline; on failure it returns `{ steps: [], source: "failed" }` (with `busy`
for rate limits) and the panel says it didn't understand. Retrying within one request is deliberately limited to
moving down the chain: a second attempt on the same model would spend the deadline and the quota.

## 5. Errors

- Every route replies with JSON and `Cache-Control: no-store`. Problems the person can fix are a friendly 400 with
  `{ error }`; anything else is a 500 with a generic message. No stack traces or provider messages reach the browser.
- Groq errors keep only the HTTP status (`GroqApiError`). Logs say things like `[ask] phrasing failed: API status 429`:
  never the key, the question, the answer or a figure (tested).
- The profile never breaks Dial: if it can't be read, `/api/ask` answers without it.

## 6. Privacy and consent

- **What goes to Groq:** the question, the facts for that one answer (amounts, dates, shop names), and, if the person
  has a profile, up to four fixed wording rules (plain words, short, one thing at a time, calm). **Never** their needs,
  person type, consent, cookies, transaction ids, card number or name. `/api/dial` sends only the request and the
  screen (route, view, text size). Both are pinned by tests that inspect the actual request bodies.
- **Consent:** nothing about the person is stored until they turn tailoring on in About you. Health needs need a second
  explicit consent (special category data); the server refuses them otherwise and deletes them if it's withdrawn.
  Turning tailoring off or "Delete everything about me" deletes the profile cookie; the next answer is untailored.
- **Low confidence:** below 0.6 the model shows no type and the app asks instead. With no type there are no tailored
  cards, no extra wording rules and no signposting unless the person ticked a money-worry need.
- **Presentation only:** the profile changes Home cards, Dial suggestions and wording. It never reaches balances,
  payments, Spend Pause, limits or any credit decision.

## 7. Integration notes

- Frontend changes in this branch are small and listed in `docs/profile-model/README.md` ("Files"): the profile
  provider in the app layout, the "Picked for you" Home card, tailored Dial suggestions, the About you page, usage
  counts in five components, and links in More.
- Any new AI provider code must keep `phrase(question, facts, timeoutMs, style?)` and append
  `styleInstruction(style)` to its phrasing prompt, as `lib/ai/model.ts` does.
- Six **person types** (profile) are not demo financial scenarios: all synthetic users share one demo account.

## 8. Tests

```bash
npm test            # unit and integration (vitest)
npm run typecheck
npm run lint
npm run build
npm run test:http   # /api/ask over HTTP against a fake Groq, no key
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/profile/train.ts --check
```

`lib/server/backend-integration.test.ts` runs the real handlers and Groq client against a fake Groq: model chain under
failure for both endpoints, a hostile model (invented balance, transaction, payment confirmation, credit score),
prompt injection, no payment or Spend Pause change through `/api/dial`, the exact payload sent to Groq, logs, and
profile consent, deletion and low confidence.

## 9. Known limitations and outstanding dependencies

- **Accessibility ML and Groq Whisper (Mate 3, `feat/groq-adaptive-access`) are not integrated.** That branch isn't on
  GitHub. `4b5da91` ported only the Groq answer path and left out `lib/access` and Whisper. When it lands, the backend
  points to check are in section 10.
- **No database.** Cookie storage only, by decision. Per-visitor rate limiting is in memory per server instance.
- **The profile model is trained on synthetic data** and has not been validated on real people.
- **Browser speech recognition** is unchanged by this work; it is still the only voice input.
- Not done here: Vercel settings and deployment (needs approval and access).

## 10. For the accessibility and Whisper integration (when available)

Checks to make against that branch before merging it on top of this one:

- Accessibility preferences should go through the existing preferences store (`lib/preferences/schema.ts`), not a
  second store, and changes should be previewed with "Keep it" like everything else.
- If the semantic model runs in the browser (Transformers.js), load it lazily after consent, not on first page load.
- Whisper sends audio to Groq: it must need its own explicit opt-in (like the existing browser speech notice), must not
  be the default, and must not log transcripts. The browser speech path must keep working without it.
- A Whisper route needs a body size cap, the same rate limit, and the same "status only" error handling as
  `lib/ai/groq.ts`.
