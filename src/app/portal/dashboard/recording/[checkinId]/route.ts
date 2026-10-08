import type { NextRequest } from "next/server";
import { recordingLink } from "@/lib/dashboard/recordings";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every answer is about one viewer, and the redirect carries a bearer link: never cache either.
const PRIVATE = { "Cache-Control": "private, no-store" };

// The stable address the drill-in's player plays a recording from. Each request signs a fresh
// short-lived Storage link as the signed-in viewer and redirects to it, so a page left open for
// hours still plays. Signed out: the proxy sends them to /login first (401 here if it ever
// doesn't). No recording, or none this viewer may play: 404, the same answer either way, so it
// says nothing about check-ins they can't see.
export async function GET(_request: NextRequest, ctx: RouteContext<"/portal/dashboard/recording/[checkinId]">) {
  const { checkinId } = await ctx.params;
  if (!UUID.test(checkinId)) return new Response(null, { status: 404, headers: PRIVATE });

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return new Response(null, { status: 401, headers: PRIVATE });

  const link = await recordingLink(supabase, checkinId);
  if (!link) return new Response(null, { status: 404, headers: PRIVATE });
  return new Response(null, { status: 307, headers: { ...PRIVATE, Location: link } });
}
