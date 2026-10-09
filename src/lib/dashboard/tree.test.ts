import { describe, expect, it } from "vitest";
import { subtree, type TeamNode, teamContext } from "./tree";

const node = (
  id: string,
  name: string,
  kind: TeamNode["kind"],
  parent_id: string | null,
  sort_order = 0,
  archived = false,
): TeamNode => ({ id, name, kind, parent_id, sort_order, archived_at: archived ? "2026-09-01T00:00:00Z" : null });

const TREE = [
  node("ga", "Gather", "division", null),
  node("ip", "IP Lab", "domain", "ga", 0),
  node("bq", "Barbeques", "domain", "ga", 1),
  node("ip2", "IP Lab 2", "team", "ip", 1),
  node("ip1", "IP Lab 1", "team", "ip", 0),
  node("old", "IP Lab 0", "team", "ip", 0, true),
];

describe("teamContext", () => {
  it("names the division and domain above a team", () => {
    expect(teamContext(TREE, "ip1")).toEqual(["Gather", "IP Lab"]);
    expect(teamContext(TREE, "ip")).toEqual(["Gather"]);
    expect(teamContext(TREE, "ga")).toEqual([]);
  });

  it("is empty for a team the viewer can't see, and stops at an ancestor they can't", () => {
    expect(teamContext(TREE, "gone")).toEqual([]);
    expect(teamContext([node("ip", "IP Lab", "domain", "ga"), node("ip1", "IP Lab 1", "team", "ip")], "ip1")).toEqual([
      "IP Lab",
    ]);
  });

  it("stops at a cycle instead of looping", () => {
    const loop = [node("a", "A", "domain", "b"), node("b", "B", "team", "a")];
    expect(teamContext(loop, "a")).toEqual(["B"]);
  });
});

describe("subtree", () => {
  it("lists the team and everything under it, archived teams too, each before its own teams", () => {
    expect(subtree(TREE, "ga").map((t) => t.id)).toEqual(["ga", "ip", "old", "ip1", "ip2", "bq"]);
    expect(subtree(TREE, "ip").map((t) => t.id)).toEqual(["ip", "old", "ip1", "ip2"]);
    expect(subtree(TREE, "ip1").map((t) => t.id)).toEqual(["ip1"]);
  });

  it("is empty for a team the viewer can't see", () => {
    expect(subtree(TREE, "gone")).toEqual([]);
  });

  it("stops at a cycle instead of looping", () => {
    const loop = [node("a", "A", "domain", "b"), node("b", "B", "team", "a")];
    expect(subtree(loop, "a").map((t) => t.id)).toEqual(["a", "b"]);
  });
});
