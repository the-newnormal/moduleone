import type { HeatmapCell, OrgNode } from "./org";
import type { TeamNode } from "./tree";

// Who the portal's "Needs a look" tile is for. Today: hq, and leaders who lead a live division
// (sitting in it or added as one of its leads) or the organisation above every division. To open it
// to more leaders, add their level here (e.g. "domain"); to close it to hq, set NEEDS_A_LOOK_FOR_HQ
// false.
export const NEEDS_A_LOOK_LEADS: readonly TeamNode["kind"][] = ["organisation", "division"];
export const NEEDS_A_LOOK_FOR_HQ = true;

// `ledTeams` is app_led_team_ids: the teams the viewer leads and everything under them.
export function seesNeedsALook(role: string | null, teams: readonly TeamNode[], ledTeams: readonly string[]): boolean {
  if (role === "hq") return NEEDS_A_LOOK_FOR_HQ;
  if (role !== "leader") return false;
  const led = new Set(ledTeams);
  // An archived division keeps its team_leads rows (0006), but leading it no longer counts.
  return teams.some((t) => led.has(t.id) && t.archived_at === null && NEEDS_A_LOOK_LEADS.includes(t.kind));
}

export type RedSpot = {
  teamId: string;
  name: string;
  // The names above it, root-first, as far as the viewer covers ("Culture" above "Atlas").
  context: string[];
  cell: HeatmapCell;
  // The box itself is red, or it's green or yellow with someone in it red.
  red: boolean;
};

// The smallest boxes with a red check-in in `week`, so a red team is named once rather than with
// every box above it. A box above is named too when red check-ins were made in it directly (by the
// people who sit in a domain, a division or the organisation), since no box below holds those.
// Walks the boxes the viewer covers only (never org.loose, which for a leader is their own grade).
export function redSpots(roots: readonly OrgNode[], week: string): RedSpot[] {
  const spots: RedSpot[] = [];
  // Returns how many of the box's red check-ins the spots at or under it account for. A box's cell
  // counts every check-in under it, so reds beyond its children's were made in the box itself.
  const walk = (node: OrgNode, context: string[]): number => {
    // The organisation is above everything, so naming it adds nothing.
    const named = node.scored && node.kind !== "organisation" ? [...context, node.name] : context;
    const below = node.children.reduce((sum, child) => sum + walk(child, named), 0);
    const cell = node.cells.find((c) => c.week === week);
    const reds = cell?.health?.bands.red ?? 0;
    if (!node.scored || !cell || reds <= below) return below;
    spots.push({ teamId: node.teamId, name: node.name, context, cell, red: cell.health?.band === "red" });
    return reds;
  };
  for (const root of roots) walk(root, []);
  // Red boxes first, then by how many check-ins were red.
  return spots.sort(
    (a, b) => Number(b.red) - Number(a.red) || (b.cell.health?.bands.red ?? 0) - (a.cell.health?.bands.red ?? 0),
  );
}
