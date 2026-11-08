# AI and backend integration

How Dial's AI (Groq), the account backend, the financial-profile personalisation and the synthetic demo users fit
together on `feat/product-ux`. Related: `docs/BACKEND.md` (account API in depth), `docs/AI-UI-CONTRACT.md`
(`/api/ask` contract), `docs/profile-model/README.md` (the person-type model), `docs/profile-model/EVALUATION.md` and
`UNSEEN-EVALUATION.md` (results).

Ownership: this document covers the Groq backend, the financial AI orchestration and the financial-profile
personalisation. The accessibility engine and Dial voice are separate workstreams (section 8).

## 1. Architecture

```
Browser                                                    Server (Next.js route handlers, Node runtime)
───────                                                    ─────────────────────────────────────────────
Dial panel: plan() on the device, rules first
  money question ────────────────────────────────────────► POST /api/ask ──┐ facts: lib/finance over the account in
  request the rules can't read ──────────────────────────► POST /api/dial  │   cfe-session (seed + signed events)
Screens ── /api/account, payments, spend-pause, goals ───► lib/server/*     │ wording: Groq (lib/ai/model.ts → groq.ts)
About you ── /api/profile, /api/profile/usage ───────────► lib/server/profile.ts ─► profile model (lib/profile)
/demo/users ── POST /demo/user/:id ──────────────────────► lib/demo-users  │ checks: guard + validator on every reply
                                                                           └ profile (cfe-profile, consent only):
Cookies: cfe-session (account events) and cfe-profile (consented            wording rules and signposting only
profile), both HMAC-SHA256 signed with SESSION_SECRET and HttpOnly.
```

Five rules hold everywhere:

1. **Figures come only from `lib/finance`**, worked out on the server from the seed account plus the session's events.
   Groq classifies questions and words answers. Every amount and date in a Groq reply is checked against the facts;
   any mismatch falls back to fixed wording built from the same facts.
2. **Dial can't change money.** `/api/ask` only reads. `/api/dial` returns only allowlisted steps (navigate, display
   preview, view, chart, what-if, goal) and every display, view and goal step needs the person's confirmation.
   Payments happen only on the Pay screen after the person confirms; Spend Pause changes only on its screen.
3. **The browser can't set a figure.** Bodies carry requests; signed cookies carry events; balances are recomputed.
4. **The profile shapes presentation only**, and only with consent.
5. **Dial keeps working without Groq**: no key, a bad key, an outage or a timeout all give checked fixed wording.

There is **no database**, by decision. `SessionStore` (`lib/server/store.ts`) and `ProfileStore`
(`lib/server/profile.ts`) are two-method interfaces (`load`, `save`); a database store can implement them later
without changing any route.

## 2. API endpoints and contracts

Every route replies with JSON (except the demo redirects) and `Cache-Control: no-store`. Errors are
`{ error: string }` written for the person, never a stack trace or provider message.

### `POST /api/ask`: a question about the account

Request (max 16 KB):

```ts
{
  question?: string;         // up to 300 characters; missing = the spending summary
  state?: ClientState;       // only read when there is no signed session (docs/AI-UI-CONTRACT.md)
  previousQuestion?: string; // up to 300 characters, for follow-ups
  style?: "standard" | "brief" | "stepByStep"; // from Display and voice; unknown values are ignored
}
```

Response 200:

```ts
{
  answer: string;
  evidenceIds: string[];               // always from the facts, never from the model
  source: "model" | "template" | "cache";
  experience?: { template, intent, confidence, periodLabel? };
  modelBusy?: true;                    // every Groq model was rate limited
  signposted?: true;                   // mentions free, impartial money advice; never carries a figure
  tailored?: true;                     // the saved profile changed the model's wording or added the signpost
}
```

400: empty, too long, unreadable or a bad `state`. 500: unexpected failure (generic message).
`GET /api/ask` returns `{ ai: "groq", groq: "configured" | "not configured", model, backups }` and never the key.

### `POST /api/dial`: a request the on-device rules couldn't read

Request (max 2 KB): `{ text: string, screen: { route?: string, mode: "simple" | "complex", textSize: 100 | 125 | 150 | 200 } }`.
Response 200: `{ steps: DialStep[], source: "model" | "none" | "failed", busy?: true }`. At most 3 actions are read
from the model, and each must pass `validateStep()` (`lib/dial/types.ts`). 400 for a bad body.

### Account (unchanged by this work; see `docs/BACKEND.md`)

`GET /api/account`, `POST /api/payments`, `DELETE /api/payments/:id`, `PUT /api/spend-pause`, `POST /api/purchases`,
`GET/PUT /api/goals`. Each change replies with the whole derived account state.

### `GET | PUT | DELETE /api/profile`: the person's saved profile

Response 200 (all three):

```ts
{
  consent: boolean;
  sensitiveConsent: boolean;  // the extra consent for health needs
  needs: NeedId[];            // lib/profile/catalog.ts
  chosen: PersonType | null;  // the type the person picked; beats the model
  result: {                   // null without consent, or if the model file doesn't match the code
    type: PersonType | null;  // null = the model isn't sure (below 0.6) and the person hasn't chosen
    source: "model" | "chosen" | "none";
    confidence: number;       // top probability, 2 places
    probabilities: Record<PersonType, number>;
    reasons: string[];        // only features the person actually has
    adaptations: { cards, dialSuggestions, style, signpost, displayOffer };
    modelVersion: string;
  } | null;
  saved: true;
}
```

`PUT` body (max 2 KB), any of: `{ consent?: boolean, sensitiveConsent?: boolean, needs?: NeedId[], chosen?: PersonType | null }`.
Refused whole with 400 (nothing saved): unknown keys, unknown needs or types, any change before `consent: true`, or a
health need without `sensitiveConsent`. `consent: false` deletes everything. `DELETE` clears the cookie.

### `POST /api/profile/usage`

`{ kind: "dial" | "learn" | "whatIf" | "goals" | "detailed" }` → `{ counted: boolean }`. Counted only with consent,
capped at 10 each. Counts are reported by the browser and only affect presentation.

### Demo only

| Route | What it does |
|---|---|
| `POST /demo/reset` | 303 to `/`; clears the session, display, view and profile cookies |
| `GET /demo/users` | Picker for the 18 synthetic users |
| `POST /demo/user/:id` | 303 to `/account` as that user (section 6). 403 for a form posted from another site, 404 for an unknown id, 500 if `SESSION_SECRET` is missing in production |

## 3. Environment variables

Set in Vercel under **Project, Settings, Environment Variables**, ticking **Preview** and **Production** (use a
different `SESSION_SECRET` for each). Redeploy after changing them. Never commit them: `.env*` is git-ignored apart
from `.env.example`, which holds only empty placeholders.

| Name | Required | Default | What it does |
|---|---|---|---|
| `SESSION_SECRET` | **Yes, in production** | a development-only key | At least 32 characters (`openssl rand -base64 32`). Signs `cfe-session` and `cfe-profile`. Without it, production can't save account changes, profiles or demo users, and `/api/ask` falls back to the state the browser sends |
| `GROQ_API_KEY` | For live AI | none | Server-side only, never `NEXT_PUBLIC_`. Without it Dial answers from cached and fixed wording |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Main model |
| `GROQ_FALLBACK_MODELS` | No | `openai/gpt-oss-20b,llama-3.1-8b-instant` | Comma separated; an empty string turns fallback off |
| `ASK_MODEL_CALLS_PER_MINUTE` | No | `60` | Per-visitor Groq call limit (in memory, per server instance) |
| `GROQ_BASE_URL` | No | Groq | For tests against a local fake only. Leave unset on Vercel |

Check a deployment with `GET /api/ask` (`"groq": "configured"`) and by choosing a demo user at `/demo/users`
(a 500 there means `SESSION_SECRET` is missing).

## 4. Failure handling and fallback

`lib/ai/groq.ts` is the only file that calls Groq: plain `fetch`, JSON mode, `temperature: 0`, one attempt per
model. `lib/ai/model-chain.ts` decides the order. One 4-second deadline covers the whole chain.

| Situation | What happens | The person sees |
|---|---|---|
| Main model answers | One call | Groq's wording, checked (`source: "model"`) |
| 429, 500, 502, 503, or 404 (model unknown) | Next model, one attempt each | The backup's wording, or fixed wording if all fail |
| Every model 429 | All three tried | Fixed wording, `modelBusy: true`; `/api/dial` gives `busy: true` |
| 401 bad key, 400, 403 | Stops at once: another model won't fix it | Fixed wording; `/api/dial` gives no steps |
| Timeout | Not retried (the deadline is shared) | Fixed wording within about 4.6 s |
| Network error | Stops | Fixed wording |
| No key | No call | Fixed wording |
| Reply with a wrong or invented figure | Rejected by the guard and validator | Fixed wording |
| Reply cut off, filtered or not JSON | Treated as no answer | Fixed wording |
| Profile can't be read | Ignored | An untailored answer |
| Over the per-visitor call limit | No Groq call | Fixed wording |

Logs keep only short reasons such as `[ask] phrasing failed: API status 429`: never the key, the question, the
answer or a figure (tested). Each of these rows is tested in `lib/server/backend-integration.test.ts` through the
real handlers and Groq client against a fake Groq.

## 5. Personalisation behaviour

The full description is in `docs/profile-model/README.md`. In short:

- **Inputs.** What the person ticks on About you (18 needs grouped by the FCA's four drivers, plus how they like Dial
  to talk), the account behaviour the server already holds (share of the limit used, payment kinds, goal kinds,
  Spend Pause, view), and capped usage counts. No free text, no amounts, no merchants. 34 numbers, all 0 to 1.
- **Model.** Softmax regression, trained on synthetic data only, calibrated with temperature scaling. Six person
  types. Below a top probability of 0.6 it shows no type and About you asks instead. The person's own choice beats it.
- **Outputs.** Up to three Home cards, up to four Dial suggestions, up to four wording rules for Groq (plain, brief,
  step by step, calm), a free-advice signpost on bill answers, and one display change offered only as a preview.
- **Stated needs always win.** A need the person ticked changes Dial's wording and signposting whatever type the model
  picks (tested for every type).
- **Help requests.** Questions like "I'm drowning in debt" get a fixed answer pointing to MoneyHelper, National
  Debtline and StepChange, with or without a profile. The detector is a list of patterns, not a model.
- **Consent.** Nothing is stored until tailoring is on. Health needs need a second consent. Turning tailoring off or
  "Delete everything about me" deletes the cookie, and the next answer is untailored (tested).
- **What goes to Groq.** Only the wording rules, never the needs, type, consent, cookies or ids (tested on the
  actual request bodies). Some rules come from health needs (for example "Long text or concentrating can be hard"
  turns on short answers); the health consent text says that wording rules, never what was told, go to the AI
  provider.
- **Requests in order.** The browser sends profile requests one at a time, so a usage count can't re-sign a profile
  that was just deleted. Dial's per-tab answer cache includes the profile in its key.

Measured results (details in the evaluation files):

| | Result |
|---|---|
| Synthetic test set (1,500 people) | 84.9% accuracy, macro F1 0.840; 91.6% correct among the 78% given a type |
| 18 synthetic demo users | 18 of 18 typed as designed (confidence 0.63 to 1.00) |
| Unseen clear situations | 8 of 12 right; the other 4 held back and asked; none confidently wrong |
| Unseen ambiguous situations | 7 of 7 held back and asked |
| Unseen conflicting situations | 7 of 7 acceptable (4 asked, 3 picked a type at 0.62 to 0.89) |
| Help detector, held-out phrasings | 9 of 12 caught, 0 of 10 false alarms (3 of 12 before it was widened) |

## 6. Synthetic demo users

`lib/demo-users/users.ts`: 18 fictional people, three written for each person type. Each has needs, a view, usage
counts and account history stored as events (payments, purchases, goals, Spend Pause) on the one demo account. They
are built through the same validated functions the API uses, so they can't hold anything a real visitor couldn't.

Choosing one (`POST /demo/user/:id`) gives this browser a clean start as that person: their session, profile and view
replace the visitor's; display settings (`cfe-prefs`) are cleared; the reply sends `Clear-Site-Data: "storage"`, and
the picker also clears the app's `cfe-*` storage before submitting. Without that, a pending Spend Pause purchase from
the previous user stayed in the tab (found in testing and fixed).

Tested: all 324 user-to-user switches leave exactly the new user's data; every event id belongs to the current user;
refresh keeps the user; a separate browser sees none of it; a form posted from another site gets a 403.

Limitations:

- **They share one demo account.** Differences between users come only from their events, so balances differ
  modestly (for example Dan £1,164.89, Ivy £583.69). The six person types are not separate financial scenarios.
- **Display settings and on-device suggestions reset** on every switch, as with "Start the demo again".
- **Demo only.** The route has no sign-in: it only ever writes the caller's own cookies, and with no real accounts
  there is nothing to impersonate. It must be removed or put behind sign-in before any real-account use.
- Synthetic users were written by the same team that wrote the generator, so their 18 of 18 agreement is a
  consistency check, not evidence the model works on real people.

## 7. Integrating with this backend (frontend)

- Read the profile with `useProfile()` (`lib/profile/provider.tsx`), mounted in `app/(dial)/layout.tsx`. It mirrors
  `GET /api/profile`; the server is the source of truth.
- Frontend files touched by this work: the layout provider, `components/profile/*` (About you, Home card, free-help
  list, demo-user button), the Home card slot in `components/home/home-screen.tsx`, the suggestion chips in
  `components/voice/voice-mode.tsx` (5 lines, owned by the voice workstream: please review), usage counts in
  `ask-dial.tsx`, `learn-screen.tsx`, `goals-screen.tsx`, `what-if-card.tsx` and `mode-switch.tsx`, and links in More.
- Any AI provider code must keep `phrase(question, facts, timeoutMs, style?)` and append `styleInstruction(style)`
  to its phrasing prompt, as `lib/ai/model.ts` does.

## 8. Accessibility engine: what exists today and what still needs agreeing

The full integration architecture, proposed contract, conflicts and ownership are in
`docs/ACCESSIBILITY-INTEGRATION.md`. This section is the short version.

The accessibility engine (semantic classification, optional Groq Whisper) is not in this branch: it was on
`feat/groq-adaptive-access`, which isn't on GitHub, and `4b5da91` ported only the Groq answer path. Nothing below is
an agreed contract; it describes the existing code an integration would meet.

**What exists:**

- **One store for display settings:** `lib/preferences/schema.ts` (`Preferences`, the `UiAction` union, `sanitize`,
  `applyActions`), persisted in the `cfe-prefs` cookie by `PreferencesProvider`.
- **Previews:** `usePreferences().startPreview(actions, { source })` and `useStylePreview().startRequest(...)` show a
  change with "Keep it" / "Go back". `source` is one of `"settings" | "voice" | "style" | "ml" | "other"`.
- **Dial already proposes display changes** as `{ type: "preferences", actions: UiAction[] }` steps, which are in
  `CONFIRMED_STEPS` (`lib/dial/types.ts`): nothing changes without the person's confirmation.
- **Existing on-device display suggestions** (`lib/personalisation`, random forest) need their own consent.
- **This backend has no accessibility endpoint**, stores no accessibility data, and sends nothing about accessibility
  to Groq. The profile's health needs are separate, consented, and only change Dial's wording.
- **Voice input today** is the browser's speech recognition (voice workstream), after the person chooses it.

**What still needs agreeing with the accessibility owner:**

1. Whether classification runs in the browser (no backend change) or needs a server route, and if so its body,
   size limit, rate limit and error shape.
2. Whether its results become `UiAction`s through the existing preview and confirmation flow, or something new.
3. Which `source` value its changes use, and whether it shares or replaces the existing display-suggestion consent.
4. Whether anything it learns is stored, where, and how it is deleted (and whether the About you health needs and
   its findings should ever meet: today they don't).
5. For Whisper: which route sends audio to Groq, its explicit opt-in (separate from the browser speech notice), what
   is logged (nothing from transcripts today), and how the browser speech path keeps working without it.
6. How confidence thresholds and "ask before changing" are shown, so the person sees one consistent pattern.

## 9. Tests and how to run them

```bash
npm test                 # vitest: unit and integration
npm run typecheck
npm run lint
npm run build
npm run test:http        # /api/ask over HTTP against a fake Groq, no key (starts its own server)
npm run test:demo-users  # browser: 18 users, refresh, separate browser, carry-over, cross-site (after a build)
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/profile/train.ts --check
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/profile/evaluate-unseen.ts
```

The other browser scripts (`test:backend`, `test:product`, `test:pay`, `test:browser`, `test:stage6`,
`scripts/test-ml-browser.mjs`, `scripts/test-dial-screens-browser.mjs`) can also be run with plain `node` where
Playwright is installed globally.

## 10. Known limitations

- **No database**: cookie storage only; the per-visitor Groq limit is in memory per server instance.
- **The profile model is trained on synthetic data** and has not been validated on real people. Before real use:
  consented real outcomes, re-evaluation and a fairness review.
- **The help detector is pattern-based**: it missed 3 of 12 held-out requests ("My debts are getting on top of
  me", "I'm stuck with my finances, can someone help?", "I'm going to miss my payment").
- **Usage counts are browser-reported**, capped at 10, and only affect presentation.
- **Two tabs at once.** Profile requests are ordered within one tab. If a person deletes their profile in one tab
  while another tab's usage count is in flight, that count could re-sign the old profile. A database store with a
  server-side delete would close this; with signed cookies it can't be closed fully.
- **The accessibility engine and Whisper are not integrated** (section 8).
- **Not verified against a live Groq key or the Vercel Preview from this environment**: its network blocks both.
  All Groq behaviour is tested against a fake Groq that mimics the API.
