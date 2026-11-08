import { createHandlers } from "@/lib/server/handlers";

const handlers = createHandlers();

export const GET = (request: Request) => handlers.getGoals(request);

/** Replaces the goals { goals }. Refused whole if any goal is invalid. */
export const PUT = (request: Request) => handlers.putGoals(request);
