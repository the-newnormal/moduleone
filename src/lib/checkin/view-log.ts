import type { SupabaseClient } from "@supabase/supabase-js";
import { PAGE_SIZE, selectAll } from "@/lib/dashboard/select-all";

// The check-in view log (migration 0015): which leaders and Master Admins (hq) opened a member's
// check-in in Module One, or played its recording, and when. Exactly two places note a view, as the
// signed-in viewer and before handing anything over: the drill-in (/portal/dashboard/[teamId]/[week],
// "opened", for every check-in it renders) and the recording route (a non-owner's play, "played").
// The database decides what is noted (log_checkin_views re-applies checkins_select, never notes the
// viewer's own check-ins, and keeps one row per check-in, viewer, kind and Singapore day), and only
// the check-in's owner reads the rows back, in their Diary. Never a count, the page a view came
// from, or any content.

export type ViewKind = "opened" | "played";

// Thrown when a view couldn't be noted: the caller then hands nothing over. `code` is Postgres's or
// PostgREST's error code, the only thing logged about it.
export class ViewLogError extends Error {
  constructor(readonly code: string | undefined) {
    super("Couldn't note who opened it");
    this.name = "ViewLogError";
  }
}

// Notes that the signed-in viewer opened these check-ins (or played this one's recording). Pass
// every id about to be shown, the viewer's own included: the database drops what it shouldn't note
// and says nothing about it. A POST (rpc's default), so nothing between here and the database
// caches it. Throws ViewLogError if the database refuses or can't be reached.
export async function logCheckinViews(supabase: SupabaseClient, ids: readonly string[], kind: ViewKind): Promise<void> {
  // Postgres reads uuids case-blind; lower case, so one id is sent once.
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length === 0) return;
  const { error } = await supabase.rpc("log_checkin_views", { p_checkin_ids: unique, p_kind: kind });
  if (error) {
    console.error("view log: noting failed", { code: error.code });
    throw new ViewLogError(error.code);
  }
}

// What the Diary reads of its owner's log: never the owner (it's them) or the Singapore day (the
// time says it).
export const VIEW_LOG_COLUMNS = "id, checkin_id, week_start, viewer_id, viewer_name, viewer_role, kind, viewed_at";

export type ViewLogRow = {
  id: string;
  checkin_id: string | null; // null once a Master Admin reset the check-in
  week_start: string; // the check-in's Monday, 'YYYY-MM-DD'
  viewer_id: string | null; // null if the viewer's member row was deleted
  viewer_name: string; // as it was when they looked
  viewer_role: "leader" | "hq"; // as it was when they looked
  kind: ViewKind;
  viewed_at: string; // the first time that Singapore day
};

// Every row of the member's own log. RLS (0015) hands each member only their own rows; the owner_id
// filter says so here too. Paged by id, like every list that could pass PostgREST's 1,000 rows.
export const loadViewLog = (supabase: SupabaseClient, ownerId: string) =>
  selectAll<ViewLogRow>((after) => {
    let query = supabase.from("checkin_views").select(VIEW_LOG_COLUMNS).eq("owner_id", ownerId);
    if (after) query = query.gt("id", after);
    return query.order("id").limit(PAGE_SIZE).overrideTypes<ViewLogRow[], { merge: false }>();
  });

export type ViewLine = {
  kind: ViewKind;
  at: string; // viewed_at
  reset: boolean; // it was an earlier check-in for that week, since reset
};

// One person's views of one week's check-in, newest first, under the name and label they had when
// they last looked.
export type ViewGroup = { name: string; role: "Leader" | "HQ"; lines: ViewLine[] };

const ROLE_LABEL: Record<ViewLogRow["viewer_role"], ViewGroup["role"]> = { leader: "Leader", hq: "HQ" };

// The log by week ('YYYY-MM-DD' Monday): a group per viewer (by their member id, or by name once
// their row is gone), the most recent viewer first. Named fields only, so the viewer's id, and
// anything else on a row, never reaches the page.
export function viewsByWeek(rows: readonly ViewLogRow[]): Map<string, ViewGroup[]> {
  const weeks = new Map<string, Map<string, { group: ViewGroup; latest: string }>>();
  for (const row of rows) {
    const key = row.viewer_id !== null ? `id:${row.viewer_id}` : `name:${row.viewer_name}`;
    let viewers = weeks.get(row.week_start);
    if (!viewers) weeks.set(row.week_start, (viewers = new Map()));
    let entry = viewers.get(key);
    if (!entry) viewers.set(key, (entry = { group: { name: row.viewer_name, role: "Leader", lines: [] }, latest: "" }));
    entry.group.lines.push({ kind: row.kind === "played" ? "played" : "opened", at: row.viewed_at, reset: row.checkin_id === null });
    if (newer(row.viewed_at, entry.latest)) {
      entry.latest = row.viewed_at;
      entry.group.name = row.viewer_name;
      entry.group.role = ROLE_LABEL[row.viewer_role] ?? "Leader";
    }
  }
  const out = new Map<string, ViewGroup[]>();
  for (const [week, viewers] of weeks) {
    const groups = [...viewers.values()].map(({ group }) => {
      group.lines.sort((a, b) => time(b.at) - time(a.at));
      return group;
    });
    groups.sort((a, b) => time(b.lines[0].at) - time(a.lines[0].at));
    out.set(week, groups);
  }
  return out;
}

const time = (iso: string) => Date.parse(iso);
const newer = (iso: string, than: string) => than === "" || time(iso) >= time(than);
