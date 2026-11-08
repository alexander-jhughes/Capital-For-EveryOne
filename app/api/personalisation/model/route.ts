// Public: which model serves suggestions, with its headline evaluation numbers.
import { handlers } from "@/lib/server/personalisation/app-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handlers.getModel(request);
