// Demo only: "be" one of the synthetic users. Replaces this visitor's account session and profile cookies with that
// user's (built through the API's own validation) and sets their view, then opens Home. Touches only this visitor's
// cookies, like /demo/reset. Display settings (cfe-prefs) are left alone so the person's own text size etc. stay.
import { MODE_KEY } from "../demo-config";
import { profileStore, type ProfileStore } from "../server/profile";
import { SessionSecretError } from "../server/secret";
import { sessionStore, type SessionStore } from "../server/store";
import { buildDemoUser } from "./build";
import { demoUser } from "./users";

const noStore = { "Cache-Control": "no-store" };

export async function selectDemoUser(request: Request, id: string, stores: { sessions?: SessionStore; profiles?: ProfileStore } = {}): Promise<Response> {
  const { sessions = sessionStore, profiles = profileStore } = stores;
  const user = demoUser(id);
  if (!user) return new Response("No synthetic user with that id. See /demo/users.", { status: 404, headers: noStore });
  try {
    const { session, profile } = buildDemoUser(user);
    const headers = new Headers({ Location: new URL("/account", request.url).toString(), ...noStore });
    headers.append("Set-Cookie", (await sessions.save(session, request))["Set-Cookie"]);
    headers.append("Set-Cookie", (await profiles.save(profile, request))["Set-Cookie"]);
    headers.append("Set-Cookie", `${MODE_KEY}=${user.view}; Path=/; Max-Age=31536000; SameSite=Lax`);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    const message = error instanceof SessionSecretError ? "SESSION_SECRET isn't set on this server, so demo users can't be signed." : "That demo user couldn't be loaded.";
    return new Response(message, { status: 500, headers: noStore });
  }
}
