import type { OrgNode } from "./org";
import { subtree, type TeamNode } from "./tree";

export type CheckedInRow = { teamId: string; name: string; people: number; checkedIn: number };

// How many of the people now placed in each box (the team and every team under it) have checked
// in this week. Counts only: never who. A person counts where they sit now, wherever their
// check-in was made, so someone who moved mid-week counts once, in their new team.
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
