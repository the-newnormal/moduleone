import { z } from "zod";
import { liveCheckinEnabled } from "@/lib/checkin/live-config";
import { connectLiveSession } from "@/lib/checkin/live-sessions";
import { LiveTranscriptionError, openLiveTranscription } from "@/lib/stt/live";
import { MAX_OFFER_CHARS, type ConnectResponse } from "../contract";
import { json, liveMember, readJson, refuse } from "../respond";

// Opens a live session's transcription: the browser's WebRTC offer in, OpenAI's answer out. The
// session must be the member's own, still open, and not connected yet: it claims its one connection
// (connect_live_checkin_session, 0012) before anything is sent to OpenAI, so a member can't open more
// transcription sessions than they start, and no key ever reaches the browser. The audio itself then
// goes straight from the browser to OpenAI. Nothing here logs the offer or the answer.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.strictObject({
  sessionId: z.uuid(),
  // An SDP offer starts "v=0".
  offer: z.string().max(MAX_OFFER_CHARS).startsWith("v=0"),
});

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await readJson(request));
  if (!body.success) return refuse("bad_request");
  if (!liveCheckinEnabled()) return refuse("session_over");
  // The notice was checked when the session started; this checks who is calling.
  const session = await liveMember({ notice: false });
  if (typeof session === "string") return refuse(session);
  const { sessionId, offer } = body.data;

  const claimed = await connectLiveSession(sessionId, session.member.id);
  if (claimed !== true) return refuse(claimed);
  try {
    const answer = await openLiveTranscription(offer, request.signal);
    return json({ status: "connected", answer } satisfies ConnectResponse);
  } catch (error) {
    // The session stays claimed: the recorder carries on with the fixed questions for this take.
    // Only this module's own messages (a status code at most), never anything else's.
    const known = error instanceof LiveTranscriptionError;
    console.error("live: connecting the transcription failed", {
      config: known && error.config,
      error: known ? error.message : error instanceof Error ? error.name : "unknown",
    });
    return refuse("unavailable");
  }
}
