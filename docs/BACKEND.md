# Backend: where the account lives

The server is the source of truth for everything that has happened to the demo account. The browser asks for the
account, sends requests to change it, and shows whatever comes back. It never works out a balance that the server
hasn't confirmed, and `POST /api/ask` never believes a balance the browser claims.

There is still no database and no sign-in. Instead each visitor has a **session**: a signed cookie that holds their
event log. That is the smallest thing that works on Vercel (no writable disk, no long-lived memory) and it is built
so a real database can take its place without changing the API.

## What is stored

The session (`lib/server/session.ts`) holds events and choices, never figures:

| Field | What | Limit |
|---|---|---|
| `payments` | Payments made: id, amount, date, kind | Together with purchases, 50 events |
| `purchases` | Purchases the person went ahead with after Spend Pause: id, date, shop, amount | As above |
| `settings` | Spend Pause choices, or nothing if they have never been saved | One |
| `activity` | When Spend Pause was last turned on and off | Two timestamps |
| `goals` | Spending goals (`lib/goals/store.ts` shapes) | 10 |

Balances are **never stored**. Every reply derives the account from the seed (`lib/data/seed.ts`) plus the session's
events, with the same code the screens use: `accountWithPurchases` and `deriveAccount` in
`lib/state/derive-account.ts`, which call `accountAfterPayments` in `lib/payments/rules.ts`. So the screens, the API
and Dial's facts can't disagree, and `lib/server/handlers.test.ts` checks that they don't.

## The cookie

`cfe-session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days, `Secure` when served over HTTPS.

Value: `base64url(JSON).base64url(HMAC-SHA256(JSON))`. The JSON is versioned (`v: 1`) with short keys and tuples:

```json
{ "v": 1, "t": 1794132000,
  "s": [1, 10000, 50000, null, null],
  "a": ["2026-11-08T10:00:00.000Z", null],
  "p": [["demo-1", "2026-11-08", "Northwind Audio", 12000]],
  "y": [["pay-mhq3x2k0-a1b2c3d0", "2026-11-08", 1000, "c"]],
  "g": [["g-abcdefgh", "2026-11-08", ["c", "Eating out", 8000]]] }
```

`t` is when it was signed; a session older than 30 days is treated as no session. The seed plus 10 events, settings,
activity and two goals is about 970 bytes. The store refuses a change that would push the value past 3.5 KB, with a
friendly message, so the cookie can never be silently dropped by a browser.

The cookie is **tamper-evident, not secret**: a person can decode their own cookie and see their own events, but
can't change one byte of it without the server rejecting the whole thing (`lib/server/session.test.ts`). Nothing in it
is sensitive beyond what the person already sees on screen. On decode, the payload is also run through the same
validation `/api/ask` applies to a client state (`parseClientState` in `lib/ai/live-state.ts`), so a signing bug could
still not smuggle in an impossible account.

### `SESSION_SECRET`

The HMAC key. Set it in `.env.local` (and in the hosting dashboard), at least 32 characters, for example
`openssl rand -base64 32`. Changing it signs everyone out: old cookies stop verifying and every visitor starts from
the seed.

- **Production** without it (or with a short one): the account API answers 500 with a friendly message, the app runs
  from the seed, and every screen says changes won't be kept. `/api/ask` falls back to the body `state`, as it did
  before sessions existed. The server never signs with a weak key.
- **Development** without it: a stable key is derived from the machine (hostname and home folder), so cookies survive
  a restart, and a warning is printed once.

## The API

All under `app/api`, JSON only, `Cache-Control: no-store`, no rate limit (each call is a few microseconds of
arithmetic). The route files export only HTTP methods; the logic is in `lib/server/handlers.ts` so it is unit tested
with plain `Request` objects. Every change replies with the **whole derived state**, and the browser replaces its copy:

```ts
interface AccountStateBody {
  account: Account; transactions: Transaction[];
  settings: SpendPauseSettings; spendPauseActivity: { activatedAt: string | null; deactivatedAt: string | null };
  payments: Payment[]; purchases: Transaction[]; goals: Goal[];
  saved: true;
}
```

| Route | Body | Notes |
|---|---|---|
| `GET /api/account` | | Seed plus session. Sets no cookie, so someone who changes nothing carries nothing. |
| `POST /api/payments` | `{ id, amount, kind }` | Validated by `recordPayment`. Idempotent by `id`: the same id twice replies with the first payment and `repeat: true`, and never pays twice. Adds `payment` and `repeat` to the reply. |
| `DELETE /api/payments/:id` | | Undo. An unknown id changes nothing and still replies 200 with the state. |
| `PUT /api/spend-pause` | `{ settings }` | Validated like the live state. Stamps `activatedAt` or `deactivatedAt` when `enabled` changes, exactly as `spendPauseReducer` does. |
| `POST /api/purchases` | `{ purchase }` (a `PendingPurchase`) | For a purchase the person went ahead with. Validated like live-state purchases (new id, plain shop name, whole pence, date not after the demo date). Idempotent by `id`. |
| `GET /api/goals` | | Same reply as `/api/account`. |
| `PUT /api/goals` | `{ goals }` | Replaces the list. Refused whole (400) if any goal fails `sanitizeGoals`, or there are more than 10. |

Errors are `400 { error }` in plain English, `500 { error }` only when the server itself can't go on (no
`SESSION_SECRET` in production). Bodies are capped at 16 KB. Ids are shared between payments and purchases, so Dial's
evidence ids are never ambiguous.

### `POST /api/ask`

If the request carries a `cfe-session` cookie this server signed, Dial's facts come from that session
(`contextFromSession` in `lib/server/account.ts`) and anything in the body's `state` is ignored, not even parsed.
Without a cookie, behaviour is unchanged: the body `state` is validated and used, so existing tests and scripts pass.
`lib/server/ask-session.test.ts` checks that the cookie wins. The browser still sends `state`; it is harmless.

## The browser

`lib/state/account-api.ts` is the only place that calls these routes. Calls run one at a time through a small queue,
because every change rewrites the same cookie: two in flight at once would each start from the same cookie and the
second would wipe out the first.

`lib/state/account-context.tsx` loads `GET /api/account` on mount (`ready` stays false until then). Each change is
applied locally first, so `makePayment` still returns its `PaymentResult` at once, then sent to the server, whose
reply replaces the local state. If the server refuses or can't be reached, the provider re-reads the account; if that
fails too, `paymentsSaved` or `settingsSaved` turns false and the screens say changes won't be kept.
`lib/goals/provider.tsx` does the same with `/api/goals`.

Only this tab's transient Spend Pause state stays in `sessionStorage`: the purchase waiting for an answer, whether it
needed the check, and the session's history of decisions. They are not money.

## Switching to a database

`SessionStore` in `lib/server/store.ts` has two methods:

```ts
load(request): Promise<Session | null>;
save(session, request): Promise<Record<string, string>>;  // headers for the reply, such as Set-Cookie
```

`createCookieStore` is what runs today. `createMemoryStore` is the shape a database store takes: an id in the cookie,
the session looked up by id. For Redis, Vercel KV or Postgres, write `createKvStore` with the same two methods and
pass it to `createHandlers` (and `handleAsk`). Nothing else changes: not the routes, not the derivation, not the
browser. With sign-in, the id becomes the user's id and the per-IP rate limit in `lib/ai/rate-limit.ts` can key on it.

## Known limits

- One cookie per browser: two tabs share it, and the last write wins. The browser queue stops a single tab racing
  itself, not two tabs.
- The event cap is 50 payments and purchases and 10 goals, and the byte cap is 3.5 KB. A payment id from the Pay
  screen is 21 characters, so 50 of them fit; longer ids would hit the byte cap first.
- Dates are the fixed demo date (`lib/demo-clock.ts`), on the server as on the screens.
- An approved purchase is recorded when the browser says the person confirmed it. The server checks its shape, not
  that the Spend Pause question was shown, because that confirmation happens on screen.
- Settings previously saved in `localStorage` by older builds are not migrated; those visitors start from the defaults.
