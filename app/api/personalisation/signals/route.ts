// Record allowlisted interaction signals (counts only).
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handlers.postSignals(request);
