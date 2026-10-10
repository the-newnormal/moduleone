import { coachModel } from "@/lib/coach";
import { coachInstructions } from "@/lib/coach/prompt";
import { pacingFrom } from "@/lib/coach/rubric";
import { liveCheckinEnabled, liveSttModel } from "@/lib/checkin/live-config";
import { endLiveSession, startLiveSession } from "@/lib/checkin/live-sessions";
import { mintLiveTranscriptionKey } from "@/lib/stt/live";
import type { LiveStartResponse } from "./contract";
import { json, liveMember, readJson, refuse } from "./respond";

// Starts a live check-in for the signed-in member: a session row (which caps what the coach may
// spend), then a short-lived key for OpenAI's realtime transcription. The browser falls back to the
// three fixed questions on anything but "ready", and records exactly as before either way.
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

  const session = await liveMember({ notice: true });
  if (typeof session === "string") return refuse(session);
  const memberId = session.member.id;

  const started = await startLiveSession(memberId, {
    stt: `openai:${liveSttModel()}`,
    coach: coachModel(),
    coachRubric: instructions.version,
  });
  if (typeof started === "string") return refuse(started);

  let key;
  try {
    key = await mintLiveTranscriptionKey(request.signal);
  } catch (error) {
    console.error("live: minting the transcription key failed", { config: (error as { config?: boolean }).config ?? false });
    await endLiveSession(started.id, memberId, 0);
    return refuse("unavailable");
  }
  return json({
    status: "ready",
    sessionId: started.id,
    clientSecret: key.value,
    sttModel: key.model,
    opening: instructions.rubric.opening,
    pacing: pacingFrom(instructions.rubric.settings),
  } satisfies LiveStartResponse);
}
