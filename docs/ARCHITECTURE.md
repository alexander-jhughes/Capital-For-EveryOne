# Capital for Everyone: Dial architecture

How Dial understands a question, works out the answer and shows it. Read this before changing the assistant, voice,
insights or personalisation code.

## The rule everything follows

**Figures come from deterministic code. AI only understands and explains them.**

| Layer | Owns | Never does |
|---|---|---|
| Finance (`lib/finance`, `lib/state/derive-account.ts`) | Balances, totals, payments, Spend Pause checks | Guess, round for effect, or read display settings |
| Financial intelligence (`lib/insights`) | Evidence-backed observations: changes, trends, recurring and unusual charges, budget, obligations | Say why someone spent, predict credit eligibility, accuse fraud |
| Groq orchestration (`lib/ai`, `POST /api/ask`) | Understanding the question, choosing facts, wording the answer, follow-ups | Calculate, pick evidence, choose a screen, or see personalisation data |
| Voice engine (`lib/voice`) | Turning speech into one finished question at a time | Answer, act, or touch money |
| ML personalisation (`lib/personalisation`) | Suggesting display settings, after consent, on the device | See money, questions or answers; change anything without "Keep it" |
| Frontend (`components`, `app`) | Showing the same verified facts in the person's chosen way | Change a figure because of a display setting |

## How a question flows

```
typed text ─┐
            ├─► one pipeline ─► interpret()        display commands: preview, then "Keep it" (lib/voice/interpret.ts)
speech ─────┘   (same for both) ├► local answers    Pay and Spend Pause, from live state (lib/payments, lib/spend-pause)
   ▲                            └► askDial()        POST /api/ask {question, state, previousQuestion, style}
   │                                  │
lib/voice engine                      ▼
 interim text shown live        lib/ai: resolve follow-up ─► interpret intent (rules first, Groq only to classify)
 one utterance per question        ─► facts from lib/finance + lib/insights ─► Groq words it ─► validator
 corrections merged                ─► {answer, evidenceIds, source, experience{template,intent,insights}, resolvedQuestion, followUps}
 echo filtered, stale dropped                        │
                                                     ▼
                                  card re-derives figures with lib/finance + lib/insights on the device (same code)
```

Anything with financial consequences (a payment, turning Spend Pause off) is never done by Dial. Dial explains and
links to the screen where the person confirms it.

## Contracts (Phase 0)

| Contract | File | Notes |
|---|---|---|
| Insight | `lib/insights/types.ts` | Same code on server and browser. `experience.insights` carries ids; the card re-derives them. |
| Voice engine | `lib/voice/types.ts` | States, listen modes, transcript snapshots, one delivered utterance per id. |
| `/api/ask` additions | `docs/AI-UI-CONTRACT.md` ("Dial intelligence additions") | `style`, `resolvedQuestion`, `followUps`, `experience.insights`. All optional. |
| Preferences | `lib/preferences/schema.ts` | `answerStyle`, `listenMode`, `speechInput` (voice consent), `dialStyle()`. |

## Decisions

1. **Speech to text: the browser's Web Speech API, on-device first.** Chrome and Edge can recognise speech on the
   device (`processLocally`). Where that isn't available, the browser's online service may be used, but only after the
   person agrees to it (`speechInput: "cloud"`), with a plain notice that their voice is sent to it. Typing always
   works. No new dependency and no cost. Whisper in the browser was rejected (a large download, chunked rather than
   live, slow on phones). Hosted speech services were rejected (paid, and audio would go to a third party).
2. **Whippet (AGPL-3.0) is used for ideas only.** No code, patterns or strings were copied. The ideas adopted:
   interim text shown but never submitted, end of utterance after a stable pause, self-correction phrases replacing
   earlier words, utterance ids against duplicates and stale results, an echo filter so Dial's own voice doesn't count
   as an interruption, push-to-talk and continuous listening, and restart with back-off.
3. **One voice engine** for Voice Mode and the Ask sheet, so voice and text are equivalent: a spoken question goes
   through exactly the same pipeline, facts and validator as a typed one.
4. **Insights are deterministic and shared.** The server uses them as facts for Groq. The browser re-derives the
   same insight by id, so a card and its explanation can't disagree.
5. **Answer style is the person's explicit setting** (`dialStyle()`), sent as one word. Nothing learned by the ML
   model is ever sent to `/api/ask`.
6. **Follow-ups:** the backend returns `resolvedQuestion`, and the browser sends that back as the next
   `previousQuestion`. So "What about groceries?" then "Has that gone up?" keeps the subject. Whole conversations are
   never sent.
7. **Sources are labelled.** Answers say whether Groq worded them or they came straight from the account checks.

## Ownership

| Area | Owner | Notes |
|---|---|---|
| `lib/ai`, `app/api/ask`, `scripts/test-ask*` | Alex (backend) | Extended on `feat/dial-intelligence` for review. Nothing replaced. |
| `lib/personalisation`, `scripts/personalisation`, `docs/ml-personalisation` | Person 3 (ML) | Evaluated before any retraining. A retrained model is a reviewable change on this branch. |
| `lib/payments`, `lib/spend-pause`, Pay and Spend Pause screens | Alex | Unchanged by this work. |
| Contracts, `lib/assistant`, `lib/preferences`, integration | Frontend lead | |
