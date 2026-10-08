import type { CheckinErrorCode, PrepareRecordingResult, SaveDraftResult } from "./actions";
import { OFFLINE_MESSAGE, updatedSinceLoad } from "./unreachable";

// A finished recording, kept in memory until it is saved, so a failed upload can be retried.
// recordedAt is when the recording stopped, by this browser's clock. Saving sends how long ago that
// was (one clock, so it doesn't matter if it is off), and the server works out the time from its
// own clock, to keep a newer take when an older one arrives late.
export type Take = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  recordedAt: number;
  uploadedPath: string | null;
};

// Where saving a take ends. On "saved" the page re-renders with the draft (or the submitted
// check-in) in the recorder's place; on "failed" the take is kept for "Try again".
export type SaveOutcome =
  | { step: "saved" }
  // updated: the app was redeployed since the page loaded, so no retry from this page can work.
  | { step: "failed"; take: Take; message: string; updated: boolean };

export type ReadyToUpload = Extract<PrepareRecordingResult, { status: "ready" }>;

// What saving a take calls, passed in so the flow can be tested without a browser or a server.
export type SaveSteps = {
  prepare: (mimeType: string) => Promise<PrepareRecordingResult>;
  // Uploads to the signed upload URL prepare made; resolves with Storage's error, if any.
  upload: (ready: ReadyToUpload, body: Blob) => Promise<{ error: unknown }>;
  saveDraft: (input: { path: string; durationMs: number; ageMs: number }) => Promise<SaveDraftResult>;
  timeouts?: Timeouts;
};

// How long each step may take. On a connected but dead mobile network a request can hang without
// ever failing, which would leave "Saving your recording…" on screen for good. Neither the server
// actions nor the signed upload can be cancelled, so a step that runs out of time may still finish
// later; and Next.js sends server actions one at a time, so a retry can queue behind a hung one.
export const TIMEOUTS = { prepareMs: 30_000, uploadMs: 90_000, saveMs: 30_000 };
export type Timeouts = typeof TIMEOUTS;

export const UPLOAD_FAILED_MESSAGE = "The upload didn't go through. Check your connection, then try again.";
export const TOO_SLOW_MESSAGE = "Saving took too long. Check your connection, then try again.";
export const REDEPLOYED_MESSAGE =
  "Module One was updated while you were recording, so this page can't save the take any more. Refresh the page and record again.";

class TimedOut extends Error {}

function within<T>(ms: number, step: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), ms);
    step.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function failed(take: Take, message: string): SaveOutcome {
  return { step: "failed", take, message, updated: false };
}

// The take "Try again" should use after saveDraft refused it. Only a failure on our side after a
// good upload ("failed") is worth retrying with the file already uploaded; anything else (it never
// arrived, it's too old, the week turned) needs a fresh upload.
export function takeToRetry(code: CheckinErrorCode, take: Take): Take {
  return code === "failed" ? take : { ...take, uploadedPath: null };
}

// Saves a take as this week's draft: a signed upload path from the server, the upload straight to
// Storage, then saveDraft. A take that already has an uploaded path skips straight to saveDraft,
// which is safe to repeat for the same path.
export async function saveTake(take: Take, steps: SaveSteps): Promise<SaveOutcome> {
  const { prepare, upload, saveDraft, timeouts = TIMEOUTS } = steps;
  let current = take;
  const reused = take.uploadedPath !== null;
  try {
    let path = current.uploadedPath;
    if (path === null) {
      const prepared = await within(timeouts.prepareMs, prepare(current.mimeType));
      if (prepared.status === "submitted") return { step: "saved" };
      if (prepared.status === "error") return failed(current, prepared.message);
      // Storage records the file's type from the Blob itself; send the plain type the server allowed.
      const body = new Blob([current.blob], { type: prepared.contentType });
      const { error } = await within(timeouts.uploadMs, upload(prepared, body));
      if (error) return failed(current, UPLOAD_FAILED_MESSAGE);
      path = prepared.path;
      current = { ...current, uploadedPath: path };
    }
    const saved = await within(
      timeouts.saveMs,
      saveDraft({ path, durationMs: current.durationMs, ageMs: Date.now() - current.recordedAt }),
    );
    // An upload kept from an earlier try that is now too old to save: the take itself is fine, so
    // upload it again rather than ask the member to record it again.
    if (saved.status === "error" && saved.code === "upload_expired" && reused) {
      return saveTake({ ...current, uploadedPath: null }, steps);
    }
    if (saved.status === "error") return failed(takeToRetry(saved.code, current), saved.message);
    // "superseded": a take recorded later is already the draft, and the page now shows it.
    return { step: "saved" };
  } catch (error) {
    // An upload that ran out of time may or may not have landed, so the take still has no uploaded
    // path and "Try again" asks for a fresh one. After a good upload it keeps the path.
    if (error instanceof TimedOut) return failed(current, TOO_SLOW_MESSAGE);
    const updated = updatedSinceLoad(error);
    return { step: "failed", take: current, message: updated ? REDEPLOYED_MESSAGE : OFFLINE_MESSAGE, updated };
  }
}
