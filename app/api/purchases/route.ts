import { createHandlers } from "@/lib/server/handlers";

const handlers = createHandlers();

/** Records a purchase the person went ahead with { purchase }. The same id twice is one purchase. */
export const POST = (request: Request) => handlers.postPurchase(request);
