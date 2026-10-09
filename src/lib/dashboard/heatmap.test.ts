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

  it("returns no groups for an empty org", () => {
    expect(heatmapGroups({ roots: [], loose: [] })).toEqual([]);
  });
});
