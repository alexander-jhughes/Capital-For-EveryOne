# AI to UI contract

`POST /api/ask`. Owner: AI backend. Changes to this file need agreeing with the frontend developer first.

## Request

```ts
{ question?: string }  // Up to 300 characters. Missing means the default spending summary.
```

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

## Templates

Each intent has exactly one template. The table is fixed in code, so the model can't choose or change it.

| `template` | `intent` | Example | Evidence |
|---|---|---|---|
| `statement` | `statement_balance` | "How much do I owe?" | Empty: account-level figures |
| `spending` | `spending_insights` | "How much did I spend at Argos?" | The transactions behind the total |
| `subscriptions` | `subscription_query` | "What subscriptions am I paying for?" | Latest charge for each, or the two charges for a price change |
| `transaction` | `transaction_investigation` | "Where is my Amazon refund?" | The refunds or charges, with the purchases they reverse |
| `payment` | `payment_planning` | "When is my next payment due?" | Empty: account-level figures |
| `general` | `general` | Everything else | Usually empty |

## Reading `confidence`

| Value | Meaning |
|---|---|
| `high` | Rules matched, or the model was sure |
| `medium` | The model's best reading. The figures are still validated |
| `low` | Dial is asking for clarification, or couldn't place the question. The template is `general` and evidence is empty |

**"I can't tell":** when the facts don't cover a question, `template` is always `general`, with no evidence.

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

## Required frontend change

`parseAskResponse` in `lib/assistant/client.ts` rebuilds the response from three fields, so **`experience` is dropped today**. Nothing breaks, but templates can't work until it's kept:

```ts
import { parseExperience } from "../ai/experience";

const experience = parseExperience((body as Record<string, unknown>).experience);
return { answer: answer.trim(), evidenceIds, source, ...(experience ? { experience } : {}) };
```

`AskOutcome` needs to use `OrchestratedResponse` too. `lib/ai/experience.ts` has no server-only code, so it's safe to import in the browser.

## How a question is answered

1. **Agent 1, interpreter (`lib/ai/interpreter.ts`):** rules first. Gemini only picks a label from a fixed list, and only if the rules can't tell. Vague or low-confidence questions get a clarification.
2. **Agent 2, template selector (`lib/ai/experience.ts`):** a fixed table.
3. **Agent 3, finance validator (`lib/ai/validator.ts`, `lib/ai/guard.ts`):** checks every response, including cached and template ones. Amounts, dates, names, balances, statuses and evidence must match the facts. Anything else falls back to a template, then to "I can't tell that from your transactions."

Gemini never calculates, chooses evidence, or chooses a screen. At most two Gemini calls per question, and most questions use one or none.
