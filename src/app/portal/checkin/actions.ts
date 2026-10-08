"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { baseMimeType, draftPath, extensionFor, isOwnAudioPath, MAX_AUDIO_BYTES } from "@/lib/checkin/audio";
import { noticeVersion } from "@/lib/checkin/notice";
import { processCheckin } from "@/lib/checkin/process";
import { currentWeekStart } from "@/lib/checkin/week";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { UPLOAD_MAX_AGE_MS } from "./housekeeping";

// Every action here is a public POST endpoint. Each one takes the member from the session (never
// from its arguments), checks anything the browser sends against that member, and writes with the
// service role, as CLAUDE.md requires. Results are plain objects for the page to show; logs carry
// error codes only.

export type CheckinErrorCode =
  | "signed_out"
  | "no_member"
  | "notice_required"
  | "unsupported_audio"
  | "bad_path"
  | "upload_missing"
  | "upload_expired"
  | "upload_too_big"
  | "upload_not_audio"
  | "no_draft"
  | "failed";

export type CheckinError = { status: "error"; code: CheckinErrorCode; message: string };
// This week's check-in is already in; the page shows that instead.
export type Submitted = { status: "submitted" };

export type AcceptNoticeResult = { status: "accepted" } | CheckinError;
export type PrepareRecordingResult =
  | { status: "ready"; path: string; token: string; contentType: string }
  | Submitted
  | CheckinError;
export type SaveDraftResult = { status: "saved" } | Submitted | CheckinError;
export type DeleteDraftResult = { status: "deleted" } | CheckinError;
export type SubmitCheckinResult = Submitted | CheckinError;

const PAGE = "/portal/checkin";
const BUCKET = "checkin-audio";
const MAX_DURATION_MS = 60 * 60 * 1000; // the database's range for duration_ms

const MESSAGES: Record<CheckinErrorCode, string> = {
  signed_out: "Your session has ended. Sign in again.",
  no_member: "Your account isn't set up yet. Ask HQ.",
  notice_required: "Read the privacy notice first.",
  unsupported_audio: "This browser records in a format we can't use. Try Chrome or Safari.",
  bad_path: "That recording can't be saved. Record it again.",
  upload_missing: "The recording didn't finish uploading. Try again.",
  upload_expired: "That recording is too old to save. Record it again.",
  upload_too_big: "That recording is too long to save. Record a shorter one.",
  upload_not_audio: "That file isn't a recording. Record it again.",
  no_draft: "Record your answers before you submit.",
  failed: "Something went wrong. Try again.",
};

function fail(code: CheckinErrorCode): CheckinError {
  return { status: "error", code, message: MESSAGES[code] };
}

// The page shows the submitted check-in (or the notice) instead of what the member was doing, so
// these re-render it.
function submitted(): Submitted {
  revalidatePath(PAGE);
  return { status: "submitted" };
}

function noticeRequired(): CheckinError {
  revalidatePath(PAGE);
  return fail("notice_required");
}

type Session = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  member: { id: string; team_id: string | null };
};

// The signed-in member, read through RLS (members_select lets a user read their own row).
async function sessionMember(): Promise<Session | CheckinError> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return fail("signed_out");
  const { data: member, error } = await supabase
    .from("members")
    .select("id, team_id")
    .eq("auth_user_id", data.claims.sub)
    .maybeSingle();
  if (error) {
    console.error("checkin: reading the member failed", { code: error.code });
    return fail("failed");
  }
  if (!member) return fail("no_member");
  return { supabase, member };
}

// Whether the member has accepted the current privacy notice. Checked before recording and again
// before submitting, because submitting is what sends the recording to the transcription service,
// and a change of service changes the notice.
async function noticeAccepted({ supabase, member }: Session): Promise<boolean | CheckinError> {
  const { data, error } = await supabase
    .from("recording_notices")
    .select("member_id")
    .eq("member_id", member.id)
    .eq("notice_version", noticeVersion())
    .maybeSingle();
  if (error) {
    console.error("checkin: reading the notice failed", { code: error.code });
    return fail("failed");
  }
  return data !== null;
}

// Errors raised by the 0004 functions: SQLSTATE P0001 with a stable message.
function raised(error: { code?: string; message?: string } | null, message: string): boolean {
  return error?.code === "P0001" && error.message === message;
}

// Deletes a file in the member's folder unless a check-in points at it. Best-effort: a file left
// behind is removed later by the page's housekeeping.
async function removeFile(admin: ReturnType<typeof createAdminClient>, memberId: string, path: string) {
  if (!isOwnAudioPath(path, memberId)) return;
  const { data: used, error } = await admin
    .from("checkins")
    .select("id")
    .eq("member_id", memberId)
    .eq("audio_path", path)
    .limit(1);
  if (error || (used ?? []).length > 0) return;
  const { error: removeError } = await admin.storage.from(BUCKET).remove([path]);
  if (removeError) console.error("checkin: removing a file failed", { code: removeError.name });
}

export async function acceptNotice(): Promise<AcceptNoticeResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  const { error } = await createAdminClient()
    .from("recording_notices")
    .upsert(
      { member_id: session.member.id, notice_version: noticeVersion() },
      // Keep the first acceptance time if the button is pressed twice.
      { onConflict: "member_id,notice_version", ignoreDuplicates: true },
    );
  if (error) {
    console.error("acceptNotice failed", { code: error.code });
    return fail("failed");
  }
  revalidatePath(PAGE);
  return { status: "accepted" };
}

// A signed upload URL (upsert off) for a new take in the member's own folder. The browser uploads
// the audio straight to Storage, so it never passes through this server (Vercel caps request
// bodies at 4.5 MB).
export async function prepareRecording(mimeType: string): Promise<PrepareRecordingResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  const accepted = await noticeAccepted(session);
  if (accepted !== true) return accepted === false ? noticeRequired() : accepted;

  const weekStart = currentWeekStart();
  const { data: existing, error } = await session.supabase
    .from("checkins")
    .select("id")
    .eq("member_id", session.member.id)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) {
    console.error("prepareRecording: reading the check-in failed", { code: error.code });
    return fail("failed");
  }
  if (existing) return submitted();

  const ext = typeof mimeType === "string" && mimeType.length <= 100 ? extensionFor(mimeType) : null;
  if (!ext) return fail("unsupported_audio");

  const path = draftPath(session.member.id, weekStart, ext);
  const { data: signed, error: signError } = await createAdminClient()
    .storage.from(BUCKET)
    .createSignedUploadUrl(path, { upsert: false });
  if (signError) {
    console.error("prepareRecording: signing the upload failed", { code: signError.name });
    return fail("failed");
  }
  return { status: "ready", path, token: signed.token, contentType: baseMimeType(mimeType) };
}

// Saves an uploaded take as this week's draft, replacing (and deleting) any earlier take.
export async function saveDraft(input: { path: string; durationMs?: number }): Promise<SaveDraftResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  const memberId = session.member.id;
  const path = typeof input?.path === "string" ? input.path : "";
  if (!isOwnAudioPath(path, memberId, currentWeekStart())) return fail("bad_path");

  // The upload went straight from the browser to Storage, so check what actually arrived.
  const admin = createAdminClient();
  const { data: file, error: infoError } = await admin.storage.from(BUCKET).info(path);
  if (infoError || !file) {
    const status = (infoError as { status?: number } | null)?.status;
    if (status === 400 || status === 404) return fail("upload_missing");
    console.error("saveDraft: reading the upload failed", { code: infoError?.name });
    return fail("failed");
  }
  const size = file.size ?? Number(file.metadata?.size);
  const mimeType = baseMimeType(String(file.contentType ?? file.metadata?.mimetype ?? ""));
  if (!Number.isFinite(size) || size <= 0) return fail("upload_missing");
  if (size > MAX_AUDIO_BYTES) {
    await removeFile(admin, memberId, path);
    return fail("upload_too_big");
  }
  if (!mimeType.startsWith("audio/")) {
    await removeFile(admin, memberId, path);
    return fail("upload_not_audio");
  }
  // Housekeeping deletes unsaved takes after 3 hours; never save one that old (see housekeeping.ts).
  const created = Date.parse(file.createdAt ?? "");
  if (Number.isFinite(created) && Date.now() - created > UPLOAD_MAX_AGE_MS) return fail("upload_expired");

  const { data: replaced, error } = await admin.rpc("save_checkin_draft", {
    p_member_id: memberId,
    p_audio_path: path,
    p_mime_type: mimeType,
    p_duration_ms: clampDuration(input?.durationMs),
  });
  if (raised(error, "already_submitted")) {
    // Too late for this take: the week's check-in is in.
    await removeFile(admin, memberId, path);
    return submitted();
  }
  if (error) {
    console.error("saveDraft: save_checkin_draft failed", { code: error.code });
    return fail("failed");
  }
  if (typeof replaced === "string" && replaced !== path) await removeFile(admin, memberId, replaced);
  revalidatePath(PAGE);
  return { status: "saved" };
}

export async function deleteDraft(): Promise<DeleteDraftResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  const admin = createAdminClient();
  const { data: path, error } = await admin.rpc("delete_checkin_draft", { p_member_id: session.member.id });
  if (error) {
    console.error("deleteDraft: delete_checkin_draft failed", { code: error.code });
    return fail("failed");
  }
  if (typeof path === "string") await removeFile(admin, session.member.id, path);
  revalidatePath(PAGE);
  return { status: "deleted" };
}

// Turns this week's draft into the check-in, then transcribes and grades it after the response
// (the page's maxDuration gives that time). No retake after this.
export async function submitCheckin(): Promise<SubmitCheckinResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  const accepted = await noticeAccepted(session);
  if (accepted !== true) return accepted === false ? noticeRequired() : accepted;

  const { data: id, error } = await createAdminClient().rpc("submit_checkin_draft", {
    p_member_id: session.member.id,
  });
  if (raised(error, "already_submitted")) return submitted();
  if (raised(error, "no_draft")) {
    revalidatePath(PAGE);
    return fail("no_draft");
  }
  if (error || typeof id !== "string") {
    console.error("submitCheckin: submit_checkin_draft failed", { code: error?.code });
    return fail("failed");
  }
  after(() => processCheckin(id));
  return submitted();
}

// The recorder's own measure of the take's length: only a hint, so anything odd becomes null.
function clampDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value)));
}
