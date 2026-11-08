# Accessibility Intelligence Engine: integration architecture

A technical handover for the accessibility engine's owner. It describes the code the engine will meet, proposes the
smallest contract that connects it, and lists what still has to be agreed. **It does not implement the engine**, and
no file outside this document was changed to write it.

- **Audited:** `feat/product-ux` at `4b5da91` (the Groq baseline) plus PR #16 (`feat/alex-ai-backend-integration`,
  head `51ca60d`). Also read: `claude/serene-rubin-2badwa` and `feat/dial-intelligence`, the two Dial/voice branches
  on GitHub.
- **Not available:** the engine itself (`feat/groq-adaptive-access`, and the commits `1de9e33` for `lib/access` and
  `da09593` for Groq Whisper named in `docs/INTEGRATION.md`) is not on GitHub or in this clone. The engine's internals
  below come from the owner's description (Transformers.js, quantised `all-MiniLM-L6-v2`, confidence-based decisions,
  confirmation before changes, session and persistent preferences, optional Groq Whisper).
- **Status of everything marked "proposed":** a proposal to agree, not an agreed contract.

## 1. Summary

The app already has a complete, safe path from a request in words to a change in how the app looks. It works the
same for typed and spoken requests:

```
typed text ─┐
            ├─► session.submit(text) ─► plan(): on-device rules, incl. interpret() ─► steps
speech ─────┘   (components/dial/session.tsx)        │ rules gave up
   (voice engine hands over                          ▼
    one finished utterance)                   POST /api/dial (Groq) ─► validated steps
                                                     │
                                                     ▼
            runSteps() ─► { type: "preferences", actions: UiAction[] } ─► preview ─► "Keep it" ─► "Save"
                                                     (PreferencesProvider: session, then cfe-prefs cookie)
```

**Recommendation:** the engine should be **one more interpreter inside that path**, not a second path. It slots in
after the deterministic rules and before the Groq call. It returns the same `UiAction`s, and its results go through
the same validation, preview and confirmation. Then:

- typed and spoken requests use it automatically;
- nothing new can change the app without the person's confirmation;
- one store holds display settings;
- Groq is called less: only when the on-device engine isn't sure either.

Genuinely new pieces: the engine module itself (yours), one optional hook in `session.submit`, a "choices" reply for
low-confidence clarification, and one `ChangeSource` value. Everything else is reuse (section 4).

## 2. Interfaces that exist today

### 2.1 Display preferences: the single store (`lib/preferences`)

| What | Where | Notes for the engine |
|---|---|---|
| `Preferences` | `schema.ts` | `textSize` (100, 125, 150, 200), `contrast`, `spacing`, `motion`, `theme`, `targets`, `explanations`, `voiceFirst`, `answerStyle`, `listenMode`, `speechInput`, `charts`, `learning`, `layout` |
| `UiAction` (union of 21 actions) | `schema.ts` | **The only way to express a change.** The engine's output should be `UiAction[]` |
| `sanitize(input)` | `schema.ts` | Rebuilds `Preferences` from untrusted input, allowlist only |
| `applyAction` / `applyActions` | `schema.ts` | Pure; never touches account data |
| `stepTextSize(current, dir)` | `schema.ts` | Use for "bigger" and "smaller" rather than hard-coding sizes |
| `describeActions(actions)` | `schema.ts` | Plain-English description used by Dial's offer and the preview banner |
| `PREFS_COOKIE` (`cfe-prefs`), `encodePrefs`, `decodePrefs`, `prefAttributes` | `schema.ts` | Saved settings. The server reads the cookie on first render (`app/layout.tsx`), so a saved look never flashes. CSS reads the `data-*` attributes |
| `usePreferences()` | `provider.tsx` | `prefs`, `preview`, `startPreview(actions, { source })`, `acceptPreview({ save })`, `rejectPreview()`, `apply(actions, { save, source })`, `undo()`, `save()`, `resetToDefault()`, `subscribe(listener)` |
| Three layers | `provider.tsx` | **saved** (`cfe-prefs` cookie) → **kept** (this session, `sessionStorage` `cfe-prefs-session`) → **preview** (not yet accepted) |
| `ChangeSource` | `events.ts` | `"settings" \| "voice" \| "style" \| "ml" \| "other"`. Every kept change carries one |
| `PrefsEvent`, `subscribe()` | `events.ts`, `provider.tsx` | `kept` / `undo` / `reset` events after a change is kept (never for previews) |
| `dialStyle(prefs)` | `schema.ts` | Turns `explanations` and `answerStyle` into the one-word style sent to `/api/ask` |

### 2.2 Dial (`lib/dial`, `components/dial`)

| What | Where | Notes |
|---|---|---|
| `DialStep` | `lib/dial/types.ts` | `{ type: "preferences"; actions: UiAction[] }` and `{ type: "setMode"; mode }` are the display steps |
| `CONFIRMED_STEPS` | `lib/dial/types.ts` | `setMode`, `preferences` and `goal` are always previewed or confirmed first |
| `validateStep(x)` | `lib/dial/registry.ts` | Validates any step from any source. Run it on everything the engine produces |
| `plan(input, env)` | `lib/dial/plan.ts` | Deterministic, on-device. Includes `displayTurn` ("make this easier to understand" leads to Simple view, or calm plus step by step) |
| `interpret(utterance, { textSize })` | `lib/voice/interpret.ts` | **Existing rule-based language-to-`UiAction` interpreter** ("make everything bigger", "dark mode", "bigger buttons"), used by `plan()` for typed and spoken text |
| `session.submit(text, { replaces })` | `components/dial/session.tsx` | The one entry point for typed and spoken requests. Order: `plan()`, then `askModelForSteps` (`/api/dial`) only if every planned step is `unsupported`, then `runSteps` |
| `previewPreferences` | `session.tsx` → `runSteps` | Calls `startPreview(step.actions, { source: "voice" })` for every Dial display change, typed or spoken |
| `session.decide(yes, { save })` | `session.tsx` | "Keep it", "Keep and save" or "No" for a pending offer |
| `ReplyItem` | `lib/dial/runner.ts` | `say`, `visual`, `whatIf`, `answer` (with `followUps` chips), `offline`, `offer`, `link`, `failed`. No generic "choices" item yet |

### 2.3 Groq orchestration (`lib/ai`, backend owner)

| What | Where | Notes |
|---|---|---|
| `groqJson(config, req)` | `lib/ai/groq.ts` | The only code that calls Groq. JSON mode, `temperature: 0`, errors keep only the HTTP status |
| `modelChain()`, `withModelFallback()` | `lib/ai/model-chain.ts` | `llama-3.3-70b-versatile`, then `openai/gpt-oss-20b`, then `llama-3.1-8b-instant`. One 4-second deadline for the chain |
| `POST /api/dial` | `app/api/dial/route.ts` → `lib/ai/command-handler.ts`, `command-model.ts` | **Already translates display requests in words into `UiAction`s with Groq**: "display" actions for `textSize`, `contrast`, `theme`, `spacing`, `motion`, `targets`, `density`, `explanations`, `answerStyle`, `voiceFirst`, and widget moves. Sends only the text (max 300 characters), route, view and text size. Max 3 actions, each validated |
| `askModelForSteps(text, screen, { signal })` | `lib/assistant/command-client.ts` | Browser client for `/api/dial`; returns steps, `"busy"` or null |
| Rate limit | `lib/ai/rate-limit.ts` | 60 Groq calls per visitor per minute, in memory |

### 2.4 Profiles and personalisation (three systems today)

| System | Where | What it changes | Consent and storage |
|---|---|---|---|
| **Financial profile** (PR #16) | `lib/profile`, `lib/server/profile.ts`, `/api/profile`, `useProfile()` | Home cards, Dial suggestion chips, Dial **wording** (plain, brief, step by step, calm), free-help signposting, one display offer previewed as `source: "ml"` | Opt-in on About you; health needs need a second consent. Signed HttpOnly cookie `cfe-profile` (JavaScript can't read it; use `GET /api/profile`) |
| **Display suggestions** (random forest) | `lib/personalisation`, `components/personalise/ml-suggestion.tsx` | One "Suggested for you" display change, previewed as `source: "ml"` | Own opt-in. `localStorage` `cfe-personalisation`. Counts only kept changes whose source is `settings` or `voice` (`COUNTED_SOURCES`) |
| **"Make it yours" styles** | `lib/preferences/recommend.ts`, `components/personalise/*` | A whole style (actions plus view), previewed as `source: "style"` | Rule table, no stored profile |
| Preview bar for styles and suggestions | `components/personalise/style-preview.tsx` | `useStylePreview().startRequest({ name, actions, mode?, source, onFinish })`, `active` | |

### 2.5 Voice (voice workstream)

| What | Where | Notes |
|---|---|---|
| Voice engine contract | `lib/voice/types.ts` | States, `ListenMode`, `RecognitionBackend` (`"on-device" \| "cloud" \| "none"`), one finished `Utterance` per id. The file says changes need agreeing with the voice and frontend owners |
| `createVoiceEngine`, `useVoiceEngine`, `useDialVoice` | `lib/voice/engine.ts`, `lib/voice/use-voice-engine.ts`, `components/dial/use-dial-voice.ts` | Browser Web Speech API. On-device where possible; the browser's online service only with `speechInput: "cloud"` |
| Speech consent | `components/dial/voice-consent.tsx`, `Preferences.speechInput` | `"unset" \| "on-device" \| "cloud" \| "typing"` |
| Hand-off to Dial | `components/voice/voice-mode.tsx` (`handle(text)` → `session.submit`) | Spoken and typed text take exactly the same path from here |
| Architecture decision 1 | `docs/ARCHITECTURE.md` | **Whisper was rejected** (in-browser: download size, not live, slow on phones; hosted services: audio to a third party) |

### 2.6 Browser storage keys

`cfe-prefs` (cookie), `cfe-mode` (cookie), `cfe-session` and `cfe-profile` (signed HttpOnly cookies),
`cfe-prefs-session`, `cfe-spend-pause-session`, `cfe-payments-session` (`sessionStorage`), `cfe-personalisation`
and `cfe-quiz` (`localStorage`). "Start the demo again" and demo-user switching clear every `cfe-*` storage
key and the display cookie.

## 3. Where the engine plugs in (proposed)

```
session.submit(text, { source })
  1. plan()                       on-device rules (unchanged)
  2. if every step is unsupported (rules gave up) and the text isn't about money:
       engine.classify(request)   ◄── NEW: on-device, only if the engine is loaded and consented
         adapt   (high confidence)  ─► steps = [{ type: "preferences", actions }] or [{ type: "setMode", mode }]
         clarify (middle)           ─► a "choices" reply; nothing changes
         none    (low / not ours)   ─► continue to step 3
  3. askModelForSteps() ─► /api/dial (Groq, unchanged)
  4. runSteps() ─► preview ─► "Keep it" / "No" ─► "Save" (unchanged)
```

Why this order:

- **Rules first:** instant, free and predictable. They already handle the common phrases, and the engine never
  overrides them.
- **Engine second:** on-device and free; it catches paraphrases the rules miss ("the letters are tiny", "it hurts
  my eyes").
- **Groq last:** only when neither is sure. It costs a call and sends the text to Groq.
- **Money questions never reach the engine.** If `plan()` produced an `ask` step, or the text names money (the
  `MONEY` patterns in `plan.ts`), skip the engine. Its job is how the app looks and behaves, not finance.

**Time budget:** classification must not hold up Dial. If the model isn't loaded yet, return `none` at once and keep
loading in the background (after consent). A loaded MiniLM embedding on a short text should be well under
100 ms; enforce a timeout of about 300 ms and treat a timeout as `none`.

## 4. The contract

### 4.1 Reuse, don't rebuild

| Need | Reuse | Don't |
|---|---|---|
| Express a change | `UiAction[]`, plus `{ type: "setMode" }` for the view | Invent a parallel settings model |
| Check a change | `validateStep()` on the resulting step, `sanitize()` on anything restored | Trust model output directly |
| Show and confirm a change | Return steps from `submit`; `runSteps` previews and `decide()` keeps or saves | Call `apply()` directly from the engine |
| Describe a change | `describeActions(actions)` | Write separate descriptions for the same actions |
| Step text size | `stepTextSize()` | Hard-code sizes |
| Rule-based phrases | `interpret()` (via `plan()`), unchanged | Duplicate its phrase lists in the engine |
| Groq for hard phrases | `POST /api/dial` (already returns display actions) | Add a second Groq route for the same job |
| Proactive suggestion (not a request) | `useStylePreview().startRequest({ ..., source })` | A new preview bar |
| Know what was kept | `usePreferences().subscribe()` events | Poll the cookie |
| Answer style for `/api/ask` | `answerStyle` / `explanations` preferences (they already flow to Groq via `dialStyle()`) | A new channel to `/api/ask` |

### 4.2 Proposed types (owned by the engine, `lib/access/types.ts`)

```ts
import type { DialRoute } from "@/lib/dial/types";
import type { Preferences, UiAction } from "@/lib/preferences/schema";
import type { Mode } from "@/lib/types";

export interface AccessRequest {
  /** The person's words after Dial's own clean-up, max 300 characters (MAX_COMMAND_LENGTH). */
  text: string;
  /** Spoken text is noisier; the engine may use a higher threshold for it. The engine never receives audio. */
  input: "typed" | "spoken";
  context: { route: DialRoute | null; mode: Mode; prefs: Preferences };
}

export type AccessResult =
  /** Not an accessibility request, or not sure enough: Dial carries on (Groq via /api/dial). */
  | { kind: "none" }
  /** Confident. Still only a preview: the person keeps or rejects it. */
  | { kind: "adapt"; actions: UiAction[]; mode?: Mode; confidence: number; label: string }
  /** Two or three plausible readings. Nothing changes until the person picks one. */
  | { kind: "clarify"; prompt: string; options: AccessOption[]; confidence: number };

export interface AccessOption {
  label: string;
  /** A phrase the on-device rules already understand (e.g. "Make the text bigger"). Choosing it re-submits this
   *  phrase, so the choice goes through plan(), validation and preview like anything typed or said. */
  utterance: string;
}

export interface AccessEngine {
  status: "off" | "loading" | "ready" | "unavailable";
  /** Never throws, never blocks: resolves "none" when not ready, on timeout or on any error. */
  classify(request: AccessRequest, signal: AbortSignal): Promise<AccessResult>;
}
```

### 4.3 New interfaces that are genuinely needed

| # | Interface | File | Owner | Why it's needed |
|---|---|---|---|---|
| N1 | The engine (`AccessEngine`, model loading, embeddings, thresholds, its own state) | `lib/access/*` (new) | Accessibility owner | The new capability |
| N2 | One optional hook in `submit`: `deps.access?.classify(...)` after the rules give up, before `askModelForSteps` | `components/dial/session.tsx` | **Shared** (Dial frontend; both voice branches touch this function) | The only place every typed and spoken request passes through |
| N3 | A "choices" reply: `{ kind: "choices"; text: string; options: { label: string; utterance: string }[] }`, rendered as buttons that call the existing `onFollowUp(utterance)` | `lib/dial/runner.ts`, `components/dial/dial-reply.tsx` | **Shared** (Dial frontend) | Low-confidence clarification. Today only `answer` items have chips |
| N4 | `ChangeSource` gains `"access"` | `lib/preferences/events.ts` | **Shared** (preferences contract) | So a kept change can be traced to the engine, and the display-suggestion model can decide whether to count it |
| N5 | `previewPreferences` passes the engine's source through (`source: "access"` instead of always `"voice"`) | `components/dial/session.tsx` | **Shared** | Today every Dial preview is tagged `"voice"`, even when typed |
| N6 (only if needed) | New `UiAction` values (for example a reading font or line spacing) | `lib/preferences/schema.ts`, the CSS, `lib/ai/command-model.ts` (so Groq can return them too) | **Shared** plus the backend owner | Only if the engine needs settings that don't exist. Add them to the one store; never a second store |
| N7 (only if decision 1 is reversed) | A transcription route, e.g. `POST /api/transcribe` | `app/api/*`, `lib/ai/groq.ts` | Backend owner plus voice owner | Groq Whisper. See section 6.3 |

No new database, authentication, AI provider or second preferences store is needed.

### 4.4 Using Groq safely for requests in words

The engine shouldn't call Groq itself. When it isn't confident it returns `none`, and Dial's existing `/api/dial`
call handles it. That path already:

- sends only the person's words (max 300 characters, control characters and angle brackets removed), the route, the
  view and the text size; never the account, the profile or anything health-related;
- asks for JSON against a fixed schema, at most 3 actions, `temperature: 0`;
- validates every action (`toUiAction` allowlist, then `validateStep`) on the server and again in the browser;
- falls back across the three models, gives up within 4 seconds, says plainly when Groq is busy, and keeps working
  with no key;
- tells Groq the request is data, not instructions.

If the engine needs Groq for something `/api/dial` can't express (for example new settings, N6), extend
`lib/ai/command-model.ts`'s action list (backend owner) rather than adding a route.
Never send to Groq: the engine's inferred needs or labels, About you answers, audio (unless N7 is agreed), or
conversation history.

### 4.5 Saving and restoring preferences

- **Settings themselves:** only through `PreferencesProvider`:
  - preview (not kept) → "Keep it" (kept for this session, survives a refresh) → "Save" (the `cfe-prefs` cookie,
    a year, read by the server on first render);
  - Dial's "Keep and save" does both in one step;
  - restore with `sanitize()`;
  - reset with `resetToDefault()` or "Start the demo again".
- **The engine's own state** (consent, rejected suggestions, model cache markers):
  - `localStorage` under a key starting `cfe-access`, so "Start the demo again" and demo-user switching clear it,
    like every other app key;
  - wrap every read and write in `try/catch`; blocked storage must never break the app (see
    `lib/personalisation/state.ts`).
- **Nothing on the server.** There's no database; cookies are near their size budget; and accessibility inferences
  can be health-related (special category data). If server persistence is wanted later, it's a decision for the
  backend owner and needs its own consent.
- **The model files:**
  - load lazily after consent, never in the first page load (see `lib/personalisation/index.ts`, `loadModel()`);
  - cache them with the browser's Cache Storage, keyed by model version.

### 4.6 One engine for voice and text

This needs no voice changes. The voice engine already hands a finished utterance to `handle()` → `session.submit()`,
the same call typed text uses, so the hook in N2 covers both. Pass `input: "spoken"` when the text came from speech:
`voice-mode.tsx` knows (`heard.spoken`). Spoken mis-hearings are a reason to prefer `clarify` over `adapt` at the same
score. Clarification options are phrases, so the person can tap one or say it.

### 4.7 Conflicts and low confidence

**Confidence bands (starting values, to calibrate on an evaluation set like `docs/profile-model/UNSEEN-EVALUATION.md`):**

| Top score | Result | What the person sees |
|---|---|---|
| at least 0.75, and at least 0.15 above the runner-up | `adapt` | A preview with "Keep it" / "No" (never applied silently) |
| 0.50 to 0.75, or two readings within 0.15 | `clarify` | "Did you mean…" with 2 or 3 options; nothing changes |
| below 0.50 | `none` | Dial tries Groq; if that fails too, its existing "I didn't understand" reply |

**Conflicts:**

1. **Inside one request** ("bigger text but smaller buttons" is fine; "bigger and smaller" isn't). If two actions set
   the same setting to different values, `clarify`.
2. **With what the person set themselves.** A request in words is explicit, so it may change any setting, as a
   preview. A *proactive* suggestion must not undo something the person set in Display and voice: track the last
   kept change per setting from `subscribe()` (`source: "settings"`) and skip those settings.
3. **Between systems:** one display offer on screen at a time. Precedence:
   - a change the person just asked Dial for (an active Dial offer);
   - an active style or suggestion preview (`useStylePreview().active`, `usePreferences().preview`);
   - the engine's proactive suggestion;
   - the financial profile's display offer;
   - the random-forest suggestion.

   The Home cards already hide their offers while any preview is active; the engine should check the same two
   signals.
4. **View versus layout.** "Simple view" (`setMode`) and "calm" (`density`) overlap. Follow `displayTurn` in
   `plan.ts`: in Detailed view the simplest fix is Simple view; already in Simple view, calm plus step by step.

## 5. Conflicts with the financial-profile personalisation (PR #16)

| # | Overlap | Risk | Recommendation |
|---|---|---|---|
| P1 | About you has health needs (`reading`, `memory`, `sight_hearing`, `money_anxiety`) that sound like accessibility needs | Two systems learning the same thing under different consents; health data crossing systems | Keep them separate by default: the engine doesn't read About you, and About you doesn't read the engine. If they should share, agree it explicitly, with consent text that says so |
| P2 | The profile's display offer and the engine's suggestions both offer display changes | Competing offers | One offer at a time (section 4.7, point 3). Engine suggestions take precedence over the profile's display offer |
| P3 | The profile's offer uses `source: "ml"`, the same tag as the random-forest suggestion | Can't tell them apart in events | Fine for now (`ml` isn't counted by the random forest). If the engine counts sources, agree distinct tags (`"access"`, and optionally `"profile"`) |
| P4 | The profile changes Dial's **wording** server-side (`combineStyle()` in `lib/ai/ask.ts` merges the person's `answerStyle` / `explanations` preference with profile rules) | The engine might want shorter or plainer answers too | Set `answerStyle: "brief"` or `explanations: "stepByStep"` through the preferences store; they already reach Groq. Both sources can only add rules, never remove one |
| P5 | Profile Dial suggestion chips replace the default chips (see 6.1) | The "Make everything bigger" chip disappears for most profiles, so accessibility features become harder to discover | Fix agreed with the voice owner (6.1) |
| P6 | Demo-user switching clears `cfe-*` storage and the display cookie | Engine state is wiped on switch | Intended (a clean start per person). Use the `cfe-access` prefix so it's included |

## 6. Voice: review and conflicts

### 6.1 Review of the five lines in `components/voice/voice-mode.tsx` (PR #16)

```tsx
import { useProfile } from "@/lib/profile/provider";
// With About you tailoring on, the suggested questions follow the person's profile. They run through the same checked path as anything typed.
const { profile } = useProfile();
const tailored = profile?.consent ? profile.result?.adaptations.dialSuggestions : undefined;
const suggestions = tailored?.length ? tailored : SUGGESTIONS;
// ...and in the list: {suggestions.map(...)} instead of {SUGGESTIONS.map(...)}
```

- **Safe:** each chip calls the existing `handle(s)`, so it goes through `plan()`, validation and the same answer
  checks as typed text. No voice behaviour changes: recognition, consent, listening and speaking are untouched.
  Without the profile provider, `useProfile()` returns its empty default and the old list shows.
- **Problem 1, discoverability:** the tailored list *replaces* the default. Five of the six profile types have no
  "change how it looks" chip (only "Clear and simple" keeps "Make everything bigger"), so it disappears for most
  people with a profile.
- **Problem 2, merge conflict:** `claude/serene-rubin-2badwa` replaces `SUGGESTIONS` with `SUGGESTION_GROUPS`
  ("Ask about your money", "Go somewhere", "Change how it looks", "Plan ahead"). Merged after PR #16, it conflicts on
  these lines, and `SUGGESTIONS` no longer exists.
- **Minor:** the chips can change a moment after the panel opens, when the profile arrives.
- **Recommended resolution** (needs the voice owner's agreement; not applied):
  - render profile suggestions as an extra first group ("For you") on top of `SUGGESTION_GROUPS`;
  - always keep "Change how it looks";
  - remove duplicates between groups.

  This also gives the accessibility engine a natural place for its own group later.

### 6.2 Other voice conflicts

| # | Conflict | Recommendation |
|---|---|---|
| V1 | `claude/serene-rubin-2badwa` adds small talk inside `submit`'s "rules gave up" block, the same block the engine hook (N2) uses. It also sends unread text to `/api/ask` when Groq finds no action. That branch predates Groq (it still says "Gemini") | Agree one order for that block: rules → small talk → **engine** → `/api/dial` → `/api/ask` fallback. The engine must run before the `/api/ask` fallback, or display requests could be answered as money questions |
| V2 | `feat/dial-intelligence` has an older, diverged voice engine (`lib/voice/utterance.ts`, `use-voice.ts`) | Voice owner to confirm `feat/product-ux`'s `lib/voice/*` is current before anything builds on it |
| V3 | `lib/voice/types.ts` is a shared contract ("changes need agreeing") | The engine needs no voice contract change (4.6) |

### 6.3 Groq Whisper

Whisper reverses `docs/ARCHITECTURE.md` decision 1, so it needs the project lead's approval before anyone builds it.
If approved, the backend and voice owners would need to agree:

- **Consent:** its own explicit opt-in. Extending `speechInput` with a new value (e.g. `"groq"`) is a shared schema
  change. It must never be the default, and typing must always work.
- **Route:** `POST /api/transcribe` (N7), server-side only, through `lib/ai/groq.ts`. Needs:
  - a body cap (Vercel functions accept about 4.5 MB of request body);
  - the same per-visitor rate limit;
  - errors that keep only the status;
  - no logging of audio or transcripts.
- **Contract:** a new `RecognitionBackend` value, still handing over one finished `Utterance`, so everything
  downstream (including this engine) is unchanged.
- **Behaviour:** Whisper transcribes chunks, not a live stream, so live interim text and barge-in behave differently.
  The voice owner should decide.

## 7. File ownership

| Area | Files | Owner (as understood; please confirm) |
|---|---|---|
| Accessibility engine | `lib/access/*` (new), its tests and docs | Accessibility owner |
| Groq backend, `/api/ask`, `/api/dial`, the `/api/dial` action list | `lib/ai/*`, `app/api/ask`, `app/api/dial` | Backend owner (Alex) |
| Financial profile, About you, demo users | `lib/profile/*`, `lib/server/profile*.ts`, `app/api/profile/*`, `components/profile/*`, `lib/demo-users/*` | Backend owner (Alex, PR #16) |
| Display-suggestion model | `lib/personalisation/*`, `components/personalise/ml-suggestion.tsx` | Backend/ML owner (Alex, per `docs/HANDOFF.md`) |
| Preferences store (shared contract) | `lib/preferences/*`, `app/layout.tsx`, the CSS that reads `data-*` | Shared: changes agreed by the product owner |
| Dial planner and session (shared) | `lib/dial/*`, `components/dial/session.tsx`, `dial-reply.tsx` | Shared: Dial frontend; both voice branches touch them |
| Voice | `lib/voice/*`, `components/voice/*`, `components/dial/use-dial-voice.ts`, `voice-consent.tsx`, `lib/assistant/speech.ts` | Voice workstream (Delivery Claude) |

## 8. Dependencies

- **New package:** Transformers.js (`@huggingface/transformers`) in the browser only.
  - Package changes need approval.
  - Import it dynamically, after consent, so it isn't in the first-load bundle.
- **Model:** `all-MiniLM-L6-v2`, quantised (roughly 20 to 25 MB of ONNX weights).
  - Decide whether to serve the weights from the app (`/public`, which counts towards the deployment) or from the
    Hugging Face CDN (a third-party request at load time, which must be in the consent text).
  - Cache them in the browser by version.
  - Show a "Loading" state, never a blocked screen.
- **WebAssembly or WebGPU:** works in current Chrome, Edge, Firefox and Safari. If it fails to load, set status
  `"unavailable"` and carry on: Dial already works without the engine.
- **Nothing on the server:** no new route, environment variable or database for the core engine.

## 9. Implementation recommendations

1. **Start in `lib/access` with pure code and tests**, before any UI:
   - `classify()` with a fixed set of labelled example phrases per target (`UiAction` sets);
   - thresholds;
   - a `none` path for money and navigation;
   - an evaluation file with clear, ambiguous and conflicting phrasings, reported as they come out (like
     `UNSEEN-EVALUATION.md`).
2. **Make every result a validated step:** build the `DialStep`, run `validateStep()`, and drop anything it refuses.
3. **Agree N2 to N5 with the shared-file owners**, then add them as one small pull request against `feat/product-ux`
   (about 40 lines in total), separate from the engine.
4. **Consent:** an "Understand what I ask for" switch in Display and voice, off by default.
   - It says what loads (the model download) and that nothing leaves the device unless Dial asks Groq.
   - Withdrawing it deletes `cfe-access*`.
5. **Tests to add:**
   - typed and spoken text give the same steps;
   - nothing is applied without "Keep it";
   - low confidence asks;
   - money questions skip the engine;
   - engine unavailable means Dial unchanged;
   - only one offer on screen;
   - demo reset and user switch clear engine state.

   `scripts/test-demo-users-browser.mjs` shows the browser-test pattern.
6. **Run the existing suites unchanged:** `npm test`, typecheck, lint, build, `npm run test:http`, and the browser
   scripts. With `SESSION_SECRET` set, the Pay, Spend Pause and stage-6 browser scripts already fail on the baseline
   (`docs/BACKEND-AI.md`), so compare against the baseline, not against zero.

## 10. Decisions still needed

| # | Decision | Who |
|---|---|---|
| D1 | Approve the hook position (rules → small talk → engine → `/api/dial` → `/api/ask`) and N2 in `session.tsx` | Accessibility owner plus Dial frontend owner |
| D2 | Approve the "choices" reply (N3) | Dial frontend owner |
| D3 | Add `"access"` to `ChangeSource` (N4), tag Dial previews by origin (N5), and whether the random forest counts `"access"` changes | Product owner (preferences contract) plus backend/ML owner |
| D4 | Any new display settings (N6) | Product owner plus backend owner (Groq action list) |
| D5 | Confidence thresholds and the evaluation set they're calibrated on | Accessibility owner |
| D6 | Whether About you health needs and the engine's findings ever meet (P1) | Accessibility owner plus backend owner; needs consent text |
| D7 | Groq Whisper: reverse decision 1 or not; if yes, consent value, route and limits (6.3) | Project lead, then voice plus backend owners |
| D8 | The suggestion chip layout (6.1) and merge order of PR #16 and `claude/serene-rubin-2badwa` | Voice owner plus backend owner |
| D9 | The Transformers.js dependency and where the model weights are served from | Project lead / product owner |

## 11. Message for the voice owner (Delivery Claude)

Delivery Claude's session isn't reachable from this account, so this is a draft to post on PR #16 or pass on:

> PR #16 changes five lines in `components/voice/voice-mode.tsx`: when About you tailoring is on, the Dial panel's
> suggestion chips come from the person's profile instead of the fixed list. Chips still go through `handle()`, so
> nothing about recognition, consent or speaking changes. Two things need you:
> 1. `claude/serene-rubin-2badwa` replaces `SUGGESTIONS` with `SUGGESTION_GROUPS`, so whichever merges second
>    conflicts. Proposal: profile suggestions become a first "For you" group on top of your groups, and "Change how it
>    looks" always stays.
> 2. The accessibility engine will need one hook in `session.submit`'s "rules gave up" block, where your small-talk
>    change also goes. Proposed order: rules → small talk → accessibility engine → `/api/dial` → `/api/ask`. No change
>    to the voice engine or its contract is needed. Details: `docs/ACCESSIBILITY-INTEGRATION.md`, sections 3, 6 and 10.
