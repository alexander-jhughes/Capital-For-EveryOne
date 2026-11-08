// Grant or withdraw the three consents. Granting personalisation sets the cookie; withdrawing it erases everything.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = (request: Request) => handlers.putConsent(request);
