// Demo only: switch this browser to one of the synthetic users in lib/demo-users. See lib/demo-users/handler.ts.
import { selectDemoUser } from "@/lib/demo-users/handler";

// POST only, like /demo/reset: a GET could be prefetched or previewed, and that must never replace anyone's data.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return selectDemoUser(request, (await params).id);
}
