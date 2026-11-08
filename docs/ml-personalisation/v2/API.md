# Dial personalisation v2: HTTP API

Owner: WS4 (backend). Handlers: `lib/server/personalisation/handlers.ts`. Routes: `app/api/personalisation/**`.
The agreed table is CONTRACT.md §7; this file adds examples, every error, and the security rules.
Storage is described in [DATABASE.md](./DATABASE.md).

## Conventions

- Base path: `/api/personalisation`. Runs in Dial's own Node process (`runtime = "nodejs"`). Nothing is sent to a
  third party, and nothing from here goes to `/api/ask` or Gemini.
- Requests with a body: `Content-Type: application/json`, a JSON object, at most 16 KB. Unknown fields are rejected.
- Every response is JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Errors are `{ "error": "Plain English message" }`.
- Times in responses are ISO 8601 strings.

### Session

- Cookie `cfe-pid` = `v1.<subject id>.<HMAC-SHA256, base64url>`. `HttpOnly; SameSite=Lax; Path=/api/personalisation;
  Max-Age=34560000` (400 days), plus `Secure` on https.
- Created only by `PUT /consent` with `personalisation: true`. Renewed at most once a day while in use.
- A cookie that is forged, or names a subject that no longer exists, counts as no session, and the response clears it.
- The browser sends it automatically (`fetch` with the default `credentials: "same-origin"`). Scripts can't read it.

### Status codes

| Code | When |
|---|---|
| 200 | Done. |
| 202 | Signals accepted (`POST /signals`). |
| 400 | The body isn't valid: bad JSON, an unknown field, question, value, item, signal or outcome. |
| 401 | The endpoint needs personalisation to be on, and there is no valid session. |
| 403 | A cross-site mutation, or research data without research consent. |
| 404 | No such suggestion **for this person** (also for someone else's id, so ids can't be probed). |
| 409 | Not possible in the current state: consent order, a suggestion that already has an answer, nothing to undo or rate. |
| 413 | The body is over 16 KB. |
| 415 | The body isn't `application/json`. |
| 429 | Too many requests. `Retry-After` says how many seconds to wait. |
| 500 | Unexpected. Logged without any request data. |
| 503 | The database (or the session secret) is unavailable. Dial carries on without suggestions. |

### Limits

| What | Limit |
|---|---|
| Requests | 120 a minute per person (per address before a session exists) |
| Turning personalisation on | 10 new subjects an hour per address |
| Signals | 20 per request; 200 stored per person per 24 hours (the rest are accepted but not stored) |
| Body | 16 KB |

## Endpoints

### `GET /api/personalisation`

The current state. Public. **Never creates a session or a row.**

```json
{
  "available": true,
  "consent": { "personalisation": true, "collaborative": false, "research": true },
  "profile": { "answers": { "detailLevel": "keyFacts", "inputMode": "voice" }, "answered": 2 },
  "research": { "ageBand": "65+" },
  "model": { "version": "hybrid-2.0.0+syn.s20261108", "trainedOn": "synthetic" }
}
```

- Without a session: all consents `false`, `profile` and `research` `null`.
- `research` is `null` without research consent, `{}` with consent but no age band.
- If the database is unavailable: `200` with `{ "available": false, ..., "model": null }` (not 503), so the app can
  hide the feature quietly.

Errors: 429.

### `PUT /api/personalisation/consent`

```json
{ "personalisation": true, "collaborative": true }
```

Each field is optional and must be a boolean. Response: the same shape as `GET /`.

| Request | Result |
|---|---|
| `personalisation: true`, no session | Creates the pseudonymous subject and profile, sets the cookie. Other consents in the same body are applied too. |
| `personalisation: true`, session | Nothing new is created; other fields are applied. |
| `collaborative` / `research` with a session | Changes that consent. `research: false` deletes the age band at once. |
| `personalisation: false` | Deletes everything about this person (cascade) and clears the cookie. |
| `collaborative: true` or `research: true` without personalisation (now or in this body) | **409**, nothing stored. |
| `{}` or only `false` values, no session | 200 with the empty state. No cookie, no row. |

Errors: 400, 403 (cross-site), 409, 413, 415, 429 (also for creating too many subjects), 503.

### `PUT /api/personalisation/profile`

Replaces the "About you" answers. A missing question means skipped.

```json
{ "answers": { "detailLevel": "keyFacts", "screenReader": "yes" } }
```

Response: `{ "answers": { ... }, "answered": 2 }`.

Errors: 400 (unknown question or value), 401, 403 (cross-site), 413, 415, 429, 503.

### `PUT /api/personalisation/research`

```json
{ "ageBand": "35-49" }
```

`ageBand` is one of `18-24`, `25-34`, `35-49`, `50-64`, `65+`. Leaving it out (or `null`) deletes it.
Response: `{ "ageBand": "35-49" }` or `{}`. Never used to recommend: only for aggregate fairness checks.

Errors: 400, 401, 403 (no research consent, or cross-site), 413, 415, 429, 503.

### `POST /api/personalisation/signals`

Counts of explicit actions. Allowlisted ids and sources only.

```json
{ "signals": [ { "id": "shorterAnswers", "source": "voice" }, { "id": "textLarger", "source": "settings" } ] }
```

- `id`: `textLarger`, `textSmaller`, `lessOnScreen`, `moreDetail`, `moreVisual`, `voiceSessions`, `shorterAnswers`,
  `undoneChanges`.
- `source`: `settings`, `voice`, `style`, `onboarding`, `dial`.
- Never accepted: audio, transcripts, questions, answers, transactions, free text of any kind. Any extra field is a 400.

Response: `202 { "accepted": 2 }`. `accepted` is lower than sent once the daily cap is reached.

Errors: 400 (unknown id or source, extra field, empty, more than 20), 401, 403 (cross-site), 413, 415, 429, 503.

### `POST /api/personalisation/recommendations`

Stores the current settings snapshot and asks the model for a suggestion.

```json
{
  "preferences": { "textSize": 100, "contrast": "standard", "spacing": "standard", "motion": "system", "theme": "system",
                   "targets": "standard", "explanations": "standard", "voiceFirst": false, "onboarding": "done",
                   "layout": { "pinned": [], "shown": [], "hidden": [], "emphasis": null, "density": "standard" } },
  "view": "simple",
  "explicit": ["textSize"]
}
```

- `preferences` must be exactly what `sanitize()` (lib/preferences/schema.ts) would produce: every field, no extras.
- `explicit`: dimensions the person set themselves. **Sticky**: the server adds what it stored before and every
  dimension not at its default, and stores the union. Nothing on an explicit dimension is ever suggested.
- The model input is: answers from the profile, these settings, signal counts and this person's own history.

Response (a suggestion):

```json
{
  "recommendation": {
    "id": "6f1c0a4e-2a7b-4f0e-9d0e-8a3b2c1d0e9f",
    "modelVersion": "hybrid-2.0.0+syn.s20261108",
    "trainedOn": "synthetic",
    "configuration": {
      "items": ["textSize.125", "contrast.high"],
      "actions": [{ "type": "textSize", "value": 125 }, { "type": "contrast", "value": "high" }],
      "title": "Larger text and stronger contrast",
      "offer": "Would you like larger text and stronger contrast?",
      "confidence": 0.71,
      "evidence": "moderate"
    },
    "alternatives": [ { "items": ["spacing.roomy"], "actions": [{ "type": "spacing", "value": "roomy" }], "...": "..." } ],
    "explanation": { "summary": "People who gave similar answers often kept these.", "reasons": ["You said: Just the key facts"] },
    "warnings": [{ "code": "synthetic_only", "text": "..." }]
  },
  "status": "ok",
  "warnings": [{ "code": "synthetic_only", "text": "..." }]
}
```

Response (nothing to suggest): `{ "recommendation": null, "status": "no_recommendation" | "insufficient_data" |
"unavailable", "warnings": [...] }`. Nothing is stored in that case (except the settings snapshot).

- An open (unanswered) suggestion with the same model, configuration and alternatives from the last 24 hours is
  returned again with the same `id`, rather than stored twice.
- If the model can't be loaded, the engine throws, or it returns something malformed: `200` with
  `status: "unavailable"` and a `model_unavailable` warning, never a 500.
- The suggestion is only ever **applied** by the trusted preview and "Keep it" path in the app, never by the model.

Errors: 400, 401, 403 (cross-site), 413, 415, 429, 503.

### `POST /api/personalisation/recommendations/:id/feedback`

```json
{ "outcome": "modified", "items": ["textSize.125"], "via": "card" }
```

| `outcome` | `items` | Allowed when the suggestion is |
|---|---|---|
| `accepted` | optional; if sent, exactly the main configuration | `shown` |
| `modified` | required: the items kept. Non-empty, from the configuration or alternatives, not exactly the main configuration (that is `accepted`). Keeping an alternative instead is `modified`. | `shown` |
| `rejected` | optional: what was previewed. Default: the main configuration | `shown` |
| `dismissed` ("Not now") | optional, as for `rejected` | `shown` |
| `reverted` | optional: the kept items undone. Default: everything still kept | `accepted`, `modified`, `reverted` |

`via`: `card`, `undo`, `settings` or `reset` (optional). The client reports reverts itself; a revert `via: "reset"`
gives no training label.

Response: `{ "ok": true }`.

Errors: 400 (unknown outcome, item or via; items not in this suggestion; wrong items for the outcome), 401,
403 (cross-site), 404 (not this person's suggestion), 409 (already answered, or nothing left to undo), 413, 415,
429, 503.

### `POST /api/personalisation/recommendations/:id/rating`

"Did this make Dial easier to use?"

```json
{ "satisfaction": 1 }
```

`satisfaction`: `-1` (no), `0` (not sure), `1` (yes). Only after something was kept (`accepted` or `modified`,
including later reverted). A new rating replaces the old one. A `-1` turns the kept items' training labels to 0.

Response: `{ "ok": true }`. Errors: 400, 401, 403 (cross-site), 404, 409 (nothing kept), 413, 415, 429, 503.

### `GET /api/personalisation/export`

Everything stored about this person, as a download (`Content-Disposition: attachment`).

```json
{
  "exportedAt": "2026-11-08T12:00:00.000Z",
  "about": "Everything Dial's personalisation stores about you, ...",
  "subject": { "id": "93ed1a6f77b6dcacb3b24bc17b0bab5e", "createdAt": "...", "lastSeenAt": "..." },
  "consent": { "personalisation": { "granted": true, "at": "..." }, "collaborative": { "state": "granted", "at": "..." }, "research": { "state": "unset", "at": null } },
  "profile": { "answers": { "detailLevel": "keyFacts" }, "profileVersion": 1, "createdAt": "...", "updatedAt": "..." },
  "research": null,
  "settings": { "preferences": { "...": "..." }, "view": "simple", "explicitDimensions": ["textSize"], "updatedAt": "..." },
  "signals": [{ "signal": "voiceSessions", "source": "voice", "at": "..." }],
  "recommendations": [{ "id": "...", "status": "accepted", "configuration": { "...": "..." }, "scores": [], "inputSnapshot": {}, "feedback": [{ "outcome": "accepted", "items": ["textSize.125"], "via": "card", "satisfaction": 1, "at": "..." }] }],
  "consentHistory": [{ "kind": "personalisation", "granted": true, "policyVersion": "2026-11-v2", "at": "..." }]
}
```

Errors: 401, 429, 503.

### `DELETE /api/personalisation`

Deletes everything about this person and clears the cookie. Response: `{ "deleted": true }`.
Idempotent: without a session it still answers `{ "deleted": true }` (there is nothing stored for this browser) and
clears any stale cookie.

Errors: 403 (cross-site), 429, 503.

### `GET /api/personalisation/model`

Public. The model serving suggestions now (the bundled one if the active model can't be loaded).

```json
{
  "version": "hybrid-2.0.0+syn.s20261108",
  "algorithm": "hybrid",
  "trainedOn": "synthetic",
  "createdAt": "2026-11-08T00:00:00.000Z",
  "metrics": { "...": "headline evaluation numbers" }
}
```

Errors: 429, 503 (no database or no usable model).

## Security notes

- **Cross-site requests.** `PUT`, `POST` and `DELETE` are refused (403) when `Sec-Fetch-Site` is `cross-site` or
  `same-site`, or when `Origin` is present and isn't this host (`Host`, `X-Forwarded-Host` or the request URL).
  Browsers always send `Origin` on these methods, so a missing `Origin` means a non-browser client, which has no
  cookie to abuse. The JSON content type also forces a CORS preflight, which this API never approves. The cookie is
  `SameSite=Lax`.
- **No user ids from the client.** The subject comes only from the signed cookie. See DATABASE.md "Access control".
- **Strict input.** Every body is checked against an allowlist; unknown fields, questions, values, items, signals and
  dimensions are rejected rather than dropped, so a client bug can't quietly become training data.
- **Logs.** Only error types and codes are logged. Answers, settings, signals, ids and bodies never are.
- **Housekeeping.** The retention purge runs at most once an hour on API use.
- **What this is not.** The rate limits are per process and in memory: they limit abuse of one instance, they are
  not a distributed quota. Address-based limits trust the first `X-Forwarded-For` hop, so put the app behind a proxy
  that sets it.
