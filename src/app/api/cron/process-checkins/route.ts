import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { processPendingCheckins } from "@/app/portal/checkin/housekeeping";

// Retries the transcription and grading of submitted check-ins whose last attempt failed or
// stalled, so a check-in gets graded even if its member never opens the check-in page again.
// Vercel Cron calls it on the schedule in vercel.json (daily at 03:23 Singapore time: once a day
// works on every Vercel plan; on Pro it can run every 15 minutes), sending
// `Authorization: Bearer $CRON_SECRET`. Set CRON_SECRET in the Vercel project; without it this
// route refuses every call.
//
// Each attempt keeps its transcription inside this limit (src/lib/checkin/process.ts).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorised(request.headers.get("authorization"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await processPendingCheckins();
  if (!result) return Response.json({ ok: false }, { status: 500 });
  return Response.json({ ok: true, ...result });
}

// Compares hashes, so the check takes the same time however much of the secret a caller guessed.
function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !header) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
