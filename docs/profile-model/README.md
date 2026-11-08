# Profile model: tailoring the app and Dial to the person

A trained model that works out which of six **person types** fits someone. It uses what they chose to tell us on
**About you** (`/account/about-you`) and their saved account behaviour, which the server reads from its own records.
The app then changes what Home shows first, which questions Dial suggests, and how Dial words its answers. The idea is
similar to the "money personality" features some banks offer, but built on the FCA's vulnerability guidance and the
Money Advice Trust's vulnerability handbook.

> **Status: prototype, trained on synthetic data only.** The pipeline works and is tested. It has not been validated on
> real people. See [Limitations](#limitations). Metrics: [`EVALUATION.md`](./EVALUATION.md).

## What the person sees

| Type | Shown as | Home "Picked for you" | Dial |
|---|---|---|---|
| `building` | Building your credit | Bill due date, Learning Lab | Plain words, explains terms |
| `steady` | Steady and in control | Subscriptions check, goals | Usual wording |
| `stretched` | Staying on top when money is tight | Free help, Spend Pause, a calmer screen offered as a preview | Calm tone, free-help signposting on bill answers |
| `life_change` | Going through a big change | Free help, bill due date, a calmer screen offered | Short, calm answers, signposting |
| `clear_simple` | Clear and simple | Talk to Dial, bill due date, Simple view offered | Plain words, one thing at a time |
| `planner` | Planning ahead | What-if sums, goals, chart offered | Usual wording |

Below the threshold (0.6) the model **does not guess**: no type is shown and About you asks instead. The person can
always pick a type themselves ("Which sounds most like you?"), and their choice beats the model.

## How it fits together

```
About you (consent, needs, own choice)      Account the server already holds (cfe-session)
            │  PUT /api/profile                          │
            ▼                                            ▼
   cfe-profile: signed, HttpOnly cookie  ──►  profileInputs(): utilisation, payment kinds, goal kinds, Spend Pause,
   (lib/server/profile.ts)                      Simple view, ticked needs, capped usage counts  (34 numbers, all 0-1)
                                                         ▼
                                     softmax regression (lib/profile/softmax.ts, model.json)
                                                         ▼
                        type + confidence + reasons + adaptations (lib/profile/infer.ts)
                 ┌───────────────────────────────┼─────────────────────────────────────┐
                 ▼                               ▼                                     ▼
   GET /api/profile → Home card,       POST /api/ask reads the same cookie:   Dial panel's suggested questions
   About you, preview offers           style → model prompt wording only;     (still run through plan() and
   (display changes need "Keep it")    signpost sentence on bill answers      the checked /api/ask path)
```

### Dial (`/api/ask`)

- `handleAsk` loads the profile from the cookie (never from the body), combines its style with the `style` the browser
  already sent from Display and voice, and passes it to `AskModel.phrase(question, facts, timeoutMs, style)`.
- `lib/ai/answer-style.ts` turns the style into extra prompt lines. They come after the base rules and never replace
  them. Every figure is still checked by the guard and validator, and a reply with an invented figure falls back to the
  template, styled or not (tested).
- If the profile asks for signposting, answers about the bill get one figure-free sentence pointing to MoneyHelper,
  National Debtline and StepChange (`signposted: true`).
- Anyone asking for help with money worries gets a fixed answer pointing to free advice, profile or not.
- `/api/dial` is unchanged. It still returns only validated steps and can't make a payment (tested with a profile present).

**Provider side:** the only change in the Groq client (`lib/ai/model.ts`) is the optional fourth `style` argument to
`phrase()`, which appends `styleInstruction(style)` to the phrasing system prompt. Only those wording rules go to Groq:
never the person's needs, type, consent or any id (tested in `lib/server/backend-integration.test.ts`).

## Why softmax regression

| Option | Why not / why |
|---|---|
| Hand-written rules | The baseline: 63.1% test accuracy, badly calibrated (log loss 4.4) |
| Random forest (used for display suggestions) | Good, but its probabilities need extra calibration and its explanations are less direct |
| **Softmax regression** | 84.9% test accuracy, macro F1 0.840, ECE 0.084 after temperature scaling. Each prediction splits exactly into per-feature contributions, which become the reasons shown. No ML library: about 60 lines of TypeScript, trains in about 4 s |

Training: full-batch gradient descent with L2 regularisation. A temperature is chosen on validation log loss, and the
threshold is the lowest one whose validation accuracy among confident predictions reaches 90%. Retrain with:

```bash
node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/profile/train.ts
```

Add `--check` to confirm the committed `lib/profile/model.json` matches a fresh run.

## Privacy and fairness rules

These follow the FCA's guidance on treating vulnerable customers fairly (FG21/1) and the Money Advice Trust's TEXAS
approach (Thank, Explain, eXplicit consent, Ask, Signpost):

- **No need or condition is guessed.** The needs are only what the person ticked. The model does make one
  inference: which of six ways of tailoring fits, from those ticks and account behaviour (for example, using most of
  the limit and paying the minimum leans towards "Staying on top when money is tight", which turns on the free-help
  card). It only runs with consent, shows its reasons, holds back below 0.6, and the person can choose another type.
  It never infers a health condition or labels anyone. A test bans words like "vulnerable", "disability" and
  "diagnosis" from all person-facing text.
- **Health needs and Groq.** A health need (for example "Long text or concentrating can be hard") can turn on wording
  rules such as "keep it short". Those rules, never the need itself, are sent to Groq with the question. The health
  consent text says so.
- **Consent first.** Nothing is stored until tailoring is turned on. Turning it off, or "Delete everything about me",
  deletes the cookie. `/demo/reset` clears it too.
- **Health is special category data.** Health needs need a second, explicit consent. The server refuses them without
  it, even inside a signed cookie, and withdrawing that consent deletes them.
- **Presentation only.** The profile never reaches balances, payments, Spend Pause, credit limits, pricing or any
  decision about credit. Its outputs are an allowlist of Home cards, Dial suggestion strings, wording flags, and
  display changes that are only ever previewed.
- **Transparent and correctable.** About you shows the type, the reasons (only features the person actually has),
  what changed, and lets them choose a different type.
- **Server-side trust boundary.** The cookie is HMAC-signed with `SESSION_SECRET` (with a separate domain prefix, so
  it can't be swapped with the session cookie). The browser can't read or forge it. Money features come from the
  server's own session, never from the request body.

## Files

| File | What |
|---|---|
| `lib/profile/catalog.ts` | Needs (by FCA driver), person types, free-help organisations |
| `lib/profile/features.ts` | The 34-feature allowlist and reason text |
| `lib/profile/softmax.ts`, `train.ts`, `synthetic.ts` | Model, training and evaluation, synthetic data |
| `lib/profile/infer.ts`, `model.ts`, `model.json` | Inference, adaptations, the committed model and its check |
| `lib/profile/provider.tsx` | Browser mirror of `GET /api/profile`, usage counts |
| `lib/server/profile.ts`, `profile-handlers.ts`, `app/api/profile/*` | Signed cookie store, validation, routes |
| `lib/ai/answer-style.ts` | Prompt lines, help detection, signposting text |
| `components/profile/*` | About you, the Home card, free-help links |
| `lib/profile/profile.test.ts`, `lib/server/profile.test.ts` | Model, store, API and `/api/ask` safety tests |

## Limitations

- **Synthetic data.** We wrote the generator, so the scores show the pipeline learns what we put in, not that it
  predicts real people. Before any real use: collect consented outcomes (did people keep their type or change it?),
  re-evaluate, and run a fairness review across groups.
- **Cookie storage.** Like the account session, the profile lives in a signed cookie, so it works on Vercel with no
  database. A database store implements the same `ProfileStore` interface (`load`, `save`).
- **Usage counts** are reported by the browser (capped at 10). They only affect presentation, never money.
- The Money Advice Trust handbook could not be fetched from this build environment. The rules above follow FCA FG21/1
  and the handbook's published TEXAS and IDEA approaches as generally documented.
