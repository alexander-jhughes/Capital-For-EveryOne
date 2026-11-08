// Record what the person did with a suggestion.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request, { params }: { params: Promise<{ id: string }> }) => handlers.postFeedback(request, { params });
