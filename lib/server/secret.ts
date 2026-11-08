// The key that signs the session cookie. Comes from SESSION_SECRET. Without it, development uses a key derived from
// this machine so cookies survive a restart, and production refuses to sign at all rather than sign with a guessable key.
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";

/** Short enough to type into a hosting dashboard, long enough that guessing it isn't practical. */
export const MIN_SECRET_LENGTH = 32;

export class SessionSecretError extends Error {
  constructor() {
    super("SESSION_SECRET is not set (or is shorter than 32 characters), so sessions can't be signed in production.");
    this.name = "SessionSecretError";
  }
}

let warned = false;

/** The signing key as bytes. Throws SessionSecretError in production when there isn't a usable one. */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const set = env.SESSION_SECRET?.trim() ?? "";
  if (set.length >= MIN_SECRET_LENGTH) return Buffer.from(set, "utf8");
  if (env.NODE_ENV === "production") throw new SessionSecretError();
  // A stable key for this machine only, so a developer's cookies keep working between restarts.
  if (!warned && env.NODE_ENV !== "test" && !env.VITEST) {
    warned = true;
    console.warn("[session] SESSION_SECRET is not set, so a development-only key derived from this machine is being used. Set it in .env.local before deploying.");
  }
  return createHash("sha256").update(`cfe-dev-session|${hostname()}|${homedir()}|${set}`).digest();
}

/** For tests. */
export const resetSecretWarning = () => {
  warned = false;
};
