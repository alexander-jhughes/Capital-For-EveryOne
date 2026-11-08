# Accessibility engine

People tell Dial what they need, in their own words, by typing or by voice: "I can't use a mouse", "this screen is
overwhelming", "make the important information stand out". Dial works out what would help, previews it with a reason
for each change, and keeps it only when they say "Keep it". Every change can be undone, turned off on its own, paused
for a visit or reset. Nothing it does can change a figure, a payment or Spend Pause.

## 1. Where it came from

Samrath Arora built the core on `feat/groq-adaptive-access` (open PR #15, never merged). The audit
(November 2026) found it real and working: its tests, typecheck and lint pass, and `npm run access:eval` reproduced its
published blind-test figure (46/52) exactly. Three of its commits were cherry-picked here with authorship kept:

| Commit | What it brings |
|---|---|
| `1de9e33` → `d7208b8` | `lib/access`: situation catalogue, on-device sentence model, routing, evaluation; new settings (easier reading, colour-safe, voice speed, auto read-aloud, thumb reach, tap guard, vibration, night look); the `adapt` Dial step |
| `fe8a3c4` → `baa422b` | Keeps Transformers.js out of the webpack bundle (first page load was minutes) |
| `24b042e` → `98db0e7` | Changes land one at a time in the preview; the measured-accuracy note on Dial's card |

Not taken from PR #15: Groq Whisper (`da09593`, voice input: the voice workstream, and it sends audio to Groq, which
needs its own opt-in), small talk (`29e993a`, Dial conversation) and the credit-building coach (`9a3cea0`, not
accessibility). Its Gemini-to-Groq migration was already ported by `4b5da91`.

## 2. How it works

```
typed or spoken text (voice engine gives text)                       components/dial/session.tsx
   │
   ├─ clarify()          contradictory or vague? ask, change nothing    lib/access/clarify.ts
   ├─ adaptationFor()    a described need? on-device sentence model     lib/access/pipeline.ts, understand.ts, route.ts
   │                     → situations from a fixed catalogue             lib/access/catalogue.ts
   ├─ plan()             precise rules: commands, pages, money          lib/dial/plan.ts, lib/voice/interpret.ts
   └─ /api/dial (Groq)   only if both gave up; returns allowlisted       lib/ai/command-model.ts
                          settings or a catalogue situation, then
                          withoutProtectedHides()                        lib/access/safety.ts
   │
   ▼
validateStep()  →  runner: preview  →  "Keep it" / "No" / undo         lib/dial/registry.ts, runner.ts
   │
   ▼
PreferencesProvider: preview → kept (this visit) → saved (cookie)       lib/preferences/provider.tsx, schema.ts
   │                 + night look, + pause
   ▼
data-* attributes on <html>  →  CSS in app/globals.css; Home layout from visibleWidgets()
```

| Layer in the brief | Where |
|---|---|
| A. Understanding | `clarify.ts` (asks), `understand.ts` + `brain.ts` (all-MiniLM-L6-v2, 8-bit, in the browser, nothing sent anywhere), `route.ts` (who gets the sentence), `interpret.ts` (precise rules), Groq fallback |
| B. Preference model | `lib/preferences/schema.ts`: one typed `Preferences`, `sanitize()` rebuilds it from any untrusted input |
| C. Adaptation planner | `catalogue.ts`: each situation is a fixed list of `UiAction`s with a reason; `changesFor()` merges them, one per setting |
| D. Executor | `applyActions()` (pure), `PreferencesProvider`, `prefAttributes()` and the CSS; never DOM edits or model-written styles |
| E. Control | Preview and Keep it, undo, "I changed my mind", Turn off per change, pause, reset (Settings and Dial) |

A model never picks a setting value: the on-device model and Groq can only name a situation from the catalogue
(`validateStep` rejects anything else), and Groq's direct settings go through the same allowlist. There is no path from
any model to CSS, HTML or code.

## 3. What people can say

Verified by `lib/access/requests.test.ts` (real model) unless marked.

| Request | Result |
|---|---|
| Make everything bigger / Everything is too small / Make the app easier to read | Text one step bigger |
| I can't see the text | Stronger contrast |
| This screen is overwhelming / There's too much going on here / Make the dashboard simpler / Make the app less complicated | Calmer Home (Simple view if in Detailed for "less complicated") |
| I want fewer things on the screen | Asks "did you mean too much on screen makes it hard to focus?" |
| I struggle with small buttons / my hands shake so I keep pressing the wrong button | Bigger buttons, tap guard, more space, voice first |
| I don't want animations | Animations off |
| I want to use voice instead / Give me a voice-first experience | Talking to Dial first |
| Make the important information stand out | Bill at the top, highlighted, stronger contrast |
| Can you make it easier to navigate? / I can't use a mouse | Thick focus outline, bigger targets, calmer Home |
| I changed my mind | Undo (with a preview showing: withdraws only the preview) |
| Switch to Simple Mode / Read this explanation aloud | Existing view switch / read aloud |
| make the text bigger and turn off animations and give everything more space | All three, one preview |
| make the text bigger, no I meant smaller | Only the correction |
| make it better / change it | "What would help?" with real options |
| make the text bigger and smaller | "Do you want it bigger or smaller?" |
| make the background purple / use comic sans | Nothing changes (said back as not understood) |
| run this css: … / `<script>` | Nothing changes |
| turn off Spend Pause | Dial says it can't, links to the screen that confirms it |
| I can't see my refund / how much did I spend at night? | Money question; the look never changes |

Plus Samrath's described situations, 18 in all (`lib/access/catalogue.ts`):

| Situation | Dial hears | Default scope | Changes |
|---|---|---|---|
| `night_vision` | Seeing the screen at night is hard | night | dark, stronger contrast, text 150% |
| `low_vision` | Seeing the screen is hard | always | text 200%, stronger contrast, bigger buttons, more space |
| `screen_reader` | You use your voice or a screen reader | always | voice first, auto read-aloud, short answers, calmer Home |
| `colour_vision` | Telling some colours apart is hard | always | colour-safe palette, stronger contrast |
| `reading` | Reading is hard | always | easier reading spacing, short answers, step by step, text 125% |
| `dexterity` | Pressing small buttons accurately is hard | always | bigger buttons, tap guard, more space, voice first |
| `one_handed` | You're using one hand | now | thumb reach, bigger buttons |
| `bright_light` | It's bright where you are | now | light, stronger contrast, text 150% |
| `light_sensitivity` | Bright or moving things are uncomfortable | always | dark, no animation, standard contrast |
| `focus` | Too much on screen makes it hard to focus | always | calmer Home, no animation, short answers |
| `memory` | Remembering things can be hard | always | step by step, short answers, calmer Home, tap guard |
| `money_worry` | Looking at money can feel stressful | always | bill at the top, short answers, calmer Home |
| `hearing` | Hearing Dial isn't reliable for you | always | no auto read-aloud, typing first, vibration |
| `slow_speech` | Dial talks too fast | always | slower voice, short answers |
| `second_language` | English isn't your first language | always | step by step, short answers, slower voice |
| `navigation` (new) | Getting around the app is hard | always | thick focus outline, bigger targets, calmer Home |
| `key_info` (new) | You want the important things to stand out | always | bill at the top and highlighted, stronger contrast |
| `voice_preference` (new) | You'd rather talk than tap or type | always | voice first, one sentence per tap |

Time words set the scope: "at night" keeps it as a night look (7pm to 7am), "right now" for this visit only, otherwise
the situation's default. `money_anxiety` was renamed `money_worry`: Alex's privacy test checks that no profile word
like "anxi…" reaches Groq, and the catalogue's id was in the fixed `/api/dial` prompt.

## 4. Settings

Everything Dial can change is also on Display and voice (`/account/settings`), by touch and keyboard. New here:

- **Your changes**: every change that is on, in plain words, each with **Turn off**. Changes made by Dial, Settings or
  "Make it yours" all appear the same way (`lib/access/active.ts`).
- **Pause my changes for this visit**: the standard look until they turn it back on or the tab closes; nothing kept
  or saved is lost. Microphone consent and setup choices stay. Any new preview or change ends the pause.
- **Keyboard focus**: a thick outline (5px, with a halo in the page colour) for keyboard and switch users
  (`focusRing`, `data-focus-ring`).

## 5. Safety

- **The bill stays on Home.** A calmer Home keeps its first three sections plus the bill, wherever it was moved
  (`ESSENTIAL_WIDGETS` in `schema.ts`). Spend Pause and Pay keep their own tabs in the main navigation at all times.
- **Nothing hides the bill, Spend Pause or Dial's warnings by itself.** No catalogue situation hides a section (tested),
  and a Groq step that tries is cut down with a plain note (`safety.ts`). Only the person's own explicit "hide …" does
  it, and that is still a preview that needs "Keep it" and can be undone.
- **The look can't change money.** Preferences only produce `data-*` attributes and a Home order. Nothing in
  `lib/finance` reads preferences (tested), Dial steps can't pay or change Spend Pause (`validateStep`), and "turn off
  Spend Pause" only links to the screen that confirms it.
- **No diagnosis is stored.** Only the settings a person keeps are saved, never what they said or which situation was
  heard. Nothing assumes a disability: "I can't use a mouse" changes the outline, it doesn't label anyone.

## 6. Groq

Groq is used only through Alex's existing `/api/dial` interface (`lib/ai/command-model.ts`, `lib/ai/groq.ts`), and only
when the on-device model and the rules both gave up. Samrath's commit extended its prompt and schema so Groq can name a
catalogue situation or one of the new settings; everything Groq returns passes `toSteps` and `validateStep`, and now
`withoutProtectedHides`. Without a key, or when Groq is busy or fails, the on-device model and rules still work and
Settings is unaffected. No second AI client was added. Note: `focusRing` is not in Groq's display list (that file is
Alex's); Groq reaches it through the `navigation` situation.

## 7. Dial text and voice

Text and voice go through the same `submit()`: the voice engine gives Dial text, so everything
above works by voice with no change to the voice engine. Spoken-style transcripts (no punctuation, fillers) are tested.
Samrath's settings that affect speech (voice speed, auto read-aloud, vibration) are wired into `use-speaker.ts`,
`read-aloud.tsx`, `pause-check.tsx` and `voice-mode.tsx` by its cherry-picked commit.

## 8. Undo and reset

| Action | Effect |
|---|---|
| "No, leave it" / "no" | The preview goes; nothing changed |
| "Undo" / "I changed my mind" with a preview showing | Same as "no" (fixed here: it used to also undo the change kept before it) |
| "Undo" / "I changed my mind" | The last kept change is undone, this visit |
| Turn off (Settings) | That one change back to standard |
| Pause my changes | Standard look for this visit, nothing lost |
| Reset to default (Settings, confirmed) / "reset" (previewed) | Everything back to standard, saved settings cleared |

## 9. Tests

| Command | Result (8 Nov 2026, Windows, Node 24) |
|---|---|
| `npm test` | 66 files, 2,072 tests passed (baseline before this work: 61 files, 1,985 passed) |
| `npm run typecheck` / `npm run lint` / `npm run build` | Pass / pass / pass |
| `npm run access:eval` | See below; writes `docs/ACCESS-EVALUATION.md` and `lib/access/accuracy.json` |
| `npm run test:access` (browser, production build) | 32 checks passed |

New tests: `lib/access/engine.test.ts` (safety, hostile model output, clarification, your changes, Turn off, pause,
focus ring, cookie size, finance never reads preferences), `lib/access/requests.test.ts` (the requests in section 3
through the session's decision, real model), and an undo-during-preview case in `lib/dial/runner.test.ts`.
`scripts/test-access-browser.mjs` drives the real app: understand, preview, keep, undo, clarify, refuse, Spend Pause,
calmer Home with the bill kept, Settings list, Turn off and pause, keyboard focus ring, axe (WCAG 2.2 AA) on Settings,
no sideways scrolling at 200% text in Simple and Detailed, light and dark, no console errors. The first reply after
opening Dial took 0.9 s in headless Chromium on this machine, all model files loaded within 1.4 s.

To run it: `npm run build`, then `SESSION_SECRET=<32+ chars> npx next start -p 3100`, then
`BASE_URL=http://localhost:3100 npm run test:access`.

**Evaluation, honestly.** Adding three situations changed Samrath's measured figures. Blind set now 77 sentences
(68 + 9 written for the new situations before the first run). First run: 85% exactly right, but one sentence that
isn't a situation was offered one ("I'm not colour blind, I just want a summary" → key_info, asked as a question), and
one in the development set ("turn the buttons gold" → dexterity). The catalogue was then changed for the development-set
errors only, plus three money examples about summaries, which were prompted by the blind-set error, so the blind set is
no longer fully blind for that one change. Final: blind 83% exactly right (49/59), 0 of 18 non-situations hijacked;
development 84% (97/116), 0 of 34. The new `voice_preference` situation costs two screen-reader sentences in the blind
set ("I use voice over on my iPhone" → voice preference; "I can't see, so please talk to me" → both), which still
make talking to Dial first but don't switch on auto read-aloud. On Samrath's original 52 blind sentences alone the score
is 44/52 (85%, was 88%). The blind set was not edited apart from the label rename and the nine appended sentences.

**Seen sentences.** Some test sentences are also catalogue examples, so for them the model is recalling, not
generalising: 1 blind sentence ("I'm hard of hearing", from the original set; `ACCESS-EVALUATION.md`'s line "none of
these sentences appear in the catalogue" is not quite right), 2 development sentences, and 6 of the 33 phrases in
`requests.test.ts`. Four of those are the brief's own phrases, added as examples for the new situations ("I want to use
voice instead", "Give me a voice-first experience", "Make the important information stand out", "I can't use a
mouse"); their passes show the wiring works, not that the model understands new wording. Separately, the keyword-rule fix for "I can't see my
refund" halved how often the old rules restyle the app for a money question or small talk in the blind set (18% → 9%).

Pre-existing and unrelated: the two randomised backend-parity tests can time out when the whole suite runs alongside
the embedding model; they pass on their own (the voice branch already raised one timeout to 60 s).

## 10. Limitations

- Page-specific preferences are not implemented: changes apply app-wide (scope is night, now or always).
- Pause lives in this tab's session storage; after a reload the server renders the kept look for a moment first.
- Corrections without a pause or filler ("bigger no I meant smaller") aren't split by the shared correction module,
  so Dial asks "bigger or smaller?" rather than acting. Safe, but one extra turn.
- The on-device model is ~23 MB (plus a 14 MB WebAssembly runtime), loaded when Dial is first opened, never on page load.
  Alex's integration checklist (`docs/BACKEND-AI.md`, section 10) asks for loading "lazily after consent"; it is lazy,
  but there is no separate consent step for it, because nothing leaves the device. That call is the team's.
- The catalogue's English is British and informal; other languages aren't understood.
- `voice_preference` overlaps `screen_reader` for some sentences (section 9).
- Keyboard navigation relies on the app's existing semantic HTML and skip link; there are no new keyboard shortcuts.

## 11. Files, ownership and integration

Mine (accessibility): `lib/access/*`, `lib/preferences/*`, `components/settings/display-settings.tsx`,
`app/globals.css` (focus ring), `scripts/access/*`, `scripts/test-access-browser.mjs`, `docs/ACCESS-EVALUATION.md`, this file.

Shared files touched, small and listed so their owners can review:

| File | Owner | Change |
|---|---|---|
| `components/dial/session.tsx` | Dial / voice | Samrath's adapt wiring; here: clarify first, hide the rules' "Understood" when a situation answered, Groq steps through `withoutProtectedHides` |
| `lib/dial/runner.ts` | Dial | Samrath's adapt step; here: undo with a preview showing means "no" |
| `lib/dial/registry.ts`, `types.ts` | Dial | Samrath's adapt step and settings; here: `focusRing` in the allowlist |
| `lib/dial/plan.ts` | Dial | "less complicated / less confusing" join the existing simplify rule |
| `lib/voice/interpret.ts` | Voice rules | "I've changed my mind" → undo; "easier to read" → bigger text; "can't see" isn't contrast when it's about money |
| `lib/ai/command-model.ts` | Alex | Samrath's commit only: Groq may name a situation and the new settings |
| `components/dial/use-speaker.ts`, `voice/voice-mode.tsx`, `pause-flow/*`, `lib/assistant/speech.ts` | Voice | Samrath's commit only: voice speed, auto read-aloud, vibration |

After changing the engine, run `npm install` (adds `@huggingface/transformers`; `postinstall` copies the browser runtime into `public/`), then
`npm test`, `npm run access:index` if the catalogue changed, and `npm run test:access`. Nothing here needs new
environment variables, a database or deployment changes.
