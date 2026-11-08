// The person's saved profile: consent, the needs they told us, their chosen type, and the model's result. See lib/server/profile.ts.
import { profileHandlers } from "@/lib/server/profile-handlers";

export const GET = profileHandlers.get;
export const PUT = profileHandlers.put;
export const DELETE = profileHandlers.delete;
