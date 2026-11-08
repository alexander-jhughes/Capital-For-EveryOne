// The account API, apart from the route files (app/api/*), which only export these. Every reply is JSON, never cached,
// and every change replies with the whole derived state so the client can replace its copy. Nothing in a body can set a
// balance: bodies carry requests, the session carries events, and the figures are worked out from the seed each time.
import { applyGoals, applyPayment, applyPurchase, applySettings, deriveState, parsePaymentBody, parsePurchaseBody, removePayment, type Change } from "./account";
import { SessionSecretError } from "./secret";
import { emptySession, type Session } from "./session";
import { StoreError, sessionStore, type SessionStore } from "./store";

const MAX_BODY_BYTES = 16_384;

export const MESSAGES = {
  unreadable: "Sorry, I couldn't read that. Please try again.",
  tooBig: "That request is too large.",
  noSecret: "The server can't keep your changes yet: SESSION_SECRET isn't set. Your changes will last until you reload.",
  failed: "Sorry, something went wrong. Please try again.",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const error = (message: string, status: number) => json({ error: message }, status);

/** The JSON object in the body, or null. Stops reading at the limit, whatever the headers claim. */
async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type Handler = (request: Request) => Promise<Response>;

/** The handlers over one store. Routes use the cookie store; tests pass a memory store or a cookie store with a known key. */
export function createHandlers(store: SessionStore = sessionStore) {
  const guarded =
    (run: Handler): Handler =>
    async (request) => {
      try {
        return await run(request);
      } catch (err) {
        if (err instanceof SessionSecretError) return error(MESSAGES.noSecret, 500);
        if (err instanceof StoreError) return error(err.message, 400);
        console.warn(`[account] request failed: ${err instanceof Error ? err.message : String(err)}`);
        return error(MESSAGES.failed, 500);
      }
    };

  const load = async (request: Request) => (await store.load(request)) ?? emptySession();

  /** Reads the body, applies one change and replies with the new state, plus anything else the change reports (such as `repeat`). */
  const mutate = (apply: (session: Session, body: Record<string, unknown>) => Change<object>) =>
    guarded(async (request) => {
      const body = await readObject(request);
      if (!body) return error(MESSAGES.unreadable, 400);
      const session = await load(request);
      const change = apply(session, body);
      if (!change.ok) return error(change.message, 400);
      const extra = Object.fromEntries(Object.entries(change).filter(([key]) => key !== "ok" && key !== "session"));
      const headers = await store.save(change.session, request);
      return json({ ...deriveState(change.session), ...extra }, 200, headers);
    });

  return {
    /** GET /api/account. Sets no cookie: a visitor who changes nothing gets nothing to carry. */
    getAccount: guarded(async (request) => json(deriveState(await load(request)))),

    /** POST /api/payments { id, amount, kind }. Idempotent by id. Adds `payment` and `repeat` to the state. */
    postPayment: mutate((session, body) => {
      const payment = parsePaymentBody(body);
      return payment ? applyPayment(session, payment) : { ok: false as const, message: "That payment couldn't be recorded. Nothing has been paid." };
    }),

    /** DELETE /api/payments/:id. Unknown ids change nothing and still reply with the state. */
    deletePayment: (request: Request, id: string) =>
      guarded(async () => {
        const next = removePayment(await load(request), id);
        return json(deriveState(next), 200, await store.save(next, request));
      })(request),

    /** PUT /api/spend-pause { settings }. */
    putSpendPause: mutate((session, body) => applySettings(session, body.settings)),

    /** POST /api/purchases { purchase } for a purchase the person went ahead with. Idempotent by id. */
    postPurchase: mutate((session, body) => {
      const purchase = parsePurchaseBody(body.purchase);
      return purchase ? applyPurchase(session, purchase) : { ok: false as const, message: "That purchase couldn't be recorded." };
    }),

    /** GET /api/goals. The same state as /api/account; the goals screen reads `goals` from it. */
    getGoals: guarded(async (request) => json(deriveState(await load(request)))),

    /** PUT /api/goals { goals }. */
    putGoals: mutate((session, body) => applyGoals(session, body.goals)),
  };
}

export type AccountHandlers = ReturnType<typeof createHandlers>;
