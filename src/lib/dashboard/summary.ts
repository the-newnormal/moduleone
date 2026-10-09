import type { Band } from "@/lib/health/health";
import type { Org, OrgNode } from "./org";

export type BandCounts = Record<Band, number> & { ungraded: number };

// How many teams are each colour in the org's last week (the week picked on the org chart; this
// week on the Trend tab), from the boxes the viewer sees coloured: every team, and every domain
// with no teams under it on the chart. A domain with teams counts through them alone; the
// organisation and divisions don't count, nor do a leader's own check-ins in teams they don't lead.
// `ungraded`: those with nothing graded that week.
export function teamCounts(org: Org): BandCounts {
  const counts: BandCounts = { green: 0, yellow: 0, red: 0, ungraded: 0 };
  const visit = (node: OrgNode) => {
    if (node.scored && (node.kind === "team" || (node.kind === "domain" && node.children.length === 0))) {
      const band = node.cells.at(-1)?.health?.band;
      counts[band ?? "ungraded"] += 1;
    }
    node.children.forEach(visit);
  };
  org.roots.forEach(visit);
  return counts;
}
