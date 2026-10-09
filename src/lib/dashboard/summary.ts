import type { Band } from "@/lib/health/health";
import type { Org, OrgNode } from "./org";

export type BandCounts = Record<Band, number> & { ungraded: number };

// How many domain and team boxes are each colour in the org's last week (the week picked on the org
// chart; this week on the Trend tab). It counts the boxes the viewer sees coloured, as the chart
// shows them: a domain counts as well as the teams under it, the organisation and divisions don't
// count, nor do a leader's own check-ins in teams they don't lead. `ungraded`: boxes with nothing
// graded that week.
export function domainTeamCounts(org: Org): BandCounts {
  const counts: BandCounts = { green: 0, yellow: 0, red: 0, ungraded: 0 };
  const visit = (node: OrgNode) => {
    if (node.scored && (node.kind === "domain" || node.kind === "team")) {
      const band = node.cells.at(-1)?.health?.band;
      counts[band ?? "ungraded"] += 1;
    }
    node.children.forEach(visit);
  };
  org.roots.forEach(visit);
  return counts;
}
