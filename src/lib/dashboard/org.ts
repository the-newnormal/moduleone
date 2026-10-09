import { type CellHealth, type HealthConfig, type MaybeScores, teamWeekHealth } from "@/lib/health/health";
import { compareTeams, type TeamNode } from "./tree";

// Only the columns the heat-map needs; transcripts and reviews load on the drill-in page.
export type CheckinRow = MaybeScores & { team_id: string | null; week_start: string };

export type HeatmapCell = {
  week: string;
  health: CellHealth | null; // null: nothing graded that week
  pending: number; // check-ins still waiting for the grader
};

// Whether the viewer reads every check-in made in a team: hq reads all of them, a leader those
// made in the teams they lead and in every team under those (app_led_team_ids, migration 0003).
export type Coverage = (teamId: string) => boolean;

export function coverage(role: string | null, ledTeams: readonly string[]): Coverage {
  if (role === "hq") return () => true;
  const led = new Set(ledTeams);
  return (teamId) => led.has(teamId);
}

export type OrgNode = {
  teamId: string;
  name: string;
  kind: TeamNode["kind"];
  archived: boolean;
  // The viewer reads every check-in made here and under here, so `cells` covers all of them.
  // Otherwise the node is only shown to place the teams under it, and has no cells: a mean of
  // the few check-ins the viewer happens to see would pass for the whole team's.
  scored: boolean;
  cells: HeatmapCell[]; // a week each, oldest first, over this team and every team under it
  children: OrgNode[];
};

// Check-ins outside the scored tree, one row per team, over that team's own check-ins: made with
// no team, or in a team the viewer doesn't cover. RLS lets a leader read only their own check-ins
// there, so those rows are named as theirs, never as the team's health.
export type LooseRow = { teamId: string | null; name: string; archived: boolean; cells: HeatmapCell[] };

export type Org = { roots: OrgNode[]; loose: LooseRow[] };

// A React key for a loose row, apart from its team's node in the tree.
export const looseKey = (row: LooseRow) => `loose:${row.teamId ?? "none"}`;

const NO_TEAM = "No team";
const UNSEEN_TEAM = "an earlier team";

// A row of the viewer's own check-ins in a team they don't cover.
export const yours = (team: string | null) => `Your check-ins · ${team ?? UNSEEN_TEAM}`;

export const isPending = (c: MaybeScores) =>
  c.activity_score === null && c.excellence_score === null && c.morale_score === null;

export function cellsFor(
  checkins: readonly CheckinRow[],
  weeks: readonly string[],
  config: HealthConfig,
): HeatmapCell[] {
  return weeks.map((week) => {
    const cell = checkins.filter((c) => c.week_start === week);
    return { week, health: teamWeekHealth(cell, config), pending: cell.filter(isPending).length };
  });
}

// The org chart as the viewer may read it, each team's health rolled up from every team under it.
// RLS has already decided which teams and check-ins the viewer gets.
//
// A team the viewer covers is shown unless it's archived with no check-ins in range; one they
// don't cover is shown only above a team that is (a leader sees the division and domain above the
// teams they lead, uncoloured). Archived teams' check-ins still count towards the teams above.
export function buildOrg({
  teams,
  checkins,
  weeks,
  config,
  covers,
}: {
  teams: readonly TeamNode[];
  checkins: readonly CheckinRow[];
  weeks: readonly string[];
  config: HealthConfig;
  covers: Coverage;
}): Org {
  const inRange = new Set(weeks);
  const byTeam = new Map<string | null, CheckinRow[]>();
  for (const c of checkins) {
    if (inRange.has(c.week_start)) byTeam.set(c.team_id, [...(byTeam.get(c.team_id) ?? []), c]);
  }

  const byId = new Map(teams.map((t) => [t.id, t]));
  const children = new Map<string, TeamNode[]>();
  const roots: TeamNode[] = [];
  for (const t of teams) {
    // A parent the viewer can't see makes the team a root.
    if (t.parent_id && byId.has(t.parent_id)) children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t]);
    else roots.push(t);
  }

  // Teams whose check-ins are in a scored node's cells.
  const counted = new Set<string>();
  const seen = new Set<string>();
  const build = (team: TeamNode): { node: OrgNode | null; checkins: CheckinRow[] } => {
    seen.add(team.id);
    const below = [...(children.get(team.id) ?? [])]
      .filter((c) => !seen.has(c.id))
      .sort(compareTeams)
      .map(build);
    const all = [...(byTeam.get(team.id) ?? []), ...below.flatMap((b) => b.checkins)];
    const shown = below.flatMap((b) => (b.node ? [b.node] : []));
    const scored = covers(team.id);
    if (scored) counted.add(team.id);
    const archived = team.archived_at !== null;
    const listed = shown.length > 0 || (scored && (!archived || all.length > 0));
    return {
      node: listed
        ? {
            teamId: team.id,
            name: team.name,
            kind: team.kind,
            archived,
            scored,
            cells: scored ? cellsFor(all, weeks, config) : [],
            children: shown,
          }
        : null,
      checkins: all,
    };
  };
  const tree = [...roots].sort(compareTeams).flatMap((r) => build(r).node ?? []);

  const loose: LooseRow[] = [];
  for (const [teamId, rows] of byTeam) {
    if (teamId !== null && counted.has(teamId)) continue;
    const team = teamId === null ? undefined : byId.get(teamId);
    loose.push({
      teamId,
      name: teamId === null ? NO_TEAM : yours(team?.name ?? null),
      archived: team?.archived_at != null,
      cells: cellsFor(rows, weeks, config),
    });
  }
  // Teams the viewer can see by name, then unseen ones, then no team.
  const rank = (r: LooseRow) => (r.teamId === null ? 2 : byId.has(r.teamId) ? 0 : 1);
  loose.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || (a.teamId ?? "").localeCompare(b.teamId ?? ""));

  return { roots: tree, loose };
}
