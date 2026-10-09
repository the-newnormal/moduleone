import { compareSiblings } from "@/lib/admin/tree";
import type { TeamKind } from "@/lib/admin/validate";

// Where each team sits in Normal's structure (migration 0003): divisions at the root, domains
// under a division (or at the root, unplaced), teams under a domain. Since migration 0006 one
// organisation node is the root above every division. Siblings are ordered as the admin pages
// order them: sort_order, then name, then id.

export type TeamNode = {
  id: string;
  name: string;
  archived_at: string | null;
  parent_id: string | null;
  kind: TeamKind;
  sort_order: number;
};

export const compareTeams: (a: TeamNode, b: TeamNode) => number = compareSiblings;

// The team and its visible ancestors, root-first. RLS may hide an ancestor; the walk stops there.
export function lineage(byId: ReadonlyMap<string, TeamNode>, team: TeamNode): TeamNode[] {
  const chain = [team];
  const seen = new Set([team.id]);
  for (let parent = team.parent_id; parent && !seen.has(parent); ) {
    const node = byId.get(parent);
    if (!node) break;
    chain.push(node);
    seen.add(node.id);
    parent = node.parent_id;
  }
  return chain.reverse();
}

// "Gather › IP Lab" above IP Lab 1: the names of the visible ancestors, root-first.
export function teamContext(teams: readonly TeamNode[], teamId: string): string[] {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const team = byId.get(teamId);
  return team
    ? lineage(byId, team)
        .slice(0, -1)
        .map((t) => t.name)
    : [];
}

// The team and every visible team under it, archived ones included, depth-first in org-chart
// order (each team before the teams under it). Empty for a team the viewer can't see.
export function subtree(teams: readonly TeamNode[], teamId: string): TeamNode[] {
  const children = new Map<string, TeamNode[]>();
  for (const t of teams) {
    if (t.parent_id) children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t]);
  }
  const root = teams.find((t) => t.id === teamId);
  const out: TeamNode[] = [];
  const seen = new Set<string>();
  const walk = (team: TeamNode) => {
    if (seen.has(team.id)) return;
    seen.add(team.id);
    out.push(team);
    for (const child of [...(children.get(team.id) ?? [])].sort(compareTeams)) walk(child);
  };
  if (root) walk(root);
  return out;
}
