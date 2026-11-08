import { handleAsk } from "@/lib/ai/ask";
import { createModel, modelStatus } from "@/lib/ai/model";

export const POST = (request: Request) => handleAsk(request, createModel);

/** Whether Groq is set up, and which model. For checking a deployment. Never shows the key. */
export const GET = () => Response.json(modelStatus(), { headers: { "Cache-Control": "no-store" } });
