import { type CellHealth, type HealthConfig, type MaybeScores, teamWeekHealth } from "@/lib/health/health";

export type TeamRow = {
  id: string;
  name: string;
  division: string | null;
  archived_at: string | null;
};

// Only the columns the grid needs; transcripts and reviews load on the drill-in page.
export type CheckinRow = MaybeScores & { team_id: string | null; week_start: string };

export type HeatmapCell = {
  week: string;
  health: CellHealth | null; // null: nothing graded that week
  pending: number; // check-ins still waiting for the grader
};

export type HeatmapRow = {
  teamId: string | null; // null: check-ins made while the member had no team
  name: string;
  archived: boolean;
  cells: HeatmapCell[];
};

export type HeatmapGroup = { division: string | null; rows: HeatmapRow[] };

const NO_TEAM = "No team";
// A member who moved team still sees their own earlier check-ins, but not the team they were in.
const UNSEEN_TEAM = "Earlier team";

const isPending = (c: MaybeScores) =>
  c.activity_score === null && c.excellence_score === null && c.morale_score === null;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// Teams × weeks. Rows are the active teams the viewer can see, plus any archived or unseen team
// with check-ins in range; RLS has already decided which check-ins the viewer gets. Groups follow
// the team's division, alphabetically, with team-less rows last.
export function buildHeatmap({
  teams,
  checkins,
  weeks,
  config,
}: {
  teams: readonly TeamRow[];
  checkins: readonly CheckinRow[];
  weeks: readonly string[];
  config: HealthConfig;
}): HeatmapGroup[] {
  const inRange = new Set(weeks);
  const byCell = new Map<string, CheckinRow[]>();
  const teamsWithCheckins = new Set<string | null>();
  for (const c of checkins) {
    if (!inRange.has(c.week_start)) continue;
    const key = `${c.team_id ?? ""}|${c.week_start}`;
    byCell.set(key, [...(byCell.get(key) ?? []), c]);
    teamsWithCheckins.add(c.team_id);
  }

  const row = (teamId: string | null, name: string, archived: boolean): HeatmapRow => ({
    teamId,
    name,
    archived,
    cells: weeks.map((week) => {
      const cell = byCell.get(`${teamId ?? ""}|${week}`) ?? [];
      return { week, health: teamWeekHealth(cell, config), pending: cell.filter(isPending).length };
    }),
  });

  const groups = new Map<string | null, HeatmapRow[]>();
  const add = (division: string | null, r: HeatmapRow) =>
    groups.set(division, [...(groups.get(division) ?? []), r]);

  const known = new Set(teams.map((t) => t.id));
  for (const t of teams) {
    const archived = t.archived_at !== null;
    if (archived && !teamsWithCheckins.has(t.id)) continue;
    add(t.division, row(t.id, t.name, archived));
  }
  for (const teamId of teamsWithCheckins) {
    if (teamId === null) add(null, row(null, NO_TEAM, false));
    else if (!known.has(teamId)) add(null, row(teamId, UNSEEN_TEAM, false));
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([division, rows]) => ({ division, rows: rows.sort(byName) }));
}
