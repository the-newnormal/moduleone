import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { deleteExpiredRecordings, processPendingCheckins, removeResetRecordings } from "@/app/portal/checkin/housekeeping";
import { tidyLiveSessions } from "@/lib/checkin/live-sessions";

// The daily check-in job. Retries the transcription and grading of submitted check-ins whose last
// attempt failed or stalled, so a check-in gets graded even if its member never opens the
// check-in page again, deletes recordings older than 90 days, as the privacy notice promises, and
// retries deleting the files of Master Admins' deletes and resets that Storage refused at the time,
// and tidies live check-in sessions (ends any the browser never ended, logging their live
// transcription, and deletes those whose take never became a check-in after 14 days).
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
  const [processing, retention, resets, live] = await Promise.all([
    processPendingCheckins(),
    deleteExpiredRecordings(),
    removeResetRecordings(),
    tidyLiveSessions(),
  ]);
  const ok = Boolean(processing && retention && resets && live);
  return Response.json(
    {
      ok,
      ...processing,
      ...retention,
      ...(resets && { resetFilesRemoved: resets.removed }),
      ...(live && { liveSessionsEnded: live.ended }),
    },
    { status: ok ? 200 : 500 },
  );
}

// Compares hashes, so the check takes the same time however much of the secret a caller guessed.
function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !header) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
