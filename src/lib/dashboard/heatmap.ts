import { type CellHealth, type HealthConfig, type MaybeScores, teamWeekHealth } from "@/lib/health/health";
import { compareGroups, comparePaths, placeTeams, type TeamGroup, type TeamNode } from "./tree";

export type { TeamNode } from "./tree";

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
  depth: number; // 1 for a sub-team under a domain, to indent it
  archived: boolean;
  cells: HeatmapCell[];
};

export type HeatmapGroup = { key: string | null; label: string | null; rows: HeatmapRow[] }; // null: "Other"

const NO_TEAM = "No team";
// A member who moved team still sees their own earlier check-ins, but not the team they were in.
const UNSEEN_TEAM = "Earlier team";

const isPending = (c: MaybeScores) =>
  c.activity_score === null && c.excellence_score === null && c.morale_score === null;

// Teams × weeks, grouped by division and ordered as the org chart is (src/lib/dashboard/tree.ts).
// RLS has already decided which teams and check-ins the viewer gets. A team gets a row when it
// has check-ins in range, or when showEmpty says an empty row is news (only true where the viewer
// can see all of the team's check-ins, so an empty cell really means nobody checked in).
// Divisions and archived teams never get an empty row. Check-ins with no team, or a team the
// viewer can't see, go last.
export function buildHeatmap({
  teams,
  checkins,
  weeks,
  config,
  showEmpty,
}: {
  teams: readonly TeamNode[];
  checkins: readonly CheckinRow[];
  weeks: readonly string[];
  config: HealthConfig;
  showEmpty: (teamId: string) => boolean;
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

  const row = (teamId: string | null, name: string, depth: number, archived: boolean): HeatmapRow => ({
    teamId,
    name,
    depth,
    archived,
    cells: weeks.map((week) => {
      const cell = byCell.get(`${teamId ?? ""}|${week}`) ?? [];
      return { week, health: teamWeekHealth(cell, config), pending: cell.filter(isPending).length };
    }),
  });

  type Placed = { row: HeatmapRow; path: readonly TeamNode[] };
  const groups = new Map<string | null, { group: TeamGroup | null; placed: Placed[] }>();
  const add = (group: TeamGroup | null, placed: Placed) => {
    const entry = groups.get(group?.key ?? null) ?? { group, placed: [] };
    entry.placed.push(placed);
    groups.set(group?.key ?? null, entry);
  };

  const placements = placeTeams(teams);
  for (const t of teams) {
    const archived = t.archived_at !== null;
    const listed = teamsWithCheckins.has(t.id) || (!archived && t.kind !== "division" && showEmpty(t.id));
    if (!listed) continue;
    const { group, depth, path } = placements.get(t.id)!;
    add(group, { row: row(t.id, t.name, depth, archived), path });
  }
  // Last in "Other", after its real teams: unseen teams, then no team.
  const extras: HeatmapRow[] = [];
  for (const teamId of teamsWithCheckins) {
    if (teamId !== null && !placements.has(teamId)) extras.push(row(teamId, UNSEEN_TEAM, 0, false));
  }
  if (teamsWithCheckins.has(null)) extras.push(row(null, NO_TEAM, 0, false));
  if (extras.length && !groups.has(null)) groups.set(null, { group: null, placed: [] });

  return [...groups.values()]
    .sort((a, b) => (a.group === null ? 1 : b.group === null ? -1 : compareGroups(a.group, b.group)))
    .map(({ group, placed }) => ({
      key: group?.key ?? null,
      label: group?.label ?? null,
      rows: [
        ...placed.sort((a, b) => comparePaths(a.path, b.path)).map((p) => p.row),
        ...(group === null ? extras : []),
      ],
    }));
}
