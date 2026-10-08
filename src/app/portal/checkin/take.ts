import type { CheckinErrorCode } from "./actions";

// A finished recording, kept in memory until it is saved, so a failed upload can be retried.
export type Take = { blob: Blob; mimeType: string; durationMs: number; uploadedPath: string | null };

// The take "Try again" should use after saveDraft refused it. Only a failure on our side after a
// good upload ("failed") is worth retrying with the file already uploaded; anything else (it never
// arrived, it's too old, the week turned) needs a fresh upload.
export function takeToRetry(code: CheckinErrorCode, take: Take): Take {
  return code === "failed" ? take : { ...take, uploadedPath: null };
}
