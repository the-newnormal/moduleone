import { type CheckinRow, type Coverage, isPending, type Org, type OrgNode } from "./org";

// The portal's glance at team health: the topmost boxes the viewer covers, as on the org chart.
// For hq that's the organisation and the divisions in it (plus any unplaced domains); for a
// division head their division and its domains; for a leader the teams they lead. It never takes
// org.loose: for a leader those rows are their own check-ins in teams they don't cover (their own
// grade, not a team's), and hq's "No team" row stays on the Team health page.
export type Glance = { summary: OrgNode | null; rows: OrgNode[]; other: OrgNode[]; more: number };

// The highest scored boxes: a box the viewer doesn't cover is only there to place the ones under it.
const tops = (nodes: readonly OrgNode[]): OrgNode[] => nodes.flatMap((n) => (n.scored ? [n] : tops(n.children)));

export function glance(org: Org, limit = 6): Glance {
  const all = tops(org.roots);
  const organisation = all.find((n) => n.kind === "organisation") ?? null;
  // One box above everything else: show it, then what's directly under it.
  const summary = organisation ?? (all.length === 1 && all[0].children.length > 0 ? all[0] : null);
  const rows = summary ? tops(summary.children) : all;
  const other = organisation ? all.filter((n) => n !== organisation) : [];
  const shownRows = rows.slice(0, limit);
  const shownOther = other.slice(0, Math.max(0, limit - shownRows.length));
  return {
    summary,
    rows: shownRows,
    other: shownOther,
    more: rows.length + other.length - shownRows.length - shownOther.length,
  };
}

// How many check-ins the viewer covers in a week, and how many are still waiting for the grader.
// Counted from the rows themselves (each once), not by adding up boxes that already take in the
// boxes under them. Like the glance, it leaves out a leader's own check-ins in teams they don't
// cover; hq covers check-ins made with no team.
export function weekTally(
  checkins: readonly CheckinRow[],
  week: string,
  role: string | null,
  covers: Coverage,
): { checkins: number; pending: number } {
  const rows = checkins.filter(
    (c) => c.week_start === week && (c.team_id === null ? role === "hq" : covers(c.team_id)),
  );
  return { checkins: rows.length, pending: rows.filter(isPending).length };
}
