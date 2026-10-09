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
// them through the API). A file that fails to go is pointed at by nothing any more, so only its
// speaker can open it, and their housekeeping (tidyMemberAudio) removes it later.

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

async function removeFiles(paths: string[], context: string): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await createServiceRoleClient().storage.from(BUCKET).remove(paths);
    if (error) logError(`${context}: removing files`, error);
  } catch (error) {
    // The check-in is already changed; housekeeping picks the file up.
    logError(`${context}: removing files`, error);
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
  const paths = (Array.isArray(data) ? data : [data]).filter((p): p is string => typeof p === "string");
  await removeFiles(paths, context);
  revalidatePath("/portal/dashboard", "layout");
  revalidatePath("/portal/checkin");
  return { ok: true, value: null };
}

// Deletes the recording of a graded check-in; its transcript and scores stay.
export async function deleteRecording(checkinId: string): Promise<ActionResult> {
  return run(checkinId, "hq_delete_checkin_recording", "deleteRecording");
}

// Deletes the check-in and its recording. In the current week the member can then record again.
export async function resetCheckin(checkinId: string): Promise<ActionResult> {
  return run(checkinId, "hq_reset_checkin", "resetCheckin");
}
