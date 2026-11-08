import { createHandlers } from "@/lib/server/handlers";

const handlers = createHandlers();

/** Undoes a payment made in this session. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handlers.deletePayment(request, id);
}
