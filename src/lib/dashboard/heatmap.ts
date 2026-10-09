import { type HeatmapCell, looseKey, type Org, type OrgNode } from "./org";

export type HeatmapRow = {
  key: string; // unique in the grid: a team can have both a row in the tree and a loose row
  teamId: string | null; // null: check-ins made while the member had no team
  name: string;
  depth: number; // 1 for a team under a domain, to indent it
  archived: boolean;
  // false: a domain the viewer doesn't lead, shown only above the teams they do; it has no cells
  scored: boolean;
  cells: HeatmapCell[];
};

export type HeatmapGroup = {
  key: string | null;
  label: string | null; // null: "Other"
  // The division's own row, over everything in it (its head's check-ins included); null for Other
  // and for a division the viewer doesn't cover.
  head: HeatmapRow | null;
  rows: HeatmapRow[];
};

// The org chart (./org.ts) as the trend grid's rows: a group per division, headed by the division's
// own row, its domains and their teams beneath in org-chart order, each row covering its team and
// every team under it. Domains outside any division, and check-ins outside the scored tree, go
// last, in "Other". The organisation node (migration 0006), when the viewer covers it, comes first
// as a group of its own: its row rolls up the whole organisation.
export function heatmapGroups(org: Org): HeatmapGroup[] {
  const { loose } = org;
  const organisations = org.roots.filter((root) => root.kind === "organisation");
  const roots = org.roots.flatMap((root) => (root.kind === "organisation" ? root.children : [root]));
  const row = (node: OrgNode, depth: number): HeatmapRow => ({
    key: node.teamId,
    teamId: node.teamId,
    name: node.name,
    depth,
    archived: node.archived,
    scored: node.scored,
    cells: node.cells,
  });
  const rows = (node: OrgNode, depth: number): HeatmapRow[] => [
    row(node, depth),
    ...node.children.flatMap((child) => rows(child, depth + 1)),
  ];
  const hasCheckins = (r: HeatmapRow) => r.cells.some((c) => c.health !== null || c.pending > 0);

  const group = (node: OrgNode, below: HeatmapRow[]): HeatmapGroup => ({
    key: node.teamId,
    label: node.name,
    head: node.scored ? row(node, 0) : null,
    rows: below,
  });
  // The organisation's row is always there for a viewer who covers it, like the org chart's box;
  // a division is left out when it has nothing to show.
  const groups = [
    ...organisations.filter((node) => node.scored).map((node) => group(node, [])),
    ...roots
      .filter((root) => root.kind === "division")
      .map((division) => group(division, division.children.flatMap((child) => rows(child, 0))))
      .filter((g) => g.rows.length > 0 || (g.head !== null && hasCheckins(g.head))),
  ];

  const other = [
    ...roots.filter((root) => root.kind !== "division").flatMap((root) => rows(root, 0)),
    ...loose.map((row) => ({ ...row, key: looseKey(row), depth: 0, scored: true })),
  ];
  return other.length > 0 ? [...groups, { key: null, label: null, head: null, rows: other }] : groups;
}
