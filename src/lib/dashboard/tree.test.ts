import { describe, expect, it } from "vitest";
import { placeTeams, type TeamNode, teamContext } from "./tree";

const node = (id: string, name: string, kind: string | null, parent_id: string | null, division: string | null = null) =>
  ({ id, name, kind, parent_id, division, sort_order: null, archived_at: null }) satisfies TeamNode;

const TREE = [
  node("ga", "Gather", "division", null),
  node("ip", "IP", "domain", "ga"),
  node("ip1", "IP.1", "team", "ip"),
];

describe("teamContext", () => {
  it("names the division and domain above a team", () => {
    expect(teamContext(TREE, "ip1")).toEqual(["Gather", "IP"]);
    expect(teamContext(TREE, "ip")).toEqual(["Gather"]);
    expect(teamContext(TREE, "ga")).toEqual([]);
  });

  it("uses the free-text division before the team tree", () => {
    expect(teamContext([node("t", "Atlas", null, null, "Culture")], "t")).toEqual(["Culture"]);
    expect(teamContext([node("t", "Atlas", null, null)], "t")).toEqual([]);
  });

  it("is empty for a team the viewer can't see", () => {
    expect(teamContext(TREE, "gone")).toEqual([]);
  });
});

describe("placeTeams", () => {
  it("stops at a cycle instead of looping", () => {
    const loop = [node("a", "A", "domain", "b"), node("b", "B", "team", "a")];
    const placed = placeTeams(loop);
    expect(placed.get("a")).toMatchObject({ group: null, depth: 1 });
    expect(placed.get("b")).toMatchObject({ group: null, depth: 1 });
  });
});
