import { describe, expect, it } from "vitest";
import { heatmapGroups } from "./heatmap";
import type { HeatmapCell, Org, OrgNode } from "./org";

const CELLS: HeatmapCell[] = [{ week: "2026-10-05", health: null, pending: 0 }];

const node = (
  teamId: string,
  name: string,
  kind: OrgNode["kind"],
  children: OrgNode[] = [],
  scored = true,
): OrgNode => ({ teamId, name, kind, archived: false, scored, cells: scored ? CELLS : [], children });

const rows = (org: Org) => heatmapGroups(org).map((g) => [g.label, g.rows.map((r) => [r.name, r.depth, r.scored])]);

describe("heatmapGroups", () => {
  it("makes a group per division, its domains at depth 0 and their teams indented beneath", () => {
    const org: Org = {
      roots: [
        node("ga", "Gather", "division", [
          node("ip", "IP Lab", "domain", [node("ip1", "IP Lab 1", "team"), node("ip2", "IP Lab 2", "team")]),
          node("bq", "Barbeques", "domain"),
        ]),
        node("cu", "Culture", "division", [node("at", "Atlas", "domain")]),
      ],
      loose: [],
    };
    expect(rows(org)).toEqual([
      [
        "Gather",
        [
          ["IP Lab", 0, true],
          ["IP Lab 1", 1, true],
          ["IP Lab 2", 1, true],
          ["Barbeques", 0, true],
        ],
      ],
      ["Culture", [["Atlas", 0, true]]],
    ]);
  });

  it("keeps a leader's uncoloured domain above the teams they lead, and skips empty divisions", () => {
    const org: Org = {
      roots: [
        node("ga", "Gather", "division", [node("ip", "IP Lab", "domain", [node("ip1", "IP Lab 1", "team")], false)], false),
        node("sp", "Special Projects", "division"),
      ],
      loose: [],
    };
    expect(rows(org)).toEqual([
      [
        "Gather",
        [
          ["IP Lab", 0, false],
          ["IP Lab 1", 1, true],
        ],
      ],
    ]);
  });

  it("puts domains outside any division, then loose check-ins, in a last Other group", () => {
    const org: Org = {
      roots: [
        node("ga", "Gather", "division", [node("bq", "Barbeques", "domain")]),
        node("x", "Unplaced", "domain", [node("x1", "Unplaced 1", "team")]),
      ],
      loose: [{ teamId: null, name: "No team", archived: false, cells: CELLS }],
    };
    expect(rows(org)).toEqual([
      ["Gather", [["Barbeques", 0, true]]],
      [
        null,
        [
          ["Unplaced", 0, true],
          ["Unplaced 1", 1, true],
          ["No team", 0, true],
        ],
      ],
    ]);
  });

  it("keys a loose row apart from its team's row in the tree", () => {
    // A leader's own check-in in an unplaced domain they don't lead, above a team they do.
    const org: Org = {
      roots: [node("x", "Unplaced", "domain", [node("x1", "Unplaced 1", "team")], false)],
      loose: [{ teamId: "x", name: "Your check-ins · Unplaced", archived: false, cells: CELLS }],
    };
    const [other] = heatmapGroups(org);
    expect(other.rows.map((r) => [r.key, r.teamId])).toEqual([
      ["x", "x"],
      ["x1", "x1"],
      ["loose:x", "x"],
    ]);
  });

  it("heads a division the viewer covers with its own row, and keeps it while it has check-ins", () => {
    const busy: HeatmapCell[] = [{ week: "2026-10-05", health: null, pending: 1 }];
    const org: Org = {
      roots: [
        node("ga", "Gather", "division", [node("bq", "Barbeques", "domain")]),
        { ...node("cu", "Culture", "division"), cells: busy }, // its head's check-in, nothing under it
        node("sp", "Special Projects", "division"), // nothing at all
        node("hq", "HQ", "division", [node("fn", "Finance", "domain")], false), // a leader's context
      ],
      loose: [],
    };
    expect(heatmapGroups(org).map((g) => [g.label, g.head && [g.head.key, g.head.cells], g.rows.length])).toEqual([
      ["Gather", ["ga", CELLS], 1],
      ["Culture", ["cu", busy], 0],
      ["HQ", null, 1],
    ]);
  });

  it("returns no groups for an empty org", () => {
    expect(heatmapGroups({ roots: [], loose: [] })).toEqual([]);
  });

  describe("with an organisation node", () => {
    const PENDING: HeatmapCell[] = [{ week: "2026-10-05", health: null, pending: 1 }];
    const divisions = () => [
      node("ga", "Gather", "division", [node("ip", "IP Lab", "domain")]),
      node("cu", "Culture", "division", [node("at", "Atlas", "domain")]),
    ];

    it("puts the organisation's own row first, then a group per division under it", () => {
      const organisation = { ...node("tn", "The New Normal", "organisation", divisions()), cells: PENDING };
      const groups = heatmapGroups({ roots: [organisation], loose: [] });
      expect(groups.map((g) => [g.label, g.head?.name ?? null, g.rows.map((r) => r.name)])).toEqual([
        ["The New Normal", "The New Normal", []],
        ["Gather", "Gather", ["IP Lab"]],
        ["Culture", "Culture", ["Atlas"]],
      ]);
    });

    it("leaves the organisation out for a viewer who doesn't cover it, and still groups their divisions", () => {
      const organisation = node("tn", "The New Normal", "organisation", divisions(), false);
      expect(rows({ roots: [organisation], loose: [] })).toEqual([
        ["Gather", [["IP Lab", 0, true]]],
        ["Culture", [["Atlas", 0, true]]],
      ]);
    });

    it("keeps unplaced domains beside it in Other", () => {
      const organisation = { ...node("tn", "The New Normal", "organisation", divisions()), cells: PENDING };
      const groups = heatmapGroups({ roots: [organisation, node("lg", "Legacy", "domain")], loose: [] });
      expect(groups.map((g) => g.label)).toEqual(["The New Normal", "Gather", "Culture", null]);
      expect(groups[3].rows.map((r) => r.name)).toEqual(["Legacy"]);
    });
  });
});
