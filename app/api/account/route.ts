import { createHandlers } from "@/lib/server/handlers";

const handlers = createHandlers();

/** The account as this visitor's session makes it: the seed plus their events, every figure worked out here. */
export const GET = (request: Request) => handlers.getAccount(request);
