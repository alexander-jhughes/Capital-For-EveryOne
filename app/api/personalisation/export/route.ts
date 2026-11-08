// Everything stored about this person, as JSON.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handlers.getExport(request);
