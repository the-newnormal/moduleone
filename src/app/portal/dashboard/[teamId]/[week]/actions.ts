"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, fail, GENERIC_ERROR, logError, NO_PERMISSION } from "@/lib/admin/errors";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { CHECKIN_GONE, FILES_PENDING, NOT_GRADED } from "./messages";

// Master Admins (role hq) deleting a week's recording, or resetting the week's check-in (0007).
// Each action is a public POST endpoint. The database decides who may: the function runs as the
// signed-in user and refuses anyone but hq, and only then hands back its log row and the files to
// delete. Those are removed with the service role (Storage doesn't let SQL delete files, and no one
// may delete them through the API), and the row is stamped files_removed_at. If removing fails, the
// admin is told, and the daily job (removeResetRecordings) retries the unstamped row; meanwhile
// nothing points at the file, so only its speaker can open it.

const BUCKET = "checkin-audio";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcError = { code?: string; message?: string } | null;

function refusal(error: NonNullable<RpcError>, context: string): { ok: false; error: string } {
  if (error.code === "42501") return fail(NO_PERMISSION);
  if (error.code === "P0001" && error.message === "no_checkin") return fail(CHECKIN_GONE);
  if (error.code === "P0001" && error.message === "not_graded") return fail(NOT_GRADED);
  logError(context, error);
  return fail(GENERIC_ERROR);
}

type ResetRow = { reset_id: string; audio_paths: string[] };

// Whether the files went (or there were none). On false the row stays unstamped for the daily job.
async function removeFiles(row: ResetRow, context: string): Promise<boolean> {
  const paths = row.audio_paths.filter((p) => typeof p === "string");
  if (paths.length === 0) return true;
  try {
    const admin = createServiceRoleClient();
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) {
      logError(`${context}: removing files`, error);
      return false;
    }
    const { error: stampError } = await admin
      .from("checkin_resets")
      .update({ files_removed_at: new Date().toISOString() })
      .eq("id", row.reset_id);
    // The files are gone; the daily job's retry of a row it can't stamp finds nothing to remove.
    if (stampError) logError(`${context}: stamping the log`, stampError);
    return true;
  } catch (error) {
    logError(`${context}: removing files`, error);
    return false;
  }
}

async function run(
  checkinId: unknown,
  fn: "hq_delete_checkin_recording" | "hq_reset_checkin",
  context: string,
): Promise<ActionResult> {
  if (typeof checkinId !== "string" || !UUID.test(checkinId)) return fail(GENERIC_ERROR);
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return fail(NO_PERMISSION);

  const { data, error } = await supabase.rpc(fn, { p_checkin_id: checkinId.toLowerCase() });
  if (error) return refusal(error, context);
  // One row, or none when there was no recording to delete.
  const rows = (Array.isArray(data) ? data : []) as ResetRow[];
  let removed = true;
  for (const row of rows) removed = (await removeFiles(row, context)) && removed;
  revalidatePath("/portal/dashboard", "layout");
  revalidatePath("/portal/checkin");
  return removed ? { ok: true, value: null } : fail(FILES_PENDING);
}

// Deletes the recording of a check-in that is not waiting for the grader; its transcript and scores stay.
export async function deleteRecording(checkinId: string): Promise<ActionResult> {
  return run(checkinId, "hq_delete_checkin_recording", "deleteRecording");
}

// Deletes the check-in and its recording. In the current week the member can then record again.
export async function resetCheckin(checkinId: string): Promise<ActionResult> {
  return run(checkinId, "hq_reset_checkin", "resetCheckin");
}
