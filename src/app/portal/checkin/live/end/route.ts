import { z } from "zod";
import { acknowledge, parseState } from "@/lib/coach/policy";
import { coachInstructions } from "@/lib/coach/prompt";
import { endLiveSession, readOpenSession, saveCoachState } from "@/lib/checkin/live-sessions";
import type { EndResponse } from "../contract";
import { json, liveMember, readJson, refuse } from "../respond";

// The recorder finished (or the page is going away, with keepalive): counts the offer that was on
// screen (the last question or closing line is often shown with no coach call after it), then ends
// the member's live session and logs how long it transcribed. Safe to call twice; the second does
// nothing. Sessions that are never ended are closed by the daily job.
export const dynamic = "force-dynamic";

const Body = z.strictObject({
  sessionId: z.uuid(),
  recordedMs: z.number().finite().min(0).max(3_600_000),
  shown: z.number().int().nonnegative().nullable(),
});

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await readJson(request));
  if (!body.success) return refuse("bad_request");
  const session = await liveMember({ notice: false });
  if (typeof session === "string") return refuse(session);
  const { sessionId, recordedMs, shown } = body.data;
  const memberId = session.member.id;
  if (shown !== null) {
    // Never let the statistics stop the session ending (and its minutes being logged).
    await countShown(sessionId, memberId, shown, recordedMs).catch((error: unknown) =>
      console.error("live end: counting the last offer failed", { error: error instanceof Error ? error.name : "unknown" }),
    );
  }
  await endLiveSession(sessionId, memberId, recordedMs);
  return json({ status: "ended" } satisfies EndResponse);
}

// Best-effort: a session it can't update only misses that last offer from its statistics.
async function countShown(sessionId: string, memberId: string, shown: number, recordedMs: number) {
  let rubric;
  try {
    rubric = coachInstructions().rubric;
  } catch {
    return;
  }
  const open = await readOpenSession(sessionId, memberId);
  if (!open) return;
  const before = parseState(open.state);
  const after = acknowledge(before, shown, rubric);
  if (after !== before) await saveCoachState(sessionId, memberId, open.callNumber, after, recordedMs);
}
