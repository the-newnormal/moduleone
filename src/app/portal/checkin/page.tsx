import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { noticeSections, noticeVersion } from "@/lib/checkin/notice";
import { processCheckin } from "@/lib/checkin/process";
import { currentWeekStart } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/server";
import { CardFocus } from "./card-focus";
import { DraftControls } from "./draft-controls";
import { DraftPlayer } from "./draft-player";
import { formatDateTime, formatLength, formatWeekEnd, formatWeekStart } from "./format";
import { needsProcessing, tidyMemberAudio, type ProcessingState } from "./housekeeping";
import { NoticeForm } from "./notice-form";
import { Recorder } from "./recorder";
import { SavedTake } from "./saved-take";

export const metadata: Metadata = { title: "Check-in · Module One" };

// Submitting transcribes and grades the recording in after(), which can only run as long as the
// request may (this also sets the limit for the page's server actions).
export const maxDuration = 300;

// Members never see their grade, so this page reads only the processing columns of their check-in:
// never the scores, category, review or transcript.
const CHECKIN_COLUMNS = "id, submitted_at, graded_at, processing_started_at, processing_error, processing_attempts";
// Long enough to come back to the tab and listen before submitting (iOS fetches the audio only when
// play is pressed). It's the member's own draft, and RLS is checked when the link is signed.
const PLAYBACK_SECONDS = 2 * 60 * 60;

type CheckinRow = ProcessingState & { id: string };
type DraftRow = { audio_path: string; duration_ms: number | null; recorded_at: string; created_at: string };

type View =
  | { state: "no_member" }
  | { state: "unavailable" }
  | { state: "notice" }
  | { state: "submitted"; submittedAt: string | null }
  | { state: "draft"; path: string; playbackUrl: string | null; durationMs: number | null; recordedAt: string }
  | { state: "record" };

export default async function CheckinPage() {
  const supabase = await createClient();
  // The proxy already redirects signed-out visitors; check again so the page never renders
  // without a verified user.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?next=/portal/checkin");

  const weekStart = currentWeekStart();
  const view = await loadView(supabase, data.claims.sub, weekStart);

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-8 px-4 py-12">
      <header className="grid gap-2">
        <Link href="/portal" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Portal
        </Link>
        <h1 className="text-4xl">Weekly check-in</h1>
        <p className="text-sm text-muted-foreground">
          Week of {formatWeekStart(weekStart)}. Submit by {formatWeekEnd(weekStart)}, 11:59 pm Singapore
          time.
        </p>
      </header>
      <CardFocus state={view.state}>
        <CheckinCard view={view} />
      </CardFocus>
    </main>
  );
}

async function loadView(
  supabase: Awaited<ReturnType<typeof createClient>>,
  authUserId: string,
  weekStart: string,
): Promise<View> {
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, team_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (memberError) return unavailable("member", memberError.code);
  if (!member) return { state: "no_member" };

  const [notice, checkin, draft] = await Promise.all([
    supabase
      .from("recording_notices")
      .select("member_id")
      .eq("member_id", member.id)
      .eq("auth_user_id", authUserId)
      .eq("notice_version", noticeVersion())
      .maybeSingle(),
    supabase
      .from("checkins")
      .select(CHECKIN_COLUMNS)
      .eq("member_id", member.id)
      .eq("week_start", weekStart)
      .maybeSingle<CheckinRow>(),
    supabase
      .from("checkin_drafts")
      .select("audio_path, duration_ms, recorded_at, created_at")
      .eq("member_id", member.id)
      .eq("week_start", weekStart)
      .maybeSingle<DraftRow>(),
  ]);

  // After the page is sent: clear out old drafts and unsaved takes, and pick up a submitted
  // check-in whose processing failed or stalled (the claim stops it running twice).
  after(() => tidyMemberAudio(member.id, weekStart));
  const submitted = checkin.data;
  if (submitted && needsProcessing(submitted)) after(() => processCheckin(submitted.id));

  if (notice.error) return unavailable("notice", notice.error.code);
  if (checkin.error) return unavailable("checkin", checkin.error.code);
  if (draft.error) return unavailable("draft", draft.error.code);

  if (!notice.data) return { state: "notice" };
  if (submitted) return { state: "submitted", submittedAt: submitted.submitted_at };
  if (!draft.data) return { state: "record" };

  // The member's own folder, so RLS lets them read it (0002), drafts included (0004).
  const { data: signed, error: signError } = await supabase.storage
    .from("checkin-audio")
    .createSignedUrl(draft.data.audio_path, PLAYBACK_SECONDS);
  if (signError) console.error("checkin page: signing playback failed", { code: signError.name });
  return {
    state: "draft",
    path: draft.data.audio_path,
    playbackUrl: signed?.signedUrl ?? null,
    durationMs: draft.data.duration_ms,
    // When the take was recorded; when that is unknown ('-infinity', see 0004), when it was saved.
    recordedAt: Number.isFinite(Date.parse(draft.data.recorded_at)) ? draft.data.recorded_at : draft.data.created_at,
  };
}

function unavailable(what: string, code: string | undefined): View {
  console.error("checkin page: loading failed", { what, code });
  return { state: "unavailable" };
}

function CheckinCard({ view }: { view: View }) {
  switch (view.state) {
    case "no_member":
      return (
        <Card>
          <CardContent>
            <p role="status">Your account isn&apos;t set up yet. Ask HQ.</p>
          </CardContent>
        </Card>
      );
    case "unavailable":
      return (
        <Card>
          <CardContent>
            <p role="alert">Couldn&apos;t load your check-in. Refresh the page to try again.</p>
          </CardContent>
        </Card>
      );
    case "notice":
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 tabIndex={-1} className="text-2xl outline-none">Before you record</h2>
            </CardTitle>
            <CardDescription>How your recording is used. You&apos;ll only see this once.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <dl className="grid gap-4 text-sm leading-6">
              {noticeSections().map((section) => (
                <div key={section.heading} className="grid gap-1">
                  <dt className="font-medium">{section.heading}</dt>
                  <dd className="text-muted-foreground">{section.body}</dd>
                </div>
              ))}
            </dl>
            <NoticeForm version={noticeVersion()} />
          </CardContent>
        </Card>
      );
    case "submitted":
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 tabIndex={-1} className="text-2xl outline-none">Done for this week</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p role="status">
              {view.submittedAt
                ? `Submitted on ${formatDateTime(view.submittedAt)}. Thanks, see you next week.`
                : "Your check-in for this week is in. Thanks, see you next week."}
            </p>
            <SavedTake path={null} />
          </CardContent>
        </Card>
      );
    case "draft":
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 tabIndex={-1} className="text-2xl outline-none">Your recording</h2>
            </CardTitle>
            <CardDescription>
              Listen back, then submit it or record again. Only you can hear it until you submit.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {view.playbackUrl ? (
              <DraftPlayer key={view.playbackUrl} src={view.playbackUrl} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Couldn&apos;t load the recording for playback. Refresh the page to try again.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Recorded {formatDateTime(view.recordedAt)}
              {view.durationMs !== null && ` · ${formatLength(view.durationMs)}`}
            </p>
            <DraftControls path={view.path} />
            <SavedTake key={view.path} path={view.path} />
          </CardContent>
        </Card>
      );
    case "record":
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 tabIndex={-1} className="text-2xl outline-none">Record your check-in</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Recorder />
          </CardContent>
        </Card>
      );
  }
}
