"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, fail, GENERIC_ERROR, logError, NO_PERMISSION } from "@/lib/admin/errors";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { CHECKIN_GONE, NOT_GRADED } from "./messages";

// Master Admins (role hq) deleting a week's recording, or resetting the week's check-in (0007).
// Each action is a public POST endpoint. The database decides who may: the function runs as the
// signed-in user and refuses anyone but hq, and only then hands back the files to delete. Those
// are removed with the service role (Storage doesn't let SQL delete files, and no one may delete
// them through the API). Storage deletion is separate from the database transaction, so failures
// are queued for the daily housekeeping job rather than reported as a successful deletion.

const BUCKET = "checkin-audio";
const CLEANUP_QUEUE = "storage_cleanup_queue";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcError = { code?: string; message?: string } | null;

function refusal(error: NonNullable<RpcError>, context: string): { ok: false; error: string } {
  if (error.code === "42501") return fail(NO_PERMISSION);
  if (error.code === "P0001" && error.message === "no_checkin") return fail(CHECKIN_GONE);
  if (error.code === "P0001" && error.message === "not_graded") return fail(NOT_GRADED);
  logError(context, error);
  return fail(GENERIC_ERROR);
}

async function removeFiles(paths: string[], context: string): Promise<boolean> {
  if (paths.length === 0) return true;
  let admin: ReturnType<typeof createServiceRoleClient> | null = null;
  try {
    admin = createServiceRoleClient();
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (!error) return true;
    logError(`${context}: removing files`, error);
  } catch (error) {
    logError(`${context}: removing files`, error);
  }

  // The database change has already committed. Keep the paths durably retryable, and do not tell
  // the caller that the recording was permanently deleted.
  if (admin) {
    try {
      await admin.from(CLEANUP_QUEUE).upsert(paths.map((path) => ({ path })), { onConflict: "path" });
    } catch (error) {
      logError(`${context}: queueing file cleanup`, error);
    }
  }
  return false;
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
  const paths = (Array.isArray(data) ? data : [data]).filter((p): p is string => typeof p === "string");
  const removed = await removeFiles(paths, context);
  revalidatePath("/portal/dashboard", "layout");
  revalidatePath("/portal/checkin");
  return removed ? { ok: true, value: null } : fail(GENERIC_ERROR);
}

// Deletes the recording of a graded check-in; its transcript and scores stay.
export async function deleteRecording(checkinId: string): Promise<ActionResult> {
  return run(checkinId, "hq_delete_checkin_recording", "deleteRecording");
}

// Deletes the check-in and its recording. In the current week the member can then record again.
export async function resetCheckin(checkinId: string): Promise<ActionResult> {
  return run(checkinId, "hq_reset_checkin", "resetCheckin");
}
