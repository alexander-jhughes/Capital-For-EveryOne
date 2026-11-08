// "Did this make Dial easier to use?"
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request, { params }: { params: Promise<{ id: string }> }) => handlers.postRating(request, { params });
