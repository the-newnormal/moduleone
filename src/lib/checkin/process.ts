import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { gradeCheckin, GradingError, type GradeUsage } from "@/lib/grader";
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
// Downloading, transcribing and grading share ATTEMPT_BUDGET_MS; each database write gets
// SAVE_MS of its own, so even a write after the budget has run out finishes inside 300 seconds.
// Transcribing a 10-minute recording normally takes well under a minute, and grading one about as
// long; the transcript is saved before grading, so a retry after a slow grade only grades.
const ATTEMPT_BUDGET_MS = 240_000;
const DOWNLOAD_MS = 60_000;
const TRANSCRIBE_BUDGET_MS = 150_000;
const SAVE_MS = 20_000;
// If transcribing left less than this, grading waits for the next attempt (which reuses the saved
// transcript and has the whole budget) instead of starting and being cut off.
const GRADE_MIN_MS = 120_000;

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
    admin = createServiceRoleClient();
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
  const attemptEnds = Date.now() + ATTEMPT_BUDGET_MS;

  const fail = async (code: string, error: unknown, { giveBackAttempt = false } = {}) => {
    // A short, stable reason for whoever looks at the row; no transcript text, no secrets.
    const message = `${code}: ${describe(error)}`.slice(0, 500);
    console.error("processCheckin failed", { checkinId, attempt: claim.attempts, code, error: describe(error) });
    // Set rather than decremented: no other caller can claim the row while this attempt runs.
    const values = giveBackAttempt
      ? { processing_error: message, processing_attempts: claim.attempts - 1 }
      : { processing_error: message };
    const { error: updateError } = await admin
      .from("checkins")
      .update(values)
      .eq("id", checkinId)
      .abortSignal(AbortSignal.timeout(SAVE_MS));
    if (updateError) console.error("processCheckin: could not record the failure", { checkinId, code: updateError.code });
    return "failed" as const;
  };

  // 1. The transcript: the one an earlier attempt saved, or a new one, saved straight away so a
  // grading failure doesn't cost a second transcription.
  let transcript = claim.transcript;
  if (transcript === null) {
    const { data: blob, error: downloadError } = await admin.storage
      .from(BUCKET)
      .download(claim.audio_path, undefined, { signal: AbortSignal.any([attempt, AbortSignal.timeout(DOWNLOAD_MS)]) });
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
      if (!(error instanceof TranscriptionError)) return fail("transcription_error", error);
      // As for the grader below: a setup problem (no or a wrong OPENAI_API_KEY, no credit, nothing
      // configured) fails every check-in until it's fixed, so it doesn't use up an attempt.
      return fail("transcription_failed", error, { giveBackAttempt: error.config });
    }
    const transcriptModel = `${result.provider}:${result.model}`;
    const [{ error: transcriptError }] = await Promise.all([
      admin
        .from("checkins")
        .update({ transcript: result.text, transcript_model: transcriptModel, transcript_warnings: result.warnings })
        .eq("id", checkinId)
        .abortSignal(AbortSignal.timeout(SAVE_MS)),
      recordCost(admin, checkinId, [{ step: "transcription", model: transcriptModel, audio_ms: claim.audio_duration_ms }]),
    ]);
    if (transcriptError) return fail("save_transcript_failed", transcriptError);
    transcript = result.text;
    // Not a failure of the check-in, so it doesn't use up an attempt.
    if (attemptEnds - Date.now() < GRADE_MIN_MS) {
      return fail("grading_deferred", new Error("Too little of this attempt left to grade; the next one grades the saved transcript."), {
        giveBackAttempt: true,
      });
    }
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
  const [{ error: gradeError }] = await Promise.all([
    admin
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
      .is("graded_at", null)
      .abortSignal(AbortSignal.timeout(SAVE_MS)),
    recordCost(
      admin,
      checkinId,
      grade.attempts.map((attempt) => ({ step: "grading" as const, model: attempt.model, ...usageColumns(attempt.usage) })),
    ),
  ]);
  if (gradeError) return fail("save_grade_failed", gradeError);
  return "graded";
}

type CostRow =
  | { step: "transcription"; model: string; audio_ms: number | null }
  | {
      step: "grading";
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    };

function usageColumns(usage: GradeUsage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
  };
}

// Logs a paid call in processing_costs (0007) for the admin Costs page. Runs alongside the save
// that follows the call, inside the same SAVE_MS, and never fails the check-in: a missing row
// only makes the month's total a little low.
async function recordCost(admin: ReturnType<typeof createServiceRoleClient>, checkinId: string, rows: CostRow[]): Promise<void> {
  const step = rows[0]?.step;
  try {
    const { error } = await admin
      .from("processing_costs")
      .insert(rows.map((row) => ({ checkin_id: checkinId, ...row })))
      .abortSignal(AbortSignal.timeout(SAVE_MS));
    if (error) console.error("processCheckin: could not record the cost", { checkinId, step, code: error.code });
  } catch (error) {
    console.error("processCheckin: could not record the cost", { checkinId, step, error: describe(error) });
  }
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
