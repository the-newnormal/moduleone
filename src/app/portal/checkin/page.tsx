import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buildDiary, type DiaryEntry, type DiaryRow, loadDiaryRows } from "@/lib/checkin/diary";
import { noteOnboardingForm } from "@/lib/checkin/onboarding-note";
import { checkinQuestion } from "@/lib/checkin/opening";
import { processCheckin } from "@/lib/checkin/process";
import { loadViewLog, type ViewGroup, type ViewLogRow, viewsByWeek } from "@/lib/checkin/view-log";
import { currentWeekStart } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/server";
import { CardFocus } from "./card-focus";
import { DraftControls } from "./draft-controls";
import { DraftPlayer } from "./draft-player";
import { Entries, EntryAudio } from "./entries";
import { formatDateTime, formatLength, formatLongDate, formatWeekEnd, formatWeekStart } from "./format";
import { needsProcessing, tidyMemberAudio, type ProcessingState } from "./housekeeping";
import { Recorder } from "./recorder";
import { SavedTake } from "./saved-take";
import { ThenAndNow } from "./then-and-now";
import { NoLongerInDiary, ViewedBy } from "./viewed-by";

export const metadata: Metadata = { title: "Diary · Module One" };

// Submitting transcribes and grades the recording in after(), which can only run as long as the
// request may (this also sets the limit for the page's server actions).
export const maxDuration = 300;

// Members never see their grade, so this page reads only the processing columns of this week's
// check-in, and for the diary only DIARY_COLUMNS of their own check-ins (src/lib/checkin/diary.ts):
// never the scores, category, review or transcript. Who opened them comes from a separate read of
// their own view log (VIEW_LOG_COLUMNS, src/lib/checkin/view-log.ts), never by widening those. Of
// recording_notices it writes only the note of the assumed onboarding consent for this login
// (src/lib/checkin/onboarding-note.ts); after the response it also tidies the member's old drafts and
// files and retries processing that failed or stalled (tidyMemberAudio and processCheckin, below,
// both with the service role).
const CHECKIN_COLUMNS = "id, submitted_at, graded_at, processing_started_at, processing_error, processing_attempts";
// Long enough to come back to the tab and listen before submitting (iOS fetches the audio only when
// play is pressed). It's the member's own draft, and RLS is checked when the link is signed.
const PLAYBACK_SECONDS = 2 * 60 * 60;

type CheckinRow = ProcessingState & { id: string };
type DraftRow = { audio_path: string; duration_ms: number | null; recorded_at: string; created_at: string };

type View =
  | { state: "no_member" }
  | { state: "unavailable" }
  | { state: "submitted"; submittedAt: string | null }
  | { state: "draft"; path: string; playbackUrl: string | null; durationMs: number | null; recordedAt: string }
  | { state: "record"; opening: string; live: boolean };

export default async function CheckinPage() {
  const supabase = await createClient();
  // The proxy already redirects signed-out visitors; check again so the page never renders
  // without a verified user.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?next=/portal/checkin");

  const weekStart = currentWeekStart();
  const { name, view, rows, viewLog } = await loadPage(supabase, data.claims.sub, weekStart);
  // The card plays this week's recording once it is submitted; before that, it heads its year.
  const diary =
    rows === null || rows === "failed"
      ? rows
      : buildDiary(rows, { weekStart, cardShowsThisWeek: view.state === "submitted" });
  const built = diary === "failed" ? null : diary; // the diary, when it loaded
  // Who opened each week's check-in, shown with that week's entry, so only when the diary loaded.
  // Weeks with no entry left (reset, and not recorded again) are listed after the entries.
  const views = built && Array.isArray(viewLog) ? viewsByWeek(viewLog) : null;
  const onPage = new Set([built?.card?.week, ...(built?.years ?? []).flatMap((y) => y.entries.map((e) => e.week))]);
  const elsewhere = [...(views ?? [])].filter(([week]) => !onPage.has(week)).sort(([a], [b]) => b.localeCompare(a));

  return (
    <main className="mx-auto grid w-full max-w-2xl grid-cols-[minmax(0,1fr)] gap-10 px-4 py-12">
      <header className="grid gap-2">
        {name !== null && (
          <p className="text-xs leading-4 font-medium tracking-[0.02em] break-words text-muted-foreground">{name}</p>
        )}
        <h1 className="text-[32px] leading-9 tracking-[-0.02em] sm:text-[44px] sm:leading-[48px]">Diary</h1>
        <p className="max-w-[680px] text-[15px] leading-[22px]">
          Your weekly recordings, in your own voice, to listen back to.
        </p>
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          Each recording you submit is also your weekly check-in for your team leader and HQ.
        </p>
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          Under each one, you can see which leaders and HQ have opened it or played its recording in Module One,
          and when. The list starts from when Module One began keeping it.
        </p>
        {viewLog === "failed" && (
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            Couldn&apos;t load who has opened your check-ins. Refresh the page to try again.
          </p>
        )}
      </header>
      <section id="this-week" aria-label="This week" className="grid gap-3">
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          Week of {formatWeekStart(weekStart)}. Submit by {formatWeekEnd(weekStart)}, 11:59 pm Singapore
          time.
        </p>
        {/* Only the card: CardFocus moves focus to the first h2 inside it. */}
        <CardFocus state={view.state}>
          <CheckinCard
            view={view}
            entry={built?.card ?? null}
            viewedBy={built?.card ? views?.get(built.card.week) : undefined}
            weekStart={weekStart}
          />
        </CardFocus>
      </section>
      {built?.thenAndNow && <ThenAndNow then={built.thenAndNow.then} now={built.thenAndNow.now} />}
      {diary !== null && <Entries diary={diary} views={views} />}
      <NoLongerInDiary weeks={elsewhere} />
    </main>
  );
}

// The member's name, this week's card, their diary's rows and their view log. rows and viewLog are
// null when there is no member (or it couldn't be loaded), and "failed" when only they couldn't:
// this week still works without them, and the diary shows without this week or the log.
async function loadPage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  authUserId: string,
  weekStart: string,
): Promise<{ name: string | null; view: View; rows: DiaryRow[] | "failed" | null; viewLog: ViewLogRow[] | "failed" | null }> {
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, name")
    .eq("auth_user_id", authUserId)
    .maybeSingle<{ id: string; name: string }>();
  if (memberError) return { name: null, view: unavailable("member", memberError.code), rows: null, viewLog: null };
  if (!member) return { name: null, view: { state: "no_member" }, rows: null, viewLog: null };

  const [note, checkin, draft, diary, views] = await Promise.all([
    // Members agree on the onboarding form, outside Module One; noted for this login before the
    // recorder can show (src/lib/checkin/onboarding-note.ts).
    noteOnboardingForm(member.id, authUserId),
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
    loadDiaryRows(supabase, member.id),
    // Who opened their check-ins (0015): their own rows only, as RLS also insists.
    loadViewLog(supabase, member.id),
  ]);

  // After the page is sent: clear out old drafts and unsaved takes, and pick up a submitted
  // check-in whose processing failed or stalled (the claim stops it running twice).
  after(() => tidyMemberAudio(member.id, weekStart));
  const submitted = checkin.data;
  if (submitted && needsProcessing(submitted)) after(() => processCheckin(submitted.id));

  if (diary.error) console.error("checkin page: loading failed", { what: "diary", code: diary.error.code });
  const rows = diary.error ? "failed" : (diary.data ?? []);
  if (views.error) console.error("checkin page: loading failed", { what: "views", code: views.error.code });
  const viewLog = views.error ? "failed" : views.data;
  return { name: member.name, view: await thisWeek(supabase, note, checkin, draft), rows, viewLog };
}

// This week's card, from the onboarding note, this week's check-in and its draft.
async function thisWeek(
  supabase: Awaited<ReturnType<typeof createClient>>,
  note: { error: { code: string } | null },
  checkin: { data: CheckinRow | null; error: { code: string } | null },
  draft: { data: DraftRow | null; error: { code: string } | null },
): Promise<View> {
  if (checkin.error) return unavailable("checkin", checkin.error.code);
  if (draft.error) return unavailable("draft", draft.error.code);

  const submitted = checkin.data;
  if (submitted) return { state: "submitted", submittedAt: submitted.submitted_at };
  if (!draft.data) {
    // Without the note, a take recorded now would be kept 90 days, not the year members are
    // promised. Only a new take needs it: a draft or a submitted check-in already has its start.
    if (note.error) return unavailable("onboarding_note", note.error.code);
    return { state: "record", ...checkinQuestion() };
  }

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

// entry: this week's diary entry, when the card is "submitted" and the diary loaded; viewedBy: who
// opened it.
function CheckinCard({
  view,
  entry,
  viewedBy,
  weekStart,
}: {
  view: View;
  entry: DiaryEntry | null;
  viewedBy: readonly ViewGroup[] | undefined;
  weekStart: string;
}) {
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
    case "submitted":
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 tabIndex={-1} className="text-2xl outline-none">Done for this week</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p role="status">
              {view.submittedAt
                ? `Submitted on ${formatDateTime(view.submittedAt)}. Thanks, see you next week.`
                : "Your check-in for this week is in. Thanks, see you next week."}
            </p>
            {entry && <EntryAudio entry={entry} here="card" />}
            {entry && <ViewedBy groups={viewedBy} />}
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
              <DraftPlayer
                key={view.playbackUrl}
                src={view.playbackUrl}
                label={`Your draft for the week of ${formatLongDate(weekStart)}`}
              />
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
            <Recorder opening={view.opening} live={view.live} />
          </CardContent>
        </Card>
      );
  }
}
