import { createHandlers } from "@/lib/server/handlers";

const handlers = createHandlers();

/** Records a payment { id, amount, kind }. The same id twice is one payment. */
export const POST = (request: Request) => handlers.postPayment(request);
