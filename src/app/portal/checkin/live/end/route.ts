import { z } from "zod";
import { acknowledge, parseState, type CoachState } from "@/lib/coach/policy";
import { coachInstructions } from "@/lib/coach/prompt";
import { endLiveSession, readOpenSession, saveCoachState } from "@/lib/checkin/live-sessions";
import { FALLBACK_REASONS, type EndResponse } from "../contract";
import { json, liveMember, readJson, refuse } from "../respond";

// The recorder finished (or the page is going away, with keepalive): counts the offer that was on
// screen (the last question or closing line is often shown with no coach call after it), then ends
// the member's live session, records how long it transcribed (the cost log) and logs how the take
// went. Safe to call twice; the second changes nothing. Sessions that are never ended are closed by
// the daily job.
export const dynamic = "force-dynamic";

const Body = z.strictObject({
  sessionId: z.uuid(),
  recordedMs: z.number().finite().min(0).max(3_600_000),
  shown: z.number().int().nonnegative().nullable(),
  // Optional: sent only when live coaching stopped early, and never by recorders from before it.
  fallback: z.enum(FALLBACK_REASONS).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await readJson(request));
  if (!body.success) return refuse("bad_request");
  const session = await liveMember({ notice: false });
  if (typeof session === "string") return refuse(session);
  const { sessionId, recordedMs, shown, fallback } = body.data;
  const memberId = session.member.id;
  // Never let the statistics stop the session ending (and its minutes being logged).
  const state = await lastState(sessionId, memberId, shown, recordedMs).catch((error: unknown) => {
    console.error("live end: counting the last offer failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  });
  const ended = await endLiveSession(sessionId, memberId, recordedMs);
  // How the take went, in codes and counts: anyone with access to the logs reads them, so no ids,
  // topics, coverage or wording. Only when this call ended the member's own session: a second call,
  // or one for a session that isn't theirs, would add a line (and a fallback) for no take at all.
  if (ended) console.info("live end", { fallback: fallback ?? null, ...(state && outcome(state)) });
  return json({ status: "ended" } satisfies EndResponse);
}

// The session's coach state as it ends, with the offer that was on screen counted. Null if the
// session isn't the member's open one. Best-effort: a session it can't update only misses that last
// offer from its statistics.
async function lastState(sessionId: string, memberId: string, shown: number | null, recordedMs: number): Promise<CoachState | null> {
  const open = await readOpenSession(sessionId, memberId);
  if (!open) return null;
  const before = parseState(open.state);
  if (shown === null) return before;
  let rubric;
  try {
    rubric = coachInstructions().rubric;
  } catch {
    return before;
  }
  const after = acknowledge(before, shown, rubric);
  if (after === before) return before;
  // The log reports what the session holds: a save that didn't apply (failed, or a newer coach call
  // got there first) leaves the state as it was.
  return (await saveCoachState(sessionId, memberId, open.callNumber, after, recordedMs)) ? after : before;
}

// The counts the log shows (rubrics/README.md, section 5). Never rejectedWhy: a line is one take,
// and why Claude's wording was turned down beside its time could point at whoever recorded then.
function outcome(state: CoachState) {
  const { reads, failures, tailored, bank, rejected, noRead } = state.counts;
  return { reads, failures, tailored, bank, rejected, noRead, followUps: state.followUps };
}
