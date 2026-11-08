// Save or delete the optional age band (research consent only; never used to recommend).
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = (request: Request) => handlers.putResearch(request);
