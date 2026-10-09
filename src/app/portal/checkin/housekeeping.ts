import "server-only";
import { isOwnAudioPath } from "@/lib/checkin/audio";
import { processCheckin } from "@/lib/checkin/process";
import { createServiceRoleClient } from "@/lib/supabase/admin";

const BUCKET = "checkin-audio";

// Signed upload URLs live 2 hours, and saveDraft refuses a take uploaded longer ago than that. So a
// file nobody points at after 3 hours can never become a draft or a check-in, and is safe to delete.
export const UPLOAD_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const ORPHAN_AGE_MS = 3 * 60 * 60 * 1000;

// The rule of claim_checkin_processing (0004), so the page only schedules work the claim will hand
// out: submitted, not graded, attempts left, and no attempt running (none started, the last one
// failed, or it started over 10 minutes ago and must have died).
const MAX_ATTEMPTS = 5;
const STALE_ATTEMPT_MS = 10 * 60 * 1000;
// Plus a pause after a failed attempt: 1, 2, 4, then 8 minutes. Every render of the page retries
// (and every action on it re-renders it), so without one a short outage would use up all five
// attempts within seconds.
const RETRY_PAUSE_MS = 60 * 1000;

export type ProcessingState = {
  submitted_at: string | null;
  graded_at: string | null;
  processing_started_at: string | null;
  processing_error: string | null;
  processing_attempts: number;
};

export function needsProcessing(checkin: ProcessingState, now: Date = new Date()): boolean {
  if (!checkin.submitted_at || checkin.graded_at) return false;
  if (checkin.processing_attempts >= MAX_ATTEMPTS) return false;
  if (!checkin.processing_started_at) return true;
  const sinceStart = now.getTime() - Date.parse(checkin.processing_started_at);
  if (checkin.processing_error) {
    return sinceStart >= RETRY_PAUSE_MS * 2 ** Math.max(0, checkin.processing_attempts - 1);
  }
  return sinceStart > STALE_ATTEMPT_MS;
}

// An entry from storage list() of a member's folder (names are relative to the folder).
export type StoredFile = { name: string; id: string | null; created_at: string | null };

// The files in a member's folder that are old enough and that no draft or check-in points at:
// takes that were uploaded but never saved, or saved and then replaced while a delete failed.
export function orphanedFiles(
  memberId: string,
  files: readonly StoredFile[],
  keep: ReadonlySet<string>,
  now: Date = new Date(),
): string[] {
  return files.flatMap((file) => {
    if (file.id === null) return []; // a folder, not a file
    const path = `${memberId}/${file.name}`;
    if (keep.has(path) || !isOwnAudioPath(path, memberId)) return [];
    const created = file.created_at ? Date.parse(file.created_at) : Number.NaN;
    if (!Number.isFinite(created) || now.getTime() - created < ORPHAN_AGE_MS) return [];
    return [path];
  });
}

// Clears out a member's leftovers: drafts from weeks that have closed (rows and files), and
// orphaned files. Best-effort and never throws: it runs after the page has been sent, and anything
// it misses is picked up on the next visit.
export async function tidyMemberAudio(memberId: string, weekStart: string): Promise<void> {
  try {
    const admin = createServiceRoleClient();
    const bucket = admin.storage.from(BUCKET);

    // A draft from an earlier week can't be submitted any more: the window closed on Sunday.
    const { data: stale, error: staleError } = await admin
      .from("checkin_drafts")
      .delete()
      .eq("member_id", memberId)
      .lt("week_start", weekStart)
      .select("audio_path");
    if (staleError) {
      console.error("tidyMemberAudio: deleting old drafts failed", { code: staleError.code });
      return;
    }

    // Read the drafts before the check-ins: submitting moves a path from one to the other in a
    // single transaction, so read in this order a path being submitted is seen in at least one.
    // Read after the delete above, so a stale draft that was submitted meanwhile (just before
    // midnight) shows up as a check-in.
    const drafts = await admin.from("checkin_drafts").select("audio_path").eq("member_id", memberId);
    const checkins = drafts.error
      ? null
      : await admin.from("checkins").select("audio_path").eq("member_id", memberId).not("audio_path", "is", null);
    const listing = checkins && !checkins.error ? await bucket.list(memberId, { limit: 1000 }) : null;
    if (drafts.error || checkins?.error || listing?.error || !listing) {
      // Without the full picture, delete nothing: a stale draft's file may be a check-in's recording.
      console.error("tidyMemberAudio: listing files failed", {
        code: drafts.error?.code ?? checkins?.error?.code ?? listing?.error?.name,
      });
      return;
    }
    const keep = new Set<string>(
      [...(drafts.data ?? []), ...(checkins?.data ?? [])].map((row: { audio_path: string }) => row.audio_path),
    );
    const remove = [
      ...(stale ?? [])
        .map((row: { audio_path: string }) => row.audio_path)
        .filter((path) => !keep.has(path) && isOwnAudioPath(path, memberId)),
      ...orphanedFiles(memberId, listing.data ?? [], keep),
    ];

    if (remove.length === 0) return;
    const { error: removeError } = await bucket.remove([...new Set(remove)]);
    if (removeError) console.error("tidyMemberAudio: removing files failed", { code: removeError.name });
  } catch (error) {
    console.error("tidyMemberAudio failed", { code: error instanceof Error ? error.name : "unknown" });
  }
}

// Recordings are kept 90 days: the privacy notice says so. forget_expired_checkin_audio (0004)
// takes every file older than that off the check-in or draft that points at it and returns the
// files, which this then deletes. A file it fails to delete is returned again on the next run.
// Run daily with processPendingCheckins. Never throws.
const REMOVE_BATCH = 100;

// Retries paths detached by an action whose Storage request failed. Successful paths are removed
// from the queue; failures remain for the next scheduled sweep.
async function retryQueuedRemovals(admin: ReturnType<typeof createServiceRoleClient>): Promise<number> {
  // This guard lets older deployments continue retention cleanup until the migration lands.
  if (typeof (admin as unknown as { from?: unknown }).from !== "function") return 0;
  const { data, error } = await admin
    .from("storage_cleanup_queue")
    .select("path")
    .order("queued_at", { ascending: true })
    .limit(REMOVE_BATCH);
  if (error) {
    console.error("deleteExpiredRecordings: reading cleanup queue failed", { code: error.code });
    return 0;
  }
  const paths = (data ?? []).map((row: { path: string }) => row.path);
  if (paths.length === 0) return 0;
  const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
  if (removeError) {
    console.error("deleteExpiredRecordings: retrying cleanup failed", { code: removeError.name });
    return 0;
  }
  const { error: clearError } = await admin.from("storage_cleanup_queue").delete().in("path", paths);
  if (clearError) {
    console.error("deleteExpiredRecordings: clearing cleanup queue failed", { code: clearError.code });
    return 0;
  }
  return paths.length;
}

export async function deleteExpiredRecordings(): Promise<{ deleted: number } | null> {
  try {
    const admin = createServiceRoleClient();
    const queued = await retryQueuedRemovals(admin);
    const { data, error } = await admin.rpc("forget_expired_checkin_audio");
    if (error) {
      console.error("deleteExpiredRecordings: finding expired recordings failed", { code: error.code });
      return null;
    }
    const names = (data ?? []) as string[];
    for (let i = 0; i < names.length; i += REMOVE_BATCH) {
      const { error: removeError } = await admin.storage.from(BUCKET).remove(names.slice(i, i + REMOVE_BATCH));
      if (removeError) {
        console.error("deleteExpiredRecordings: removing files failed", { code: removeError.name });
        return null;
      }
    }
    return { deleted: queued + names.length };
  } catch (error) {
    console.error("deleteExpiredRecordings failed", { code: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

// How many submitted check-ins one sweep picks up. They are processed side by side, and each
// attempt stays within the function's 300 seconds (see process.ts). Never-tried check-ins come
// first, then the ones tried longest ago: a check-in that just failed (or is running) goes to the
// back, so a few that keep failing can't take every run's places, or the query's, from the rest.
const SWEEP_LIMIT = 20;

// Processes every submitted check-in that is due an attempt (needsProcessing), for everyone. Run on
// a schedule (src/app/api/cron/process-checkins), so a failed or stalled attempt is retried even
// if the member never opens the check-in page again. The claim in processCheckin stops two runs
// (or a run and a page view) processing the same check-in at once. Never throws.
export async function processPendingCheckins(now: Date = new Date()): Promise<{ due: number; graded: number } | null> {
  try {
    const { data, error } = await createServiceRoleClient()
      .from("checkins")
      .select("id, submitted_at, graded_at, processing_started_at, processing_error, processing_attempts")
      .not("submitted_at", "is", null)
      .is("graded_at", null)
      // A recording deleted after 90 days can't be processed any more (the claim skips it), so
      // such rows must not take up the batch.
      .not("audio_path", "is", null)
      .lt("processing_attempts", MAX_ATTEMPTS)
      .order("processing_started_at", { ascending: true, nullsFirst: true })
      .limit(SWEEP_LIMIT * 5);
    if (error) {
      console.error("processPendingCheckins: reading check-ins failed", { code: error.code });
      return null;
    }
    const due = ((data ?? []) as (ProcessingState & { id: string })[])
      .filter((row) => needsProcessing(row, now))
      .slice(0, SWEEP_LIMIT);
    const outcomes = await Promise.all(due.map((row) => processCheckin(row.id)));
    return { due: due.length, graded: outcomes.filter((outcome) => outcome === "graded").length };
  } catch (error) {
    console.error("processPendingCheckins failed", { code: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
