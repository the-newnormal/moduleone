import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { gradeCheckin, GradingError } from "@/lib/grader";
import { transcribe, TranscriptionError } from "@/lib/stt";

export type ProcessOutcome = "graded" | "skipped" | "failed";

const BUCKET = "checkin-audio";

/**
 * Transcribes and grades one submitted check-in, then stores the result. Safe to call more than
 * once and from several places at the same time: claim_checkin_processing (0004) hands each
 * attempt to one caller only, and a graded check-in is never processed again.
 *
 * Never throws: it runs inside after(), where an exception would only end up in the logs. Failures
 * are recorded in checkins.processing_error and retried on a later claim (up to five attempts).
 */
export async function processCheckin(checkinId: string): Promise<ProcessOutcome> {
  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    console.error("processCheckin: no service-role client", { checkinId, error: describe(error) });
    return "failed";
  }

  const { data: claimed, error: claimError } = await admin.rpc("claim_checkin_processing", {
    p_checkin_id: checkinId,
  });
  if (claimError) {
    console.error("processCheckin: claim failed", { checkinId, code: claimError.code });
    return "failed";
  }
  const claim = (claimed as { member_id: string; audio_path: string; attempts: number }[] | null)?.[0];
  if (!claim) return "skipped";

  const fail = async (code: string, error: unknown) => {
    // A short, stable reason for whoever looks at the row; no transcript text, no secrets.
    const message = `${code}: ${describe(error)}`.slice(0, 500);
    console.error("processCheckin failed", { checkinId, attempt: claim.attempts, code, error: describe(error) });
    const { error: updateError } = await admin
      .from("checkins")
      .update({ processing_error: message })
      .eq("id", checkinId);
    if (updateError) console.error("processCheckin: could not record the failure", { checkinId, code: updateError.code });
    return "failed" as const;
  };

  // 1. The recording.
  const { data: blob, error: downloadError } = await admin.storage.from(BUCKET).download(claim.audio_path);
  if (downloadError || !blob) return fail("download_failed", downloadError);
  const filename = claim.audio_path.slice(claim.audio_path.lastIndexOf("/") + 1);

  // 2. Transcript. Saved straight away, so a grading failure doesn't cost a second transcription.
  let transcript;
  try {
    transcript = await transcribe({
      data: new Uint8Array(await blob.arrayBuffer()),
      mimeType: blob.type || mimeFromFilename(filename),
      filename,
    });
  } catch (error) {
    return fail(error instanceof TranscriptionError ? "transcription_failed" : "transcription_error", error);
  }
  const { error: transcriptError } = await admin
    .from("checkins")
    .update({
      transcript: transcript.text,
      transcript_model: `${transcript.provider}:${transcript.model}`,
      transcript_warnings: transcript.warnings,
    })
    .eq("id", checkinId);
  if (transcriptError) return fail("save_transcript_failed", transcriptError);

  // 3. Grade.
  let grade;
  try {
    grade = await gradeCheckin({ transcript: transcript.text });
  } catch (error) {
    const code = error instanceof GradingError ? `grading_${error.reason}` : "grading_error";
    return fail(code, error);
  }
  const { error: gradeError } = await admin
    .from("checkins")
    .update({
      activity_score: grade.activity,
      excellence_score: grade.excellence,
      morale_score: grade.morale,
      category: grade.category,
      rubric_review: grade.review,
      grader_model: grade.model,
      graded_at: new Date().toISOString(),
      processing_error: null,
    })
    .eq("id", checkinId)
    .is("graded_at", null);
  if (gradeError) return fail("save_grade_failed", gradeError);
  return "graded";
}

function mimeFromFilename(filename: string): string {
  if (filename.endsWith(".m4a")) return "audio/mp4";
  if (filename.endsWith(".ogg")) return "audio/ogg";
  return "audio/webm";
}

function describe(error: unknown): string {
  if (!error) return "unknown error";
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}
