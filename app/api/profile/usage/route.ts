// Counts one use of a part of the app (Dial, Learning Lab, what-if, goals, Detailed view), only with consent.
import { profileHandlers } from "@/lib/server/profile-handlers";

export const POST = profileHandlers.usage;
