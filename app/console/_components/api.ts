import { ApiError } from "@/lib/client/api";

/** The text to show for a failed request: the API's own message, or a fallback when the request never got an answer. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** True when a signed-in page got a 401, so the session is gone. */
export function isSignedOut(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Only follow a "next" path that stays inside the console. */
export function consolePath(next: string | undefined): string {
  return next && next.startsWith("/console") ? next : "/console";
}
