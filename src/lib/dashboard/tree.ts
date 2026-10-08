// Where each team sits in Normal's structure, for grouping and ordering the dashboard.
//
// Teams form a tree (migration 0003): divisions at the root, domains under divisions, sub-teams
// under domains, siblings ordered by sort_order then name. Before 0003 there is no tree, only a
// free-text `division`; loadTeams fills the tree columns with null then, and everything here
// falls back to grouping by that text. Drop the fallback once 0003 is on main.

export type TeamNode = {
  id: string;
  name: string;
  archived_at: string | null;
  parent_id: string | null;
  kind: string | null; // 'division' | 'domain' | 'team'; null before the team tree
  sort_order: number | null;
  division: string | null; // the pre-tree free-text division; unused once kind is set
};

export type TeamGroup = { key: string; label: string; sort_order: number | null };

export type Placement = {
  group: TeamGroup | null; // null: no division the viewer can see
  depth: number; // 0 for a domain, 1 for a sub-team under it
  path: readonly TeamNode[]; // root-first, below the division, ending with the team itself
};

export const isTreeShaped = (teams: readonly TeamNode[]) => teams.some((t) => t.kind !== null);

// Siblings: sort_order first (unset last), then name, then id so twins never interleave.
export function compareTeams(a: TeamNode, b: TeamNode): number {
  const order = (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity);
  if (order) return order;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function compareGroups(a: TeamGroup, b: TeamGroup): number {
  const order = (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity);
  if (order) return order;
  return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
}

// Depth-first order: compare the paths node by node, parents before their children.
export function comparePaths(a: readonly TeamNode[], b: readonly TeamNode[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].id !== b[i].id) return compareTeams(a[i], b[i]);
  }
  return a.length - b.length;
}

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

export function placeTeams(teams: readonly TeamNode[]): Map<string, Placement> {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const tree = isTreeShaped(teams);
  const placements = new Map<string, Placement>();
  for (const team of teams) {
    if (!tree) {
      const group = team.division
        ? { key: `division:${team.division}`, label: team.division, sort_order: null }
        : null;
      placements.set(team.id, { group, depth: 0, path: [team] });
      continue;
    }
    const chain = lineage(byId, team);
    const root = chain[0];
    // A division only holds check-ins by accident (people sit in domains and teams); if it does,
    // its row leads its own group (an empty path sorts first).
    const inDivision = root.kind === "division";
    const path = inDivision ? chain.slice(1) : chain;
    placements.set(team.id, {
      group: inDivision ? { key: root.id, label: root.name, sort_order: root.sort_order } : null,
      depth: Math.max(0, path.length - 1),
      path,
    });
  }
  return placements;
}

// "Gather › IP" for a team in the IP domain of the Gather division; the division text before 0003.
export function teamContext(teams: readonly TeamNode[], teamId: string): string[] {
  const team = teams.find((t) => t.id === teamId);
  if (!team) return [];
  if (!isTreeShaped(teams)) return team.division ? [team.division] : [];
  const byId = new Map(teams.map((t) => [t.id, t]));
  return lineage(byId, team)
    .slice(0, -1)
    .map((t) => t.name);
}
