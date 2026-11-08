// Save the optional "About you" answers.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = (request: Request) => handlers.putProfile(request);
