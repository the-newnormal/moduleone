import type { HeatmapCell, Org, OrgNode } from "./org";

export type HeatmapRow = {
  teamId: string | null; // null: check-ins made while the member had no team
  name: string;
  depth: number; // 1 for a team under a domain, to indent it
  archived: boolean;
  // false: a domain the viewer doesn't lead, shown only above the teams they do; it has no cells
  scored: boolean;
  cells: HeatmapCell[];
};

export type HeatmapGroup = { key: string | null; label: string | null; rows: HeatmapRow[] }; // null: "Other"

// The org chart (./org.ts) as the trend grid's rows: a group per division, its domains and their
// teams beneath in org-chart order, each row covering its team and every team under it. Domains
// outside any division, and check-ins outside the scored tree, go last, in "Other".
export function heatmapGroups({ roots, loose }: Org): HeatmapGroup[] {
  const rows = (node: OrgNode, depth: number): HeatmapRow[] => [
    {
      teamId: node.teamId,
      name: node.name,
      depth,
      archived: node.archived,
      scored: node.scored,
      cells: node.cells,
    },
    ...node.children.flatMap((child) => rows(child, depth + 1)),
  ];

  const groups: HeatmapGroup[] = roots
    .filter((root) => root.kind === "division")
    .map((division) => ({
      key: division.teamId,
      label: division.name,
      rows: division.children.flatMap((child) => rows(child, 0)),
    }))
    .filter((group) => group.rows.length > 0);

  const other = [
    ...roots.filter((root) => root.kind !== "division").flatMap((root) => rows(root, 0)),
    ...loose.map((row) => ({ ...row, depth: 0, scored: true })),
  ];
  return other.length > 0 ? [...groups, { key: null, label: null, rows: other }] : groups;
}
