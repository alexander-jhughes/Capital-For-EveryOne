// GET: consent, profile and model state (never creates a session). DELETE: erase everything about this person.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handlers.getState(request);
export const DELETE = (request: Request) => handlers.deleteAll(request);
