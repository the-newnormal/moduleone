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

// Time limits for one attempt. The function running it (the check-in page's after(), or the cron
// route) is stopped at 300 seconds, and a stopped attempt records nothing, so it would only be
// retried 10 minutes later. Stopping here instead records the failure so the usual retries apply.
// Transcribing a 10-minute recording normally takes well under a minute, and grading one about as
// long; the transcript is saved before grading, so a retry after a slow grade only grades.
const ATTEMPT_BUDGET_MS = 270_000;
const TRANSCRIBE_BUDGET_MS = 120_000;

// Transcribes and grades one submitted check-in, then stores the result. Safe to call more than
// once and from several places at the same time: claim_checkin_processing (0004) hands each attempt
// to one caller only, and a graded check-in is never processed again.
//
// Never throws: it runs inside after(), where an exception would only end up in the logs. Failures
// are recorded in checkins.processing_error and retried on a later claim (up to five attempts; a
// grader configuration failure doesn't use one up, see below).
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
  const attempt = AbortSignal.timeout(ATTEMPT_BUDGET_MS);

  const fail = async (code: string, error: unknown, { giveBackAttempt = false } = {}) => {
    // A short, stable reason for whoever looks at the row; no transcript text, no secrets.
    const message = `${code}: ${describe(error)}`.slice(0, 500);
    console.error("processCheckin failed", { checkinId, attempt: claim.attempts, code, error: describe(error) });
    // Set rather than decremented: no other caller can claim the row while this attempt runs.
    const values = giveBackAttempt
      ? { processing_error: message, processing_attempts: claim.attempts - 1 }
      : { processing_error: message };
    const { error: updateError } = await admin.from("checkins").update(values).eq("id", checkinId);
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
      result = await transcribe(
        {
          data: new Uint8Array(await blob.arrayBuffer()),
          mimeType: blob.type || mimeFromFilename(filename),
          filename,
          durationSeconds: claim.audio_duration_ms === null ? undefined : claim.audio_duration_ms / 1000,
        },
        { signal: AbortSignal.any([attempt, AbortSignal.timeout(TRANSCRIBE_BUDGET_MS)]) },
      );
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
    grade = await gradeCheckin({ transcript, signal: attempt });
  } catch (error) {
    if (!(error instanceof GradingError)) return fail("grading_error", error);
    // A configuration problem (no or a wrong ANTHROPIC_API_KEY, a model or request the API won't
    // take) fails every check-in the same way until someone fixes it, and costs nothing to try
    // again: no reply is generated. So it doesn't use up an attempt, and the first visit after the
    // fix grades the check-in.
    return fail(`grading_${error.reason}`, error, { giveBackAttempt: error.reason === "api" && !error.retryable });
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
