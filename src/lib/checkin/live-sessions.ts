import "server-only";
import { recordCosts, type Usage } from "@/lib/costs/record";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { isOwnAudioPath } from "./audio";

// The live check-in's sessions (live_checkin_sessions, 0011), through the functions that migration
// gives the server. Every function here takes the member from the caller, who took it from the
// session (src/lib/checkin/session.ts), and the database checks the session is theirs. Logs carry
// error codes only.

// How long a session's coach answers (a recording stops at 10 minutes), how many sessions a member
// may start a day (retakes included), how many coach calls one session may make, and how soon after
// the last one. Together they bound what one member can spend.
export const LIVE_SESSION_TTL_S = 15 * 60;
export const MAX_SESSIONS_PER_DAY = 12;
export const MAX_COACH_CALLS = 120;
export const MIN_COACH_INTERVAL_MS = 1_000;
const SAVE_MS = 10_000;

export type LiveSessionProblem =
  | "submitted"
  | "too_many_sessions"
  | "no_session"
  | "session_over"
  | "too_many_calls"
  | "too_soon"
  | "unavailable";

// P0001 errors raised by the 0011 functions, by message.
const RAISED: Record<string, LiveSessionProblem> = {
  already_submitted: "submitted",
  too_many_sessions: "too_many_sessions",
  no_session: "no_session",
  session_over: "session_over",
  too_many_calls: "too_many_calls",
  too_soon: "too_soon",
};

function problem(where: string, error: { code?: string; message?: string }): LiveSessionProblem {
  if (error.code === "P0001" && error.message && RAISED[error.message]) return RAISED[error.message];
  console.error(`live session: ${where} failed`, { code: error.code });
  return "unavailable";
}

function admin() {
  return createServiceRoleClient();
}

export async function startLiveSession(
  memberId: string,
  models: { stt: string; coach: string; coachRubric: string },
): Promise<{ id: string } | LiveSessionProblem> {
  const { data, error } = await admin()
    .rpc("start_live_checkin_session", {
      p_member_id: memberId,
      p_stt_model: models.stt,
      p_coach_model: models.coach,
      p_coach_rubric: models.coachRubric,
      p_ttl_seconds: LIVE_SESSION_TTL_S,
      p_max_per_day: MAX_SESSIONS_PER_DAY,
    })
    .abortSignal(AbortSignal.timeout(SAVE_MS));
  if (error) return problem("start", error);
  if (typeof data !== "string") return problem("start", { code: "no_id" });
  return { id: data };
}

export type Claim = { state: unknown; startedAt: string; callNumber: number };

export async function claimCoachCall(sessionId: string, memberId: string): Promise<Claim | LiveSessionProblem> {
  const { data, error } = await admin()
    .rpc("claim_live_coach_call", {
      p_session_id: sessionId,
      p_member_id: memberId,
      p_max_calls: MAX_COACH_CALLS,
      p_min_interval_ms: MIN_COACH_INTERVAL_MS,
    })
    .abortSignal(AbortSignal.timeout(SAVE_MS));
  if (error) return problem("claim", error);
  const row = (data as { coach_state: unknown; started_at: string; call_number: number }[] | null)?.[0];
  if (!row) return problem("claim", { code: "no_row" });
  return { state: row.coach_state, startedAt: row.started_at, callNumber: row.call_number };
}

// Saves a coach call's state unless a later call has been claimed since. Returns whether it saved.
export async function saveCoachState(
  sessionId: string,
  memberId: string,
  callNumber: number,
  state: object,
  recordedMs: number,
): Promise<boolean> {
  const { data, error } = await admin()
    .rpc("save_live_coach_state", {
      p_session_id: sessionId,
      p_member_id: memberId,
      p_call_number: callNumber,
      p_coach_state: state,
      p_recorded_ms: Math.round(recordedMs),
    })
    .abortSignal(AbortSignal.timeout(SAVE_MS));
  if (error) {
    problem("save", error);
    return false;
  }
  return data === true;
}

// The open session's state and its latest call number, for a last update as it ends (the end route
// counts the offer that was on screen). Null if it isn't the member's, or has ended.
export async function readOpenSession(
  sessionId: string,
  memberId: string,
): Promise<{ state: unknown; callNumber: number } | null> {
  try {
    const { data, error } = await admin()
      .from("live_checkin_sessions")
      .select("coach_state, coach_calls")
      .eq("id", sessionId)
      .eq("member_id", memberId)
      .is("ended_at", null)
      .abortSignal(AbortSignal.timeout(SAVE_MS))
      .maybeSingle();
    if (error) {
      problem("read", error);
      return null;
    }
    return data ? { state: data.coach_state, callNumber: data.coach_calls } : null;
  } catch (error) {
    console.error("live session: read failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

// Logs one coach read's tokens against the session.
export async function recordCoachCost(sessionId: string, model: string, usage: Usage): Promise<void> {
  await recordCosts(admin(), [{ step: "coaching", liveSessionId: sessionId, model, usage }]);
}

// Ends the member's session and logs its live transcription minutes, once.
export async function endLiveSession(sessionId: string, memberId: string, recordedMs: number): Promise<boolean> {
  const client = admin();
  const { data, error } = await client
    .rpc("end_live_checkin_session", { p_session_id: sessionId, p_member_id: memberId, p_recorded_ms: Math.round(recordedMs) })
    .abortSignal(AbortSignal.timeout(SAVE_MS));
  if (error) {
    problem("end", error);
    return false;
  }
  if (typeof data !== "number") return false; // not theirs, or already ended: nothing to log twice
  if (data === 0) return true; // nothing was transcribed (the key couldn't be minted, say)
  const { data: session } = await client.from("live_checkin_sessions").select("stt_model").eq("id", sessionId).maybeSingle();
  await recordCosts(client, [
    { step: "live_transcription", liveSessionId: sessionId, model: session?.stt_model ?? "openai:unknown", audioMs: data },
  ]);
  return true;
}

// The take recorded in a live session was saved as the member's draft: remember which, so the session
// can follow it to its check-in. Best-effort: a session that isn't linked is only missing from the
// coverage-versus-grade figures.
export async function linkLiveTake(sessionId: string, memberId: string, audioPath: string): Promise<void> {
  if (!isOwnAudioPath(audioPath, memberId)) return;
  try {
    const { error } = await admin()
      .from("live_checkin_sessions")
      .update({ audio_path: audioPath })
      .eq("id", sessionId)
      .eq("member_id", memberId)
      .is("checkin_id", null)
      .abortSignal(AbortSignal.timeout(SAVE_MS));
    if (error) console.error("live session: linking the take failed", { code: error.code });
  } catch (error) {
    console.error("live session: linking the take failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

// The draft became this check-in: link the session that recorded it, and let go of the path.
export async function linkLiveCheckin(memberId: string, audioPath: string, checkinId: string): Promise<void> {
  try {
    const { error } = await admin()
      .from("live_checkin_sessions")
      .update({ checkin_id: checkinId, audio_path: null })
      .eq("member_id", memberId)
      .eq("audio_path", audioPath)
      .abortSignal(AbortSignal.timeout(SAVE_MS));
    if (error) console.error("live session: linking the check-in failed", { code: error.code });
  } catch (error) {
    console.error("live session: linking the check-in failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

// The daily job: end sessions the browser never ended, logging their live transcription, and delete
// sessions whose take never became a check-in (0011's tidy_live_checkin_sessions).
// Null if it failed, so the job's other tasks still report.
export async function tidyLiveSessions(): Promise<{ ended: number } | null> {
  try {
    const client = admin();
    const { data, error } = await client.rpc("tidy_live_checkin_sessions", { p_limit: 500 }).abortSignal(AbortSignal.timeout(SAVE_MS));
    if (error) {
      console.error("live session: tidying failed", { code: error.code });
      return null;
    }
    const ended = (data as { session_id: string; stt_model: string; recorded_ms: number }[] | null) ?? [];
    await recordCosts(
      client,
      ended
        .filter((s) => s.recorded_ms > 0)
        .map((s) => ({ step: "live_transcription" as const, liveSessionId: s.session_id, model: s.stt_model, audioMs: s.recorded_ms })),
    );
    return { ended: ended.length };
  } catch (error) {
    console.error("live session: tidying failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
