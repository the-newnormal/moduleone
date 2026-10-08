import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { gradeCheckin, GradingError } from "@/lib/grader";
import { transcribe, TranscriptionError } from "@/lib/stt";

export type ProcessOutcome = "graded" | "skipped" | "failed";

type Claim = {
  member_id: string;
  audio_path: string;
  audio_duration_ms: number | null;
  // Saved by an earlier attempt whose grading failed.
  transcript: string | null;
  attempts: number;
};

const BUCKET = "checkin-audio";

// Transcribes and grades one submitted check-in, then stores the result. Safe to call more than
// once and from several places at the same time: claim_checkin_processing (0004) hands each attempt
// to one caller only, and a graded check-in is never processed again.
//
// Never throws: it runs inside after(), where an exception would only end up in the logs. Failures
// are recorded in checkins.processing_error and retried on a later claim (up to five attempts).
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
  const claim = (claimed as Claim[] | null)?.[0];
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

  // 1. The transcript: the one an earlier attempt saved, or a new one, saved straight away so a
  // grading failure doesn't cost a second transcription.
  let transcript = claim.transcript;
  if (transcript === null) {
    const { data: blob, error: downloadError } = await admin.storage.from(BUCKET).download(claim.audio_path);
    if (downloadError || !blob) return fail("download_failed", downloadError);
    const filename = claim.audio_path.slice(claim.audio_path.lastIndexOf("/") + 1);

    let result;
    try {
      result = await transcribe({
        data: new Uint8Array(await blob.arrayBuffer()),
        mimeType: blob.type || mimeFromFilename(filename),
        filename,
        durationSeconds: claim.audio_duration_ms === null ? undefined : claim.audio_duration_ms / 1000,
      });
    } catch (error) {
      return fail(error instanceof TranscriptionError ? "transcription_failed" : "transcription_error", error);
    }
    const { error: transcriptError } = await admin
      .from("checkins")
      .update({
        transcript: result.text,
        transcript_model: `${result.provider}:${result.model}`,
        transcript_warnings: result.warnings,
      })
      .eq("id", checkinId);
    if (transcriptError) return fail("save_transcript_failed", transcriptError);
    transcript = result.text;
  }

  // 2. The grade.
  let grade;
  try {
    grade = await gradeCheckin({ transcript });
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
