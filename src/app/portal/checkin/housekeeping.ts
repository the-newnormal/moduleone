import "server-only";
import { isOwnAudioPath } from "@/lib/checkin/audio";
import { createAdminClient } from "@/lib/supabase/admin";

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
    const admin = createAdminClient();
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
    const remove = (stale ?? [])
      .map((row: { audio_path: string }) => row.audio_path)
      .filter((path) => isOwnAudioPath(path, memberId));

    // Read the drafts before the check-ins: submitting moves a path from one to the other in a
    // single transaction, so read in this order a path being submitted is seen in at least one.
    const drafts = await admin.from("checkin_drafts").select("audio_path").eq("member_id", memberId);
    const checkins = drafts.error
      ? null
      : await admin.from("checkins").select("audio_path").eq("member_id", memberId).not("audio_path", "is", null);
    const listing = checkins && !checkins.error ? await bucket.list(memberId, { limit: 1000 }) : null;
    if (drafts.error || checkins?.error || listing?.error || !listing) {
      console.error("tidyMemberAudio: listing files failed", {
        code: drafts.error?.code ?? checkins?.error?.code ?? listing?.error?.name,
      });
    } else {
      const keep = new Set<string>(
        [...(drafts.data ?? []), ...(checkins?.data ?? [])].map((row: { audio_path: string }) => row.audio_path),
      );
      remove.push(...orphanedFiles(memberId, listing.data ?? [], keep));
    }

    if (remove.length === 0) return;
    const { error: removeError } = await bucket.remove([...new Set(remove)]);
    if (removeError) console.error("tidyMemberAudio: removing files failed", { code: removeError.name });
  } catch (error) {
    console.error("tidyMemberAudio failed", { code: error instanceof Error ? error.name : "unknown" });
  }
}
