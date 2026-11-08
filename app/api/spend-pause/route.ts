import { createHandlers } from "@/lib/server/handlers";

const handlers = createHandlers();

/** Saves Spend Pause choices { settings } and notes when it was turned on or off. */
export const PUT = (request: Request) => handlers.putSpendPause(request);
