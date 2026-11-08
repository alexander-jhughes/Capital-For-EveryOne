// Get a suggestion for the current settings.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handlers.postRecommendations(request);
