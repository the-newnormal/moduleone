// This server's clock, for the recorder to stamp each take with (see take.ts). A plain request,
// not a server action, so it is never queued behind another action and the time is current.
// Signed-in members only, like the rest of /portal (the proxy redirects anyone else).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ now: Date.now() }, { headers: { "cache-control": "no-store" } });
}
