import type { OrgNode } from "./org";
import { subtree, type TeamNode } from "./tree";

export type CheckedInRow = { teamId: string; name: string; people: number; checkedIn: number };

// How many of the people now placed in each box (the team and every team under it) have checked
// in this week. Counts only: never who. A person counts where they sit now, and once. Note that a
// leader reads only check-ins made in the teams they lead (RLS), so someone who moved into one of
// them mid-week after checking in elsewhere shows as not checked in to that leader until next
// week; hq reads every check-in, so sees them as checked in.
export function checkedInCounts(
  nodes: readonly OrgNode[],
  teams: readonly TeamNode[],
  members: readonly { id: string; team_id: string | null }[],
  checkedInIds: ReadonlySet<string>,
): CheckedInRow[] {
  const byTeam = new Map<string, string[]>();
  for (const m of members) {
    if (m.team_id) byTeam.set(m.team_id, [...(byTeam.get(m.team_id) ?? []), m.id]);
  }
  return nodes.map((node) => {
    const people = subtree(teams, node.teamId).flatMap((t) => byTeam.get(t.id) ?? []);
    return {
      teamId: node.teamId,
      name: node.name,
      people: people.length,
      checkedIn: people.filter((id) => checkedInIds.has(id)).length,
    };
  });
}
