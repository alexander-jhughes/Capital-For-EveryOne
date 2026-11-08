# Testing Dial's voice

Dial's voice has only been tested with a fake speech recogniser, in unit tests and in a real browser. It has **not** been
tested with a real microphone or a real recogniser. This document says what that proves, what it doesn't, and how a
person checks the rest with a real microphone.

If the voice engine or panel changes, recheck the timings and known
gaps below.

## 1. Speech recognition by browser

The app uses the browser's own recogniser (`lib/assistant/speech.ts`, `lib/voice/engine.ts`). There is no Whisper or
other hosted speech service in the app. The language is always `en-GB`.

The middle columns are what the code does. The browser facts in the last column haven't been confirmed on real devices:
use the checklist in section 4 to confirm them.

| Browser | API found | "Online speech service" chosen | "On this device only" chosen | Notes to confirm |
| --- | --- | --- | --- | --- |
| Chrome, desktop | `SpeechRecognition` or `webkitSpeechRecognition` | Starts at once. Audio goes to Google | Sets `processLocally`. If the language pack is missing, the app explains and offers the online service | The panel says on-device needs Chrome 139 or newer |
| Edge, desktop | Same | Same code. Audio goes to Microsoft | Same code | Does Edge honour `processLocally`? |
| Chrome, Android | `webkitSpeechRecognition` | Same code. Audio goes to Google | Same code | Sessions end after each phrase. The engine restarts them and keeps the words |
| Safari, macOS and iOS | `webkitSpeechRecognition` | Same code. Apple's service | No `processLocally`, so the engine reports `language-unavailable` and the app offers the online service | The panel's notice names only Chrome's provider |
| Firefox | None | No microphone button | No microphone button | The panel says voice isn't available. Typing works |

Reading answers aloud is separate and uses `speechSynthesis`, shown only where the browser has it.

## 2. Privacy

**Audio.** The app never records or stores audio. No code uses `MediaRecorder`, `getUserMedia` or `AudioContext`. The
browser handles the microphone and gives the app text.

**Online recognition.** With the online service, the browser sends the audio to its maker, directly. It doesn't pass
through this app's server.

**Consent, as it works today.** A line next to the microphone always says speech goes to the browser's speech service
(the "Before Dial listens" panel with all three choices is not shown on first use). On a new device, the first tap starts the online service straight away and saves that
choice (`components/dial/use-dial-voice.ts`). The browser's microphone prompt still appears. So online recognition is
disclosed, but it is **not** a separate opt-in before the first use, which is what `docs/ARCHITECTURE.md`
describes. Display and voice can change the choice.

**What reaches the server and Groq.** Only finished text is sent: interim words never are, and most requests are
answered on the device with no network call.

| Route | Sent from the browser | Passed to Groq |
| --- | --- | --- |
| `POST /api/ask` | The question, the previous question, answer style, and purchases and payments made since the demo data, with Spend Pause settings | The question and the facts for that one answer (amounts, dates, shop names), plus up to four fixed wording rules if the person has a profile |
| `POST /api/dial`, only when the on-device rules give up | The words (up to 300 characters), page, view and text size | The same. No account data |

So Groq sees more than the question: it also sees the facts it words. `docs/BACKEND-AI.md`, section 6, has the detail,
and tests in `lib/server/backend-integration.test.ts` pin the request bodies.

Transcripts are held in memory only by the voice engine, the panel and the session. The server doesn't log questions or
answers.

## 3. What the automated tests cover

They are **mocked**. A fake recogniser and a fake clock feed text into the real code. No sound is involved.

| File | Covers |
| --- | --- |
| `lib/voice/engine.test.ts` | Engine states, pause timing, restarts, errors, echo, barge-in, switching tabs |
| `lib/voice/transcript.test.ts` | Live transcript, continuation words, stop words, echo matching |
| `lib/voice/interpret.test.ts` | Spoken requests to display settings, navigation and controls |
| `lib/dial/plan.test.ts`, `segment.test.ts` | Text to validated steps |
| `lib/dial/runner.test.ts` | Previews, "Keep it", cancelled turns, stale results |
| `lib/dial/conversation.test.ts` | The brief's spoken examples, end to end through the on-device pipeline, and a correction spoken while the first question is still with the backend |
| `scripts/test-voice-browser.mjs` (`npm run test:voice`) | The real Dial panel in Chromium, at desktop and phone width and at 320px with 200% text: live words, pause and resume, Send, Edit and Cancel while paused, the microphone indicator in continuous mode, push-to-talk, permission denied, closing while paused, focus, overflow, axe. The recogniser and speech output are **simulated** in the page |

They can't tell you whether a recogniser hears the words correctly, how pauses feel, whether the speaker's sound is
heard as echo, how permission prompts behave, or anything about Groq's wording.

### Known gaps

| Gap | File that would change |
| --- | --- |
| "Explain that more simply" after a chart: the backend isn't told what "that" is, and no setting is offered (`it.todo`) | `lib/dial/plan.ts`, `lib/ai` |
| Requests the rules give up on go to Groq through `/api/dial`, which these tests don't cover. "Show me the biggest one" with nothing before it is one | `lib/ai/command-model.ts` |
| The words can't be edited while listening: the box is read-only, and they send after a pause. Tap `Pause` first, then `Edit` | `components/voice/voice-mode.tsx` |
| On a new device the first tap starts the browser's online speech service and saves that choice. It is disclosed next to the microphone, but it isn't a separate opt-in as `docs/ARCHITECTURE.md` describes. Needs the consent owner's decision | `components/dial/use-dial-voice.ts` |
| "Wait." with Dial silent turns the microphone off, like "Stop." A waiting preview is withdrawn | `components/voice/voice-mode.tsx`, `lib/dial/runner.ts` |

## 4. Microphone checklist

Record the date, tester, browser and version, device, microphone or speaker, and which speech option was chosen. Repeat
for each browser in section 1. Use the demo account, in a browser profile with no saved settings for the first row.

Timings are the current defaults: an utterance ends after 1.1 seconds of quiet, or 2 seconds after a word like "and".

### Starting

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 1 | New profile. Read the line next to the microphone, then tap it | The line names the speech service. The browser asks for the microphone. Nothing listens before the tap | ☐ | ☐ |
| 2 | Block the microphone in the browser, then tap | A plain message says how to allow it. Typing still works | ☐ | ☐ |
| 3 | Allow the microphone again, then tap | Listening starts without reloading | ☐ | ☐ |
| 4 | Choose "On this device only" in Display and voice, without the language pack, then tap | A notice explains, and offers the online service or typing | ☐ | ☐ |

### Speaking

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 5 | Normal pace: "How much did I spend on groceries in October?" | Words appear live. A Groceries chart for October, read aloud | ☐ | ☐ |
| 6 | Slowly: "How much did I spend on... groceries", with a 1.5 second gap after "on" | Stays one question | ☐ | ☐ |
| 7 | Slowly, gaps of about 1.5 seconds: "What is... my bill... this month" | Note where it cuts off. It may, because no gap follows a continuation word | ☐ | ☐ |
| 8 | As fast as you can: "Show my spending for October, compare it with September, and make the interface simpler" | Spending for October, then the comparison, then a preview | ☐ | ☐ |
| 9 | With a radio or café noise nearby, repeat row 5 | Same answer. Note any wrong words | ☐ | ☐ |
| 10 | With that noise on, say nothing for 30 seconds in continuous listening | Nothing is sent by itself. Note anything that is | ☐ | ☐ |
| 11 | Three or more people with different accents repeat rows 5 and 13, and say "Sainsbury's" and "Deliveroo" | Same results. Note wrong words and who said them | ☐ | ☐ |
| 12 | Tap the microphone and say nothing | After about 8 seconds, "I didn't hear anything". In continuous listening it stops after about 2 minutes | ☐ | ☐ |

### Corrections and several instructions

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 13 | "How much did I spend on restaurants? Actually, groceries." | Groceries only. No restaurants answer | ☐ | ☐ |
| 14 | "How much did I spend on groceries in September? No, I meant October" | Groceries, October | ☐ | ☐ |
| 15 | "Show my Sainsbury's transactions, change that to Tesco" | Spending, filtered to Tesco | ☐ | ☐ |
| 16 | "How much did I spend on groceries? Sorry, eating out" | Eating out only | ☐ | ☐ |
| 17 | "How much did I spend on food", wait for the answer, then "actually, groceries" | Groceries only | ☐ | ☐ |
| 18 | "I actually want to see my balance" | Your balance on Home. Nothing is treated as a correction | ☐ | ☐ |
| 19 | "Hide the chart and put my bill at the top" | One preview with both changes | ☐ | ☐ |
| 20 | "How much did I spend on groceries and eating out?" | One request, two charts | ☐ | ☐ |

### Follow-ups and repeats

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 21 | "How much did I spend on groceries?", then "What about last month?" | Groceries, October | ☐ | ☐ |
| 22 | Then "Has that increased?", then "Show me the biggest one." | A groceries comparison, then the biggest groceries purchase | ☐ | ☐ |
| 23 | Close and reopen the page, then say "Why?" | Dial doesn't invent a subject | ☐ | ☐ |
| 24 | Ask "Is my spending OK?" twice | The same answer, faster. The browser's Network tab shows no second `/api/ask` | ☐ | ☐ |

### Interrupting

Use speakers, not headphones, so echo is tested too.

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 25 | While Dial reads a long answer, stay silent | It reads to the end. Its own voice isn't taken as you speaking | ☐ | ☐ |
| 26 | While it reads, say "Stop." | Speech stops at once. Nothing new is asked | ☐ | ☐ |
| 27 | While it reads, ask "What about last month?" | Speech stops, and the new question is answered | ☐ | ☐ |
| 28 | With Dial silent, say "Cancel." then, after tapping again, "Wait." | Each stops listening. Neither shows an error | ☐ | ☐ |
| 29 | "How much did I spend at the bus stop" | A transport answer. Nothing stops | ☐ | ☐ |

### Changing the interface

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 30 | "Make everything bigger." then "Keep it" | A preview first, and it stays only after "Keep it" | ☐ | ☐ |
| 31 | "Use fewer numbers." then "No" | A preview, then back as it was | ☐ | ☐ |
| 32 | "Stop reading long explanations." | A preview of shorter answers. Reading doesn't stop as a command | ☐ | ☐ |
| 33 | "Start again." then "No" | A preview of the original look, then back as it was | ☐ | ☐ |
| 34 | "Make everything bigger.", then close the panel | The preview is withdrawn | ☐ | ☐ |
| 35 | "Pay my bill", then "Turn off Spend Pause" | Pay opens and nothing is paid. Spend Pause stays on until you confirm it on its screen | ☐ | ☐ |

### Failures, tabs and fallbacks

| # | Say or do | What should happen | Pass | Fail |
| --- | --- | --- | --- | --- |
| 36 | With the online service, turn off the network, then tap and speak | A plain message says the speech service can't be reached. Typing still works | ☐ | ☐ |
| 37 | Turn the network off during an answer from the backend | A failure is shown as a failure, never as an answer. Nothing hangs | ☐ | ☐ |
| 38 | Switch to another tab in the middle of a sentence | Listening stops. The unfinished words aren't sent | ☐ | ☐ |
| 39 | Switch tabs while Dial is reading | Reading stops. Come back and tap the microphone to carry on | ☐ | ☐ |
| 40 | Say "Make everything", tap `Pause`, wait a minute, tap `Resume`, say "bigger" | While paused the status says the microphone is off and the browser's microphone indicator goes out. After Resume, one question, "Make everything bigger" | ☐ | ☐ |
| 40a | Say "How much did I spend at", tap `Pause`, then `Edit`, type "Tesco", press Enter | The words move to the text box for editing. The edited question is answered | ☐ | ☐ |
| 40b | In continuous listening, ask "How much did I spend at Tesco?" and, while Dial is thinking or speaking, check the panel | It says "Microphone on" the whole time, and `Pause` closes the microphone | ☐ | ☐ |
| 40c | Ask "How much did I spend at Sainsbury's?" and, before the answer appears, say "No, I meant Tesco" | Only a Tesco answer appears | ☐ | ☐ |
| 41 | After a spoken question, tap `Edit`, change a word, then send | The changed text is answered on screen, not read aloud | ☐ | ☐ |
| 42 | Open the panel in Firefox | No microphone button. A typed question gets the same answer as a spoken one | ☐ | ☐ |
| 43 | Choose "I'll type instead" | Voice stays off. Tapping the microphone offers the choice again | ☐ | ☐ |
