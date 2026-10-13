import { z } from "zod";
import { readTranscript } from "@/lib/coach";
import { acknowledge, moreToAsk, parseState } from "@/lib/coach/policy";
import { coachInstructions } from "@/lib/coach/prompt";
import { coachTurn } from "@/lib/coach/turn";
import { liveCheckinEnabled } from "@/lib/checkin/live-config";
import { claimCoachCall, recordCoachCost, saveCoachState } from "@/lib/checkin/live-sessions";
import { MAX_TRANSCRIPT_CHARS, type CoachResponse } from "../contract";
import { json, liveMember, readJson, refuse } from "../respond";

// One coach call: the transcript so far in, the next thing to show out (src/lib/coach/turn.ts). The
// session must be the member's own, still open and under its call limit (claim_live_coach_call,
// 0011). Only which areas they have touched goes back to the browser, never the coverage itself.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.strictObject({
  sessionId: z.uuid(),
  transcript: z.string().max(MAX_TRANSCRIPT_CHARS),
  elapsedMs: z.number().finite().min(0).max(3_600_000),
  shown: z.number().int().nonnegative().nullable(),
  skip: z.number().int().nonnegative().nullable(),
  // Optional: recorders from before it never send it.
  reread: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await readJson(request));
  if (!body.success) return refuse("bad_request");
  if (!liveCheckinEnabled()) return refuse("session_over");
  let instructions;
  try {
    instructions = coachInstructions();
  } catch {
    return refuse("unavailable");
  }
  const session = await liveMember();
  if (typeof session === "string") return refuse(session);
  const memberId = session.member.id;
  const { sessionId, transcript, elapsedMs, shown, skip, reread } = body.data;

  const claim = await claimCoachCall(sessionId, memberId);
  if (typeof claim === "string") return refuse(claim);
  // How far into the recording, never further than the session has been open.
  const sinceStart = Date.now() - Date.parse(claim.startedAt);
  const elapsed = Math.min(elapsedMs, Number.isFinite(sinceStart) ? Math.max(0, sinceStart) : elapsedMs);

  const kept = parseState(claim.state);
  const turn = await coachTurn({
    state: kept,
    rubric: instructions.rubric,
    transcript,
    elapsedS: elapsed / 1000,
    shown,
    skip,
    reread: reread === true,
    read: (alreadyAsked) => readTranscript({ transcript, alreadyAsked, signal: request.signal }),
  });
  // Its code and status, never its message: that can repeat what the SDK said back, and so Claude's
  // reply and the member's words, or name topics.
  if (turn.failure) {
    const { reason, retryable, code, status } = turn.failure;
    console.error("live coach: reading the transcript failed", { reason, retryable, code, status });
  }

  // Every reply that came back is paid for, used or not.
  const billed = turn.result ?? turn.failure?.billed ?? null;
  const [saved] = await Promise.all([
    saveCoachState(sessionId, memberId, claim.callNumber, turn.state, elapsed),
    billed ? recordCoachCost(sessionId, billed.model, billed.usage) : null,
  ]);
  // A later call has moved on (or the session ended, or the save failed): this one's offer was never
  // kept, so it can't be shown.
  const sent = saved ? turn.offer : null;
  const offer = sent ? { id: sent.id, kind: sent.kind, text: sent.text } : null;
  // Whether a follow-up question can still come once that offer is on screen: never coverage, only
  // whether the questions have run their course (moreToAsk). Unsaved, nothing of this call was kept
  // (its skip, its read, its mood): the next call goes on from the state this one found, with the
  // question on screen counted, so `more` is worked out from that.
  const from = saved ? turn.state : shown !== null ? acknowledge(kept, shown, instructions.rubric) : kept;
  const more = moreToAsk(from, sent, instructions.rubric, elapsed / 1000);
  return json({ status: "ok", offer, touched: turn.touched, degraded: turn.failure !== null, more } satisfies CoachResponse);
}
