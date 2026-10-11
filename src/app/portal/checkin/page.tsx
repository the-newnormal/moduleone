import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buildDiary, type DiaryEntry, type DiaryRow, loadDiaryRows } from "@/lib/checkin/diary";
import {
  NOTICE_CHANGE,
  type NoticeAcceptance,
  noticeSections,
  noticeStatus,
  noticeVersion,
} from "@/lib/checkin/notice";
import { checkinQuestion } from "@/lib/checkin/opening";
import { processCheckin } from "@/lib/checkin/process";
import { currentWeekStart } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/server";
import { CardFocus } from "./card-focus";
import { DraftControls } from "./draft-controls";
import { DraftPlayer } from "./draft-player";
import { Entries, EntryAudio } from "./entries";
import { formatDateTime, formatLength, formatLongDate, formatWeekEnd, formatWeekStart } from "./format";
import { needsProcessing, tidyMemberAudio, type ProcessingState } from "./housekeeping";
import { NoticeForm } from "./notice-form";
import { Recorder } from "./recorder";
import { SavedTake } from "./saved-take";
import { ThenAndNow } from "./then-and-now";

export const metadata: Metadata = { title: "Diary · Module One" };

// Submitting transcribes and grades the recording in after(), which can only run as long as the
// request may (this also sets the limit for the page's server actions).
export const maxDuration = 300;

// Members never see their grade, so this page reads only the processing columns of this week's
// check-in, and for the diary only DIARY_COLUMNS of their own check-ins (src/lib/checkin/diary.ts):
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
  // returning: this login accepted an earlier notice. keepChanged: and none that kept recordings a year.
  | { state: "notice"; returning: boolean; keepChanged: boolean }
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
  const { name, view, rows } = await loadPage(supabase, data.claims.sub, weekStart);
  // The card plays this week's recording once it is submitted; before that, it heads its year.
  const diary =
    rows === null || rows === "failed"
      ? rows
      : buildDiary(rows, { weekStart, cardShowsThisWeek: view.state === "submitted" });
  const built = diary === "failed" ? null : diary; // the diary, when it loaded

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
      </header>
      <section id="this-week" aria-label="This week" className="grid gap-3">
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          Week of {formatWeekStart(weekStart)}. Submit by {formatWeekEnd(weekStart)}, 11:59 pm Singapore
          time.
        </p>
        {/* Only the card: CardFocus moves focus to the first h2 inside it. */}
        <CardFocus state={view.state}>
          <CheckinCard view={view} entry={built?.card ?? null} weekStart={weekStart} />
        </CardFocus>
      </section>
      {built?.thenAndNow && <ThenAndNow then={built.thenAndNow.then} now={built.thenAndNow.now} />}
      {diary !== null && <Entries diary={diary} />}
    </main>
  );
}

// The member's name, this week's card and their diary's rows. rows is null when there is no member
// (or it couldn't be loaded), and "failed" when only the diary couldn't: this week still works
// without it, and the diary shows without this week.
async function loadPage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  authUserId: string,
  weekStart: string,
): Promise<{ name: string | null; view: View; rows: DiaryRow[] | "failed" | null }> {
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, name")
    .eq("auth_user_id", authUserId)
    .maybeSingle<{ id: string; name: string }>();
  if (memberError) return { name: null, view: unavailable("member", memberError.code), rows: null };
  if (!member) return { name: null, view: { state: "no_member" }, rows: null };

  const [notices, checkin, draft, diary] = await Promise.all([
    // Every notice this login accepted, with what each promised: whether to show it again, and how.
    supabase
      .from("recording_notices")
      .select("notice_version, recording_keep_days")
      .eq("member_id", member.id)
      .eq("auth_user_id", authUserId)
      .overrideTypes<NoticeAcceptance[], { merge: false }>(),
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
  ]);

  // After the page is sent: clear out old drafts and unsaved takes, and pick up a submitted
  // check-in whose processing failed or stalled (the claim stops it running twice).
  after(() => tidyMemberAudio(member.id, weekStart));
  const submitted = checkin.data;
  if (submitted && needsProcessing(submitted)) after(() => processCheckin(submitted.id));

  if (diary.error) console.error("checkin page: loading failed", { what: "diary", code: diary.error.code });
  const rows = diary.error ? "failed" : (diary.data ?? []);
  return { name: member.name, view: await thisWeek(supabase, notices, checkin, draft), rows };
}

// This week's card, from the notices, this week's check-in and its draft.
async function thisWeek(
  supabase: Awaited<ReturnType<typeof createClient>>,
  notices: { data: NoticeAcceptance[] | null; error: { code: string } | null },
  checkin: { data: CheckinRow | null; error: { code: string } | null },
  draft: { data: DraftRow | null; error: { code: string } | null },
): Promise<View> {
  if (notices.error) return unavailable("notice", notices.error.code);
  if (checkin.error) return unavailable("checkin", checkin.error.code);
  if (draft.error) return unavailable("draft", draft.error.code);

  const notice = noticeStatus(notices.data ?? []);
  if (!notice.accepted) return { state: "notice", returning: notice.returning, keepChanged: notice.keepChanged };
  const submitted = checkin.data;
  if (submitted) return { state: "submitted", submittedAt: submitted.submitted_at };
  if (!draft.data) return { state: "record", ...checkinQuestion() };

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

// entry: this week's diary entry, when the card is "submitted" and the diary loaded.
function CheckinCard({ view, entry, weekStart }: { view: View; entry: DiaryEntry | null; weekStart: string }) {
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
            <CardDescription>
              {view.returning
                ? "How your recording is used. It has changed since you last accepted it."
                : "How your recording is used. You'll see this again only if it changes."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {view.keepChanged && (
              <p className="rounded-md bg-muted px-4 py-3 text-sm">
                <span className="font-medium">What&apos;s changed.</span> {NOTICE_CHANGE}
              </p>
            )}
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
          <CardContent className="grid gap-4">
            <p role="status">
              {view.submittedAt
                ? `Submitted on ${formatDateTime(view.submittedAt)}. Thanks, see you next week.`
                : "Your check-in for this week is in. Thanks, see you next week."}
            </p>
            {entry && <EntryAudio entry={entry} here="card" />}
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
