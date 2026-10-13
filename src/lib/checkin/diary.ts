import type { SupabaseClient } from "@supabase/supabase-js";
import { recordingPath } from "@/lib/dashboard/recordings";

// The Diary (/portal/checkin): a member's own check-ins, newest first, each with the recording they
// can still play. Members never see their grade, so this reads only DIARY_COLUMNS of their own rows,
// and every entry is built from named fields only. A recording plays through
// /portal/dashboard/recording/[checkinId], which signs a link as the viewer when they press play, so
// nothing is signed as the page loads and the storage path never leaves the server. Who opened each
// check-in (the view log, 0015) is a separate read of the member's own checkin_views rows
// (src/lib/checkin/view-log.ts), passed to the page beside the diary: never a column added here.

// Only what the Diary shows. RLS (0003) also hands a member their own scores, theme, review and
// transcript, and a leader or hq other people's rows: hence this list and the member filter. Never
// add a column that reads like a grade.
export const DIARY_COLUMNS =
  "id, week_start, submitted_at, audio_path, audio_duration_ms, audio_keep_days, audio_delete_after";

export type DiaryRow = {
  id: string;
  week_start: string;
  submitted_at: string | null;
  audio_path: string | null;
  audio_duration_ms: number | null;
  audio_keep_days: number;
  audio_delete_after: string | null;
};

// No limit: there is one row per member and week (unique (member_id, week_start), which also serves
// the order), and PostgREST's 1000-row cap is about 19 years of weeks.
export const loadDiaryRows = (supabase: SupabaseClient, memberId: string) =>
  supabase
    .from("checkins")
    .select(DIARY_COLUMNS)
    .eq("member_id", memberId)
    .order("week_start", { ascending: false })
    .overrideTypes<DiaryRow[], { merge: false }>();

// Where on the page an entry's one player is, in page order.
export type Spot = "card" | "then-and-now" | "entries";

export type DiaryEntry = {
  id: string;
  week: string; // its Monday, 'YYYY-MM-DD'
  submittedAt: string | null;
  durationMs: number | null;
  // recordingPath(id, audio_path) while it can be played; the storage path never leaves the server.
  src: string | null;
  // The last Singapore day it is kept, 'YYYY-MM-DD', when it can be played and has a deadline.
  keptUntil: string | null;
  keepDays: number; // 90 or 365 (0013)
  // null while it can be played. no_longer_kept: it had a recording (it was submitted, or a path is
  // still set past its deadline). none: it never had one (seeded or hand-entered rows).
  gone: "no_longer_kept" | "none" | null;
  playsIn: Spot | null; // null when there's nothing to play
};

export type Diary = {
  // This week's, when the card shows it (the "submitted" state).
  card: DiaryEntry | null;
  // The oldest and newest entries that can still be played, when at least two can (this week's counts).
  thenAndNow: { then: DiaryEntry; now: DiaryEntry } | null;
  // Every other entry, newest first, by the year of its Monday. folded: nothing in it can be played.
  years: { year: string; folded: boolean; entries: DiaryEntry[] }[];
  firstWeek: string | null; // the oldest Monday of all, the card's included
  ninetyDayNote: boolean; // some entry that can be played is kept for 90 days
};

const SGT_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

// The Singapore calendar day of an instant, 'YYYY-MM-DD'.
export const sgtDay = (instant: string | Date): string =>
  new Date(new Date(instant).getTime() + SGT_MS).toISOString().slice(0, 10);

// The last whole Singapore day before a deadline: the page stops offering a recording from its
// deadline's day, so the date shown never promises more than the daily job keeps, whenever it runs.
export const keptUntilDay = (deleteAfter: string): string =>
  new Date(Date.parse(`${sgtDay(deleteAfter)}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

// A recording can be played until the start of its deadline's Singapore day. A path with no deadline
// (a hand-made row whose file wasn't there to stamp from) plays, with no date shown.
function playable(row: DiaryRow, today: string): boolean {
  return row.audio_path !== null && (row.audio_delete_after === null || today < sgtDay(row.audio_delete_after));
}

// Named fields only, so anything else on the row (a grade RLS handed back) is dropped.
function toEntry(row: DiaryRow, today: string): DiaryEntry {
  const canPlay = playable(row, today);
  return {
    id: row.id,
    week: row.week_start,
    submittedAt: row.submitted_at,
    durationMs: row.audio_duration_ms,
    src: canPlay && row.audio_path !== null ? recordingPath(row.id, row.audio_path) : null,
    keptUntil: canPlay && row.audio_delete_after !== null ? keptUntilDay(row.audio_delete_after) : null,
    keepDays: row.audio_keep_days,
    gone: canPlay ? null : row.submitted_at !== null || row.audio_path !== null ? "no_longer_kept" : "none",
    playsIn: null,
  };
}

// `cardShowsThisWeek`: the card is in its "submitted" state, so this week's entry is the card's and
// isn't listed again. Otherwise this week's row (if any) heads its year. Each recording gets one
// player, in the first place on the page that shows it: the card, then Then and now, then Entries.
export function buildDiary(
  rows: readonly DiaryRow[],
  opts: { weekStart: string; cardShowsThisWeek: boolean; now?: Date },
): Diary {
  const today = sgtDay(opts.now ?? new Date());
  const entries = [...rows].sort((a, b) => b.week_start.localeCompare(a.week_start)).map((row) => toEntry(row, today));

  const card = opts.cardShowsThisWeek ? (entries.find((e) => e.week === opts.weekStart) ?? null) : null;
  const playing = entries.filter((e) => e.src !== null);
  const thenAndNow = playing.length >= 2 ? { then: playing[playing.length - 1], now: playing[0] } : null;

  for (const entry of playing) {
    entry.playsIn =
      entry === card ? "card" : entry === thenAndNow?.then || entry === thenAndNow?.now ? "then-and-now" : "entries";
  }

  const years: Diary["years"] = [];
  for (const entry of entries) {
    if (entry === card) continue;
    const year = entry.week.slice(0, 4);
    const group = years.at(-1);
    if (group?.year === year) group.entries.push(entry);
    else years.push({ year, folded: false, entries: [entry] });
  }
  for (const group of years) group.folded = group.entries.every((e) => e.src === null);

  return {
    card,
    thenAndNow,
    years,
    firstWeek: entries.at(-1)?.week ?? null,
    ninetyDayNote: playing.some((e) => e.keepDays === 90),
  };
}
