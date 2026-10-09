import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/admin/errors";

// The viewer's own check-in this week and whether they checked in each of the last few weeks, for
// the portal. Members never see their grade, so the only check-in columns read here are the week and
// when it was submitted: never scores, category, review, transcript or recording. Every query is
// filtered to the viewer's own member row, because RLS would also hand a leader their teams' rows
// and hq everyone's. It reads and nothing else: the check-in page tidies drafts and retries
// processing, the portal doesn't.

export const STRIP_WEEKS = 8;
export const HOME_CHECKIN_COLUMNS = "week_start, submitted_at";
export const HOME_DRAFT_COLUMNS = "duration_ms, recorded_at, created_at";

export type ThisWeek =
  | { state: "record" }
  | { state: "draft"; recordedAt: string; durationMs: number | null }
  | { state: "submitted"; submittedAt: string | null };

export type MyWeek =
  | { state: "no_member" }
  | { state: "unavailable"; name: string | null }
  | { state: "ok"; name: string; thisWeek: ThisWeek; checkedIn: string[] };

type CheckinRow = { week_start: string; submitted_at: string | null };
type DraftRow = { duration_ms: number | null; recorded_at: string; created_at: string };

// `weeks` oldest first, ending with this week. Never throws.
export async function loadMyWeek(
  supabase: SupabaseClient,
  authUserId: string,
  weeks: readonly string[],
): Promise<MyWeek> {
  let name: string | null = null;
  try {
    const { data: member, error } = await supabase
      .from("members")
      .select("id, name")
      .eq("auth_user_id", authUserId)
      .maybeSingle<{ id: string; name: string }>();
    if (error) return unavailable(name, error);
    if (!member) return { state: "no_member" };
    name = member.name;

    const thisWeek = weeks[weeks.length - 1];
    const [checkins, draft] = await Promise.all([
      supabase
        .from("checkins")
        .select(HOME_CHECKIN_COLUMNS)
        .eq("member_id", member.id)
        .gte("week_start", weeks[0])
        .lte("week_start", thisWeek)
        .order("week_start")
        .overrideTypes<CheckinRow[], { merge: false }>(),
      supabase
        .from("checkin_drafts")
        .select(HOME_DRAFT_COLUMNS)
        .eq("member_id", member.id)
        .eq("week_start", thisWeek)
        .maybeSingle<DraftRow>(),
    ]);
    if (checkins.error) return unavailable(name, checkins.error);
    if (draft.error) return unavailable(name, draft.error);

    const rows = checkins.data ?? [];
    const submitted = rows.find((row) => row.week_start === thisWeek);
    return {
      state: "ok",
      name,
      checkedIn: rows.map((row) => row.week_start),
      thisWeek: submitted
        ? { state: "submitted", submittedAt: submitted.submitted_at }
        : draft.data
          ? {
              state: "draft",
              durationMs: draft.data.duration_ms,
              // When the take was recorded; when that is unknown ('-infinity', see 0004), when it was saved.
              recordedAt: Number.isFinite(Date.parse(draft.data.recorded_at))
                ? draft.data.recorded_at
                : draft.data.created_at,
            }
          : { state: "record" },
    };
  } catch (error) {
    return unavailable(name, error);
  }
}

function unavailable(name: string | null, error: unknown): MyWeek {
  logError("portal check-in status", error);
  return { state: "unavailable", name };
}

export type WeekMark = "done" | "none" | "open" | "draft";
export type WeekStrip = { cells: { week: string; mark: WeekMark }[]; count: number };

// A mark for each week, oldest first: checked in or not, and for this week (the last), whether it's
// done, recorded but not submitted, or still open. Whether, never how it went.
export function weekStrip(weeks: readonly string[], checkedIn: readonly string[], current: ThisWeek["state"]): WeekStrip {
  const done = new Set(checkedIn);
  const last = weeks.length - 1;
  const cells = weeks.map((week, i) => {
    let mark: WeekMark;
    if (i < last) mark = done.has(week) ? "done" : "none";
    else mark = current === "submitted" ? "done" : current === "draft" ? "draft" : "open";
    return { week, mark };
  });
  return { cells, count: cells.filter((cell) => cell.mark === "done").length };
}
