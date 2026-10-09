import { unstable_isUnrecognizedActionError } from "next/navigation";
import type { CheckinError } from "./actions";

// What the check-in forms show when a server action never answered, instead of the error.

export const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection, then try again.";
// The page is from an earlier deployment, and the server no longer knows its actions; trying again
// from this page fails the same way every time.
export const UPDATED_MESSAGE = "Module One has just been updated. Refresh the page, then try again.";

export function updatedSinceLoad(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}

export function unreachable(error: unknown): CheckinError {
  return { status: "error", code: "failed", message: updatedSinceLoad(error) ? UPDATED_MESSAGE : OFFLINE_MESSAGE };
}

// Wraps a server action for useActionState. Without it, a call that rejects (no network, or a new
// deployment) goes to the nearest error boundary and the whole page is replaced by an error screen.
export function settled<T>(action: () => Promise<T>): () => Promise<T | CheckinError> {
  return async () => {
    try {
      return await action();
    } catch (error) {
      return unreachable(error);
    }
  };
}
