import type { Band } from "@/lib/health/health";
import type { Org, OrgNode } from "./org";

export type BandCounts = Record<Band, number> & { ungraded: number };

const live = (node: OrgNode) => {
  const cell = node.cells.at(-1);
  return !node.archived || cell?.health != null || (cell?.pending ?? 0) > 0;
};

// How many teams are each colour in the org's last week (the week picked on the org chart; this
// week on the Trend tab), from the boxes the viewer sees coloured: every team, and every domain
// with no teams under it on the chart. A domain with teams counts through them alone; the
// organisation and divisions don't count, nor do a leader's own check-ins in teams they don't lead.
// `ungraded`: those with nothing graded that week. An archived team stays on the chart while it has
// check-ins in the range shown, but counts only in a week it has some; otherwise it's gone, and
// doesn't stop its domain counting either.
export function teamCounts(org: Org): BandCounts {
  const counts: BandCounts = { green: 0, yellow: 0, red: 0, ungraded: 0 };
  const visit = (node: OrgNode) => {
    if (node.scored && live(node) && (node.kind === "team" || (node.kind === "domain" && !node.children.some(live)))) {
      const band = node.cells.at(-1)?.health?.band;
      counts[band ?? "ungraded"] += 1;
    }
    node.children.forEach(visit);
  };
  org.roots.forEach(visit);
  return counts;
}
