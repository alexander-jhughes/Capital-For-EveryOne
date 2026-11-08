import { NextResponse } from "next/server";
import { MODE_KEY } from "@/lib/demo-config";
import { PREFS_COOKIE } from "@/lib/preferences/schema";
import { SESSION_COOKIE } from "@/lib/server/store";

// "Start the demo again": forget this visitor's session (payments, purchases, goals), display choices and view.
// Browser storage is cleared by the welcome page it lands on (components/onboarding), which also turns the demo's
// Spend Pause back on through the normal settings API. Only touches this visitor's own cookies.
function reset(request: Request) {
  const res = NextResponse.redirect(new URL("/?reset=done", request.url), 303);
  for (const name of [SESSION_COOKIE, PREFS_COOKIE, MODE_KEY]) res.cookies.set(name, "", { path: "/", maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const GET = reset;
export const POST = reset;
