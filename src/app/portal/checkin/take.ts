import type { CheckinErrorCode, PrepareRecordingResult, SaveDraftResult } from "./actions";
import { OFFLINE_MESSAGE, updatedSinceLoad } from "./unreachable";

// A finished recording, kept in memory until it is saved, so a failed upload can be retried.
// recordedAt and recordedAtMono are when the recording stopped, by this browser's clock
// (Date.now()) and by its steady clock (performance.now()); serverRecordedAt is the same moment by
// the server's clock, worked out on the first save (see onServerClock) and kept for retries. The
// server keeps the newer take when an older one arrives late, comparing takes from different
// devices, so it needs the one clock. liveSessionId is the live check-in session the take was
// recorded in (null, or left out, without one), so the server can follow the session to the check-in.
export type Take = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  recordedAt: number;
  recordedAtMono: number;
  serverRecordedAt: number | null;
  uploadedPath: string | null;
  liveSessionId?: string | null;
};

// Where saving a take ends. On "saved" the page re-renders with the draft (or the submitted
// check-in) in the recorder's place; on "failed" the take is kept for "Try again"; on "superseded"
// a take recorded later (another tab or device) is already the draft, so this one wasn't kept,
// and the member is told so.
export type SaveOutcome =
  | { step: "saved" }
  | { step: "superseded" }
  // updated: the app was redeployed since the page loaded, so no retry from this page can work.
  | { step: "failed"; take: Take; message: string; updated: boolean };

export type ReadyToUpload = Extract<PrepareRecordingResult, { status: "ready" }>;

// What saving a take calls, passed in so the flow can be tested without a browser or a server.
export type SaveSteps = {
  prepare: (mimeType: string) => Promise<PrepareRecordingResult>;
  // Uploads to the signed upload URL prepare made; resolves with Storage's error, if any.
  upload: (ready: ReadyToUpload, body: Blob) => Promise<{ error: unknown }>;
  saveDraft: (input: {
    path: string;
    durationMs: number;
    recordedAt: number;
    liveSessionId: string | null;
  }) => Promise<SaveDraftResult>;
  // The server's clock now, in ms (a plain request, never queued behind a server action).
  serverNow: () => Promise<number>;
  timeouts?: Timeouts;
};

// How long each step may take. On a connected but dead mobile network a request can hang without
// ever failing, which would leave "Saving your recording…" on screen for good. Neither the server
// actions nor the signed upload can be cancelled, so a step that runs out of time may still finish
// later; and Next.js sends server actions one at a time, so a retry can queue behind a hung one.
export const TIMEOUTS = { clockMs: 10_000, prepareMs: 30_000, uploadMs: 90_000, saveMs: 30_000 };
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

// The take with its recording time on the server's clock: the server's time, read with one quick
// request (taken as halfway through it), less how long ago the recording stopped. Measured when the
// take is first saved and kept, so a retry, or a save that waits behind another request, doesn't
// move it. How long ago is the longer of the two clocks' answers: the browser's clock may have been
// turned back meanwhile, and the steady clock stops while the device sleeps; either alone could
// make an older take look newer than it is. If the server can't be reached the take keeps no
// server time, and isn't saved until it has one (see saveTake).
async function onServerClock(take: Take, steps: SaveSteps, timeouts: Timeouts): Promise<Take> {
  if (take.serverRecordedAt !== null) return take;
  try {
    const sent = { wall: Date.now(), mono: performance.now() };
    const server = await within(timeouts.clockMs, steps.serverNow());
    const back = { wall: Date.now(), mono: performance.now() };
    if (!Number.isFinite(server)) return take;
    const ago = Math.max(
      (sent.wall + back.wall) / 2 - take.recordedAt,
      (sent.mono + back.mono) / 2 - take.recordedAtMono,
      0,
    );
    return { ...take, serverRecordedAt: Math.round(server - ago) };
  } catch {
    return take;
  }
}

// Saves a take as this week's draft: a signed upload path from the server, the upload straight to
// Storage, then saveDraft. A take that already has an uploaded path skips straight to saveDraft,
// which is safe to repeat for the same path.
export async function saveTake(take: Take, steps: SaveSteps): Promise<SaveOutcome> {
  const { prepare, upload, saveDraft, timeouts = TIMEOUTS } = steps;
  let current = await onServerClock(take, steps, timeouts);
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
    // Without the server's time there's no telling whether this take is newer than a draft saved
    // from elsewhere, so read the clock again, and if that fails too keep the take for Try again.
    if (current.serverRecordedAt === null) {
      current = await onServerClock(current, steps, timeouts);
      if (current.serverRecordedAt === null) return failed(current, OFFLINE_MESSAGE);
    }
    const saved = await within(
      timeouts.saveMs,
      saveDraft({
        path,
        durationMs: current.durationMs,
        recordedAt: current.serverRecordedAt,
        liveSessionId: current.liveSessionId ?? null,
      }),
    );
    // An upload kept from an earlier try that is now too old to save: the take itself is fine, so
    // upload it again rather than ask the member to record it again.
    if (saved.status === "error" && saved.code === "upload_expired" && reused) {
      return saveTake({ ...current, uploadedPath: null }, steps);
    }
    if (saved.status === "error") return failed(takeToRetry(saved.code, current), saved.message);
    if (saved.status === "superseded") return { step: "superseded" };
    return { step: "saved" };
  } catch (error) {
    // An upload that ran out of time may or may not have landed, so the take still has no uploaded
    // path and "Try again" asks for a fresh one. After a good upload it keeps the path.
    if (error instanceof TimedOut) return failed(current, TOO_SLOW_MESSAGE);
    const updated = updatedSinceLoad(error);
    return { step: "failed", take: current, message: updated ? REDEPLOYED_MESSAGE : OFFLINE_MESSAGE, updated };
  }
}
