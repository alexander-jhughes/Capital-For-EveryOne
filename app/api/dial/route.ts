// POST /api/dial: see lib/ai/command-handler.ts. Turns a request the on-device rules couldn't read into validated steps.
import { createCommandModel } from "@/lib/ai/command-model";
import { handleDial } from "@/lib/ai/command-handler";

export const POST = (request: Request) => handleDial(request, createCommandModel);
