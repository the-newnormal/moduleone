import { z } from "zod";
import { endLiveSession } from "@/lib/checkin/live-sessions";
import type { EndResponse } from "../contract";
import { json, liveMember, readJson, refuse } from "../respond";

// The recorder finished (or the page is going away, with keepalive): ends the member's live session
// and logs how long it transcribed. Safe to call twice; the second does nothing. Sessions that are
// never ended are closed by the daily job.
export const dynamic = "force-dynamic";

const Body = z.strictObject({
  sessionId: z.uuid(),
  recordedMs: z.number().finite().min(0).max(3_600_000),
});

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await readJson(request));
  if (!body.success) return refuse("bad_request");
  const session = await liveMember({ notice: false });
  if (typeof session === "string") return refuse(session);
  await endLiveSession(body.data.sessionId, session.member.id, body.data.recordedMs);
  return json({ status: "ended" } satisfies EndResponse);
}
