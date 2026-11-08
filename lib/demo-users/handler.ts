// Demo only: "be" one of the synthetic users. Gives this browser a clean start as that user: their account session and
// profile replace this visitor's, their view is set, and everything the previous person left on this device (display
// settings, the tab's Spend Pause purchase and history, browser storage) is cleared, as "Start the demo again" does.
// Touches only this visitor's own cookies and storage. It can't read or reach anyone else's: each visitor's data
// travels only in their own signed cookies.
import { MODE_KEY } from "../demo-config";
import { PREFS_COOKIE } from "../preferences/schema";
import { profileStore, type ProfileStore } from "../server/profile";
import { SessionSecretError } from "../server/secret";
import { sessionStore, type SessionStore } from "../server/store";
import { buildDemoUser } from "./build";
import { demoUser } from "./users";

const noStore = { "Cache-Control": "no-store" };

/**
 * A form on another website must not be able to swap a visitor's demo data. Browsers say where a request came from in
 * Sec-Fetch-Site (and Origin); anything but this site is refused. A client that sends neither isn't a browser acting
 * for someone else, and can only change the cookies it sends itself.
 */
export function isSameSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function selectDemoUser(request: Request, id: string, stores: { sessions?: SessionStore; profiles?: ProfileStore } = {}): Promise<Response> {
  const { sessions = sessionStore, profiles = profileStore } = stores;
  if (!isSameSite(request)) return new Response("Demo users can only be chosen from this site.", { status: 403, headers: noStore });
  const user = demoUser(id);
  if (!user) return new Response("No synthetic user with that id. See /demo/users.", { status: 404, headers: noStore });
  try {
    const { session, profile } = buildDemoUser(user);
    const headers = new Headers({
      Location: new URL("/account", request.url).toString(),
      ...noStore,
      // Clears localStorage and sessionStorage (the previous person's pending Spend Pause purchase and history, display
      // suggestions). The picker page also clears the app's keys before it submits, for browsers that ignore this.
      "Clear-Site-Data": '"storage"',
    });
    headers.append("Set-Cookie", (await sessions.save(session, request))["Set-Cookie"]);
    headers.append("Set-Cookie", (await profiles.save(profile, request))["Set-Cookie"]);
    headers.append("Set-Cookie", `${MODE_KEY}=${user.view}; Path=/; Max-Age=31536000; SameSite=Lax`);
    headers.append("Set-Cookie", `${PREFS_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    const message = error instanceof SessionSecretError ? "SESSION_SECRET isn't set on this server, so demo users can't be signed." : "That demo user couldn't be loaded.";
    return new Response(message, { status: 500, headers: noStore });
  }
}
