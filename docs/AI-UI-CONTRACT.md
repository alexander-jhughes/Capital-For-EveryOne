# AI to UI contract

`POST /api/ask`. Owner: AI backend. Changes to this file need agreeing with the frontend developer first.

## Request

```ts
{
  question?: string;   // Up to 300 characters. Missing means the default spending summary.
  state?: ClientState; // Optional. What has happened in the app. See "Live app state".
  previousQuestion?: string; // Optional, up to 300 characters. The question asked just before. See "Follow-ups".
}
```

`GET /api/ask` returns `{ gemini: "configured" | "not configured", model: string }`, so you can see whether answers can come from Gemini. It never includes the key.

### Follow-ups

**Proposed addition, backward compatible.** Send the question the person asked just before as `previousQuestion`, and short follow-ups are read against it:

| Previous | Follow-up | Answered as |
|---|---|---|
| "What did I spend at Tesco?" | "What about Argos?" | "What did I spend at Argos?" |
| "What's my biggest spending category?" | "And last month?" | "What's my biggest spending category last month?" |
| "How much did I spend on groceries?" | "How about eating out?" | "How much did I spend on eating out?" |

Only these elliptical shapes ("what about X", "how about X", "and X", "and last month") are rewritten. Any other question is answered on its own, and an unknown shop ("What about Lidl?") still gets "I can't tell". A `previousQuestion` that isn't a string, or is over 300 characters, is a 400. Leaving it out changes nothing.

## Response

```ts
type AskIntent = "statement_balance" | "spending_insights" | "subscription_query" | "transaction_investigation" | "payment_planning" | "general";
type UiTemplate = "statement" | "spending" | "subscriptions" | "transaction" | "payment" | "general";
type Confidence = "high" | "medium" | "low";

interface Experience {
  template: UiTemplate;
  intent: AskIntent;
  confidence: Confidence;
  periodLabel?: string;  // The month the answer covers, such as "November 2026"
}

interface OrchestratedResponse {
  answer: string;
  evidenceIds: string[];
  source: "model" | "template" | "cache";
  experience?: Experience;
}
```

The types are exported from `lib/ai/experience.ts`, with a validator, `parseExperience`. `AskResponse` in `lib/types.ts` is unchanged.

**Compatibility:** `answer`, `evidenceIds` and `source` mean what they always did. `experience` is optional, so treat it as possibly missing and fall back to the general chat view.

### Errors

Unchanged. HTTP 400 or 500 with `{ "error": "<friendly message>" }`, and no `experience`.

## Live app state

**Proposed, not yet agreed with the frontend developer.** It's optional, so nothing breaks until it's used. Without it, Dial answers from the seed data.

Send what has happened, not the resulting balances. The server works out every figure itself.

```ts
interface ClientState {
  spendPause?: SpendPauseSettings;  // The settings as they are now
  purchases?: { id: string; date: ISODate; merchant: string; amount: Pence }[];  // Approved purchases
  payments?: { id: string; date: ISODate; amount: Pence }[];                     // Payments made
}
```

| Rule | Detail |
|---|---|
| IDs | New only, not seed IDs, letters, numbers and hyphens, no repeats |
| Amounts | Whole pence, above 0, up to £100,000 |
| Dates | Real `YYYY-MM-DD` dates, not after the demo date |
| Shop names | Letters, numbers and `' & . -`, up to 40 characters |
| Size | Up to 50 events. Payments can't exceed what's owed |

A state that breaks any rule is refused whole, with HTTP 400 and `{ "error": "..." }`.

**What the server does with it:**

| Event | Effect |
|---|---|
| Payment | `currentBalance` and `statementBalance` go down (statement not below £0), `lastPayment` updates, a pending `Payments` transaction is added. The minimum is capped at what's left of the bill |
| Purchase | `currentBalance` goes up, and a pending `Shopping` transaction is added |
| `spendPause` | Replaces the seed settings |

Evidence IDs for these events are the IDs you sent, so they match your transactions.

**Client change needed:** in `askDial`, send the state with each question. For example, from `useAccount()`:

```ts
body: JSON.stringify({ question, state: { spendPause: settings, purchases, payments } })
```

`purchases` and `payments` need exposing from account state: Stage 6B has the purchases, and Pay doesn't exist yet.

## Templates

Each intent has exactly one template. The table is fixed in code, so the model can't choose or change it.

| `template` | `intent` | Example | Evidence |
|---|---|---|---|
| `statement` | `statement_balance` | "How much do I owe?" | Empty: account-level figures |
| `spending` | `spending_insights` | "How much did I spend at Argos?", "What's my biggest spending category?" | The transactions behind the total, or only the categories asked about |
| `subscriptions` | `subscription_query` | "What subscriptions am I paying for?" | Latest charge for each, or the two charges for a price change |
| `transaction` | `transaction_investigation` | "Where is my Amazon refund?" | The refunds or charges, with the purchases they reverse |
| `payment` | `payment_planning` | "When is my next payment due?", "Did my payment go through?" | Empty for bill figures. The payments themselves for payment history |
| `general` | `general` | Everything else, including Spend Pause | Usually empty. Spend Pause answers have none |

## Reading `confidence`

| Value | Meaning |
|---|---|
| `high` | Rules matched, or the model was sure |
| `medium` | The model's best reading. The figures are still validated |
| `low` | Dial is asking for clarification, or couldn't place the question. The template is `general` and evidence is empty |

**"I can't tell":** when the facts don't cover a question, `template` is always `general`, with no evidence.

**Transaction with nothing to show:** if nothing was found, such as no refund from that shop, `template` is `general`, not `transaction`, so the `transaction` card always has real `evidenceIds`.

**Clarification:** there's no separate flag. `answer` holds the question to ask, `evidenceIds` is empty, and `experience` is `{ template: "general", intent: "general", confidence: "low" }`. Show it as a normal reply.

## Examples

```json
{
  "answer": "Your £19.99 Amazon refund for your purchase on Tuesday 3 November is pending, so it has not arrived yet. Your £14.99 Amazon refund for your purchase on Wednesday 21 October arrived on Thursday 29 October.",
  "evidenceIds": ["t062", "t061", "t036", "t028"],
  "source": "template",
  "experience": { "template": "transaction", "intent": "transaction_investigation", "confidence": "high" }
}
```

```json
{
  "answer": "You have spent £402.35 so far this month.",
  "evidenceIds": ["t042", "t043"],
  "source": "cache",
  "experience": { "template": "spending", "intent": "spending_insights", "confidence": "high", "periodLabel": "November 2026" }
}
```

(Evidence shortened in the second example.)

## Rules for the UI

- **`answer` is plain text.** Never render it as HTML. The backend rejects replies containing markup, but text rendering is the second line of defence.
- **Figures for a template come from the finance layer on the client**, as they do now, using `evidenceIds` to pick rows. The response has no figures outside `answer`.
- **Don't branch on `source`** for anything about accuracy. All three are validated.
- **An unknown `template` means `general`.** Validate with `parseExperience`.

## Frontend

PR #9 reads `experience` in `lib/assistant/experience.ts`, with the same six templates and six intents. Extra fields such as `confidence` and `periodLabel` are ignored there.

## How a question is answered

1. **Agent 1, interpreter (`lib/ai/interpreter.ts`):** rules first. Gemini only picks a label from a fixed list, and only if the rules can't tell. Vague or low-confidence questions get a clarification.
2. **Agent 2, template selector (`lib/ai/experience.ts`):** a fixed table.
3. **Agent 3, finance validator (`lib/ai/validator.ts`, `lib/ai/guard.ts`):** checks every response, including cached and template ones. Amounts, dates, names, balances, statuses and evidence must match the facts. Anything else falls back to a template, then to "I can't tell that from your transactions."

Gemini never calculates, chooses evidence, or chooses a screen. At most two Gemini calls per question, and most questions use one or none.
