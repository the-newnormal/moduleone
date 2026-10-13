import type { NextRequest } from "next/server";
import { logCheckinViews } from "@/lib/checkin/view-log";
import { recordingCheckinId, recordingLink } from "@/lib/dashboard/recordings";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every answer is about one viewer, and the redirect carries a bearer link: never cache either.
const PRIVATE = { "Cache-Control": "private, no-store" };

// The signed-in member's id, or null when it can't be told (then the play is treated as someone
// else's, and noted).
async function viewerId(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("app_current_member_id");
    return error ? null : ((data as string | null) ?? null);
  } catch {
    return null;
  }
}

// The stable address the drill-in's and the Diary's player play a recording from, so members must
// always be able to reach it, though it sits under /portal/dashboard. Each request signs a fresh
// short-lived Storage link as the signed-in viewer and redirects to it, so a page left open for
// hours still plays. Signed out: the proxy sends them to /login first (401 here if it ever
// doesn't). No recording, or none this viewer may play: 404, the same answer either way, so it
// says nothing about check-ins they can't see. The address ends with the file's extension, for
// Safari (recordingPath); it's only a hint, since the file to sign comes from the check-in.
//
// Someone else's recording (a leader's or hq's, with the recordings grant) is noted in its owner's
// Diary before the redirect hands the link over (0015, src/lib/checkin/view-log.ts): if that fails,
// 503 and no link. The speaker's own plays never call the log, so their Diary always plays.
export async function GET(_request: NextRequest, ctx: RouteContext<"/portal/dashboard/recording/[checkinId]">) {
  const checkinId = recordingCheckinId((await ctx.params).checkinId);
  if (!UUID.test(checkinId)) return new Response(null, { status: 404, headers: PRIVATE });

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return new Response(null, { status: 401, headers: PRIVATE });

  const [found, viewer] = await Promise.all([recordingLink(supabase, checkinId), viewerId(supabase)]);
  if (!found) return new Response(null, { status: 404, headers: PRIVATE });
  const redirect = new Response(null, { status: 307, headers: { ...PRIVATE, Location: found.link } });
  if (viewer !== null && viewer === found.ownerId) return redirect;

  try {
    await logCheckinViews(supabase, [checkinId], "played");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error("recording: noting the play failed", { code: typeof code === "string" ? code : undefined });
    return new Response(null, { status: 503, headers: PRIVATE });
  }
  return redirect;
}
