import { coachModel } from "@/lib/coach";
import { coachInstructions } from "@/lib/coach/prompt";
import { pacingFrom } from "@/lib/coach/rubric";
import { liveCheckinEnabled, liveSttModel } from "@/lib/checkin/live-config";
import { startLiveSession } from "@/lib/checkin/live-sessions";
import type { LiveStartResponse } from "./contract";
import { json, liveMember, readJson, refuse } from "./respond";

// Starts a live check-in for the signed-in member: a session row (which caps what the coach may
// spend, and allows one live transcription connection, opened through the connect route). The
// browser carries on without follow-ups on anything but "ready", and records exactly the same
// either way.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  if ((await readJson(request)) === undefined) return refuse("bad_request");
  if (!liveCheckinEnabled()) return json({ status: "off" } satisfies LiveStartResponse);
  let instructions;
  try {
    instructions = coachInstructions();
  } catch {
    // rubrics/coach.md can't be used: its test should have caught this before it was deployed.
    console.error("live: rubrics/coach.md can't be used; live check-ins are off until it is fixed");
    return json({ status: "off" } satisfies LiveStartResponse);
  }

  const session = await liveMember();
  if (typeof session === "string") return refuse(session);
  const memberId = session.member.id;

  const sttModel = liveSttModel();
  const coach = coachModel();
  const coachRubric = instructions.version;
  const started = await startLiveSession(memberId, { stt: `openai:${sttModel}`, coach, coachRubric });
  if (typeof started === "string") return refuse(started);
  // So the logs show live check-ins running, and on which rubric and models. Nothing about who.
  console.info("live session started", { coachRubric, sttModel, coachModel: coach });
  return json({
    status: "ready",
    sessionId: started.id,
    sttModel,
    opening: instructions.rubric.opening,
    pacing: pacingFrom(instructions.rubric.settings),
  } satisfies LiveStartResponse);
}
