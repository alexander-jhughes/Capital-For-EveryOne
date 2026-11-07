import { handleAsk } from "@/lib/ai/ask";
import { createModel } from "@/lib/ai/model";

export const POST = (request: Request) => handleAsk(request, createModel);
