"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { baseMimeType, draftPath, extensionFor, isOwnAudioPath, MAX_AUDIO_BYTES } from "@/lib/checkin/audio";
import { noticeVersion } from "@/lib/checkin/notice";
import { processCheckin } from "@/lib/checkin/process";
import { currentWeekStart } from "@/lib/checkin/week";
import { createServiceRoleClient } from "@/lib/supabase/admin";
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
  | "draft_changed"
  | "failed";

export type CheckinError = { status: "error"; code: CheckinErrorCode; message: string };
// This week's check-in is already in; the page shows that instead.
export type Submitted = { status: "submitted" };

export type AcceptNoticeResult = { status: "accepted" } | CheckinError;
export type PrepareRecordingResult =
  | { status: "ready"; path: string; token: string; contentType: string }
  | Submitted
  | CheckinError;
// superseded: a take recorded later is already this week's draft, so this one was dropped (and its
// upload deleted). The page isn't re-rendered, so the recorder can tell the member first.
export type SaveDraftResult = { status: "saved" } | { status: "superseded" } | Submitted | CheckinError;
// path: the deleted take's recording, so the recorder can drop a failed save of that same take.
export type DeleteDraftResult = { status: "deleted"; path: string | null } | CheckinError;
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
  upload_expired: "Saving took too long, so the recording has to be uploaded again. Try again.",
  upload_too_big: "That recording is too long to save. Record a shorter one.",
  upload_not_audio: "That file isn't a recording. Record it again.",
  no_draft: "Record your answers before you submit.",
  draft_changed: "Your recording was replaced from another tab or device. This is the one saved now.",
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
  authUserId: string;
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
  return { supabase, authUserId: data.claims.sub, member };
}

// Whether the member has accepted the current privacy notice, with this login. Checked before
// recording and again before submitting, because submitting is what sends the recording to the
// transcription service, and a change of service changes the notice.
async function noticeAccepted({ supabase, authUserId, member }: Session): Promise<boolean | CheckinError> {
  const { data, error } = await supabase
    .from("recording_notices")
    .select("member_id")
    .eq("member_id", member.id)
    .eq("auth_user_id", authUserId)
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
async function removeFile(admin: ReturnType<typeof createServiceRoleClient>, memberId: string, path: string) {
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

// `version` is the notice the member was shown. If the notice has changed since (a different
// transcription setup), they are shown the new one instead of agreeing to text they never saw.
export async function acceptNotice(version: string): Promise<AcceptNoticeResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  if (version !== noticeVersion()) return noticeRequired();
  const { error } = await createServiceRoleClient()
    .from("recording_notices")
    .upsert(
      { member_id: session.member.id, auth_user_id: session.authUserId, notice_version: noticeVersion() },
      // Keep the first acceptance time if the button is pressed twice.
      { onConflict: "member_id,auth_user_id,notice_version", ignoreDuplicates: true },
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
  const { data: signed, error: signError } = await createServiceRoleClient()
    .storage.from(BUCKET)
    .createSignedUploadUrl(path, { upsert: false });
  if (signError) {
    console.error("prepareRecording: signing the upload failed", { code: signError.name });
    return fail("failed");
  }
  return { status: "ready", path, token: signed.token, contentType: baseMimeType(mimeType) };
}

// Saves an uploaded take as this week's draft, replacing (and deleting) any earlier take. A take
// recorded before the current draft is dropped instead: it arrived late (a save that timed out,
// or one retried from another tab or device), and must not replace the newer one. `recordedAt` is
// when the take was recorded, by this server's clock (see take.ts); without a plausible one, the
// take can't replace another take either way.
export async function saveDraft(input: {
  path: string;
  durationMs?: number;
  recordedAt?: number | null;
}): Promise<SaveDraftResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  const memberId = session.member.id;
  const path = typeof input?.path === "string" ? input.path : "";
  if (!isOwnAudioPath(path, memberId, currentWeekStart())) return fail("bad_path");

  // The upload went straight from the browser to Storage, so check what actually arrived.
  const admin = createServiceRoleClient();
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
  // The browser chose the uploaded file's type, so check it against the same list as
  // prepareRecording and against the path's extension: a .webm that claims to be audio/wav would
  // only fail at transcription, using up an attempt.
  const ext = extensionFor(mimeType);
  if (!ext || !path.endsWith(`.${ext}`)) {
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
    p_recorded_at: recordedAt(input?.recordedAt),
  });
  if (raised(error, "newer_draft")) {
    await removeFile(admin, memberId, path);
    return { status: "superseded" };
  }
  // No plausible recording time, and another take is the draft: which is newer can't be told, so
  // save neither way. The recorder always sends one, so this is a bad request; the take is kept.
  if (raised(error, "unknown_order")) return fail("failed");
  if (raised(error, "already_submitted")) {
    // Too late for this take: the week's check-in is in.
    await removeFile(admin, memberId, path);
    return submitted();
  }
  // The database's own week check: the week turned while this request was on its way, or the path
  // is a check-in's recording. Housekeeping deletes the file later if nothing points at it.
  if (raised(error, "bad_path")) return fail("bad_path");
  if (error) {
    console.error("saveDraft: save_checkin_draft failed", { code: error.code });
    return fail("failed");
  }
  if (typeof replaced === "string" && replaced !== path) await removeFile(admin, memberId, replaced);
  revalidatePath(PAGE);
  return { status: "saved" };
}

// The draft the member was shown has been replaced since (another tab or device saved a newer
// take): show them that one instead of deleting or submitting a take they haven't heard.
function draftChanged(): CheckinError {
  revalidatePath(PAGE);
  return fail("draft_changed");
}

// Deletes this week's draft: `shown` is the take the member was looking at.
export async function deleteDraft(shown: string): Promise<DeleteDraftResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  if (typeof shown !== "string") return fail("bad_path");
  const admin = createServiceRoleClient();
  const { data: path, error } = await admin.rpc("delete_checkin_draft", {
    p_member_id: session.member.id,
    p_audio_path: shown,
  });
  if (raised(error, "draft_changed")) return draftChanged();
  if (error) {
    console.error("deleteDraft: delete_checkin_draft failed", { code: error.code });
    return fail("failed");
  }
  if (typeof path === "string") await removeFile(admin, session.member.id, path);
  revalidatePath(PAGE);
  return { status: "deleted", path: typeof path === "string" ? path : null };
}

// Turns this week's draft into the check-in, then transcribes and grades it after the response
// (the page's maxDuration gives that time). No retake after this. `shown` is the take the member
// listened to.
export async function submitCheckin(shown: string): Promise<SubmitCheckinResult> {
  const session = await sessionMember();
  if ("status" in session) return session;
  if (typeof shown !== "string") return fail("bad_path");
  const accepted = await noticeAccepted(session);
  if (accepted !== true) return accepted === false ? noticeRequired() : accepted;

  const { data: id, error } = await createServiceRoleClient().rpc("submit_checkin_draft", {
    p_member_id: session.member.id,
    p_audio_path: shown,
  });
  if (raised(error, "already_submitted")) return submitted();
  if (raised(error, "draft_changed")) return draftChanged();
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

// When the take was recorded. However old, a real time is kept, so an old take still loses to a
// newer one; a time that isn't a number, or is in the future, becomes null: unknown, so the
// database won't let the take replace another one. The database also caps the time at now.
function recordedAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value > Date.now() + 60_000) return null;
  return new Date(Math.max(0, value)).toISOString();
}

// The recorder's own measure of the take's length: only a hint, so anything odd becomes null.
function clampDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value)));
}
