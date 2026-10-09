import { describe, expect, it } from "vitest";
import {
  activeChildren,
  applyMove,
  breadcrumb,
  buildTree,
  canDrop,
  compareSiblings,
  dropToMove,
  moveAnnouncement,
  moveOptions,
  type TeamMove,
  type TeamRow,
  typeLabel,
} from "./tree";
import { TEAM_KINDS } from "./validate";

const ARCHIVED = "2026-09-01T00:00:00Z";

function node(id: string, kind: TeamRow["kind"], parent_id: string | null, sort_order: number, extra: Partial<TeamRow> = {}): TeamRow {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    parent_id,
    kind,
    domain_type: null,
    division_type: null,
    code: null,
    sort_order,
    note: null,
    archived_at: null,
    ...extra,
  };
}

// The top level mixes divisions and unplaced domains, as the database does: Gather, Culture,
// an unplaced Legacy between them and HQ, then another unplaced domain, Zeta.
const ROWS: TeamRow[] = [
  node("gather", "division", null, 0, { division_type: "strategy" }),
  node("culture", "division", null, 1, { division_type: "strategy", note: "The three work as a cycle." }),
  node("legacy", "domain", null, 2),
  node("hq", "division", null, 3, { division_type: "support_development" }),
  node("zeta", "domain", null, 4),
  node("oldDivision", "division", null, 2, { archived_at: ARCHIVED }),
  node("oldDomain", "domain", "oldDivision", 0, { archived_at: ARCHIVED }),

  node("ipLab", "domain", "gather", 0, { domain_type: "lab", code: "IP.X" }),
  node("barbeques", "domain", "gather", 1, { domain_type: "ip", code: "BQ.X" }),
  node("dinners", "domain", "gather", 2, { domain_type: "ip", code: "DN.X" }),
  node("bygone", "domain", "gather", 1, { archived_at: ARCHIVED }),
  node("atlas", "domain", "culture", 0, { domain_type: "development", code: "AT.X" }),
  node("flagLab", "domain", "culture", 1, { domain_type: "lab" }),

  node("ip1", "team", "ipLab", 0, { code: "IP.1" }),
  node("ip2", "team", "ipLab", 1, { code: "IP.2" }),
  node("ip3", "team", "ipLab", 0, { archived_at: ARCHIVED }),
  node("legacyTeam", "team", "legacy", 0),
];

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
const childIds = (rows: readonly TeamRow[], parentId: string | null) => ids(activeChildren(rows, parentId));

describe("compareSiblings", () => {
  it("orders by sort_order, then name, then id", () => {
    const rows = [
      node("b2", "domain", null, 1, { name: "Same" }),
      node("b1", "domain", null, 1, { name: "Same" }),
      node("a", "domain", null, 1, { name: "Apple" }),
      node("z", "domain", null, 0, { name: "Zebra" }),
    ];
    expect(ids([...rows].sort(compareSiblings))).toEqual(["z", "a", "b1", "b2"]);
  });

  it("puts the name before the id when two siblings share a sort_order (after a restore)", () => {
    // By id, "a" and "b" would come first; by name, "Apple" (id "c") does.
    const rows = [
      node("a", "domain", null, 1, { name: "Same" }),
      node("b", "domain", null, 1, { name: "Same" }),
      node("c", "domain", null, 1, { name: "Apple" }),
    ];
    expect(ids([...rows].sort(compareSiblings))).toEqual(["c", "a", "b"]);
  });
});

describe("buildTree", () => {
  const tree = buildTree(ROWS);

  it("lists active divisions in order, each with its active domains and their active teams", () => {
    expect(tree.divisions.map((d) => d.row.id)).toEqual(["gather", "culture", "hq"]);
    expect(tree.divisions[0].domains.map((d) => d.row.id)).toEqual(["ipLab", "barbeques", "dinners"]);
    expect(ids(tree.divisions[0].domains[0].teams)).toEqual(["ip1", "ip2"]);
    expect(tree.divisions[1].domains.map((d) => d.row.id)).toEqual(["atlas", "flagLab"]);
    expect(tree.divisions[2].domains).toEqual([]);
  });

  it("lists top-level domains as unplaced, with their teams", () => {
    expect(tree.unplaced.map((d) => d.row.id)).toEqual(["legacy", "zeta"]);
    expect(ids(tree.unplaced[0].teams)).toEqual(["legacyTeam"]);
    expect(tree.unplaced[1].teams).toEqual([]);
  });

  it("lists every archived node apart, parents before children, and none in the tree", () => {
    // Depth-first: IP Lab (sort 0) and its archived ip3 come before bygone (sort 1) in Gather.
    expect(ids(tree.archived)).toEqual(["ip3", "bygone", "oldDivision", "oldDomain"]);
    const shown = JSON.stringify([tree.divisions, tree.unplaced]);
    for (const id of ids(tree.archived)) expect(shown).not.toContain(`"${id}"`);
  });

  it("has no stray nodes when the tree follows the rules", () => {
    expect(tree.stray).toEqual([]);
  });

  it("lists active nodes it can't place as stray instead of dropping them", () => {
    const odd = [
      ...ROWS,
      node("orphan", "team", "missing", 0), // parent not among the rows
      node("underArchived", "team", "bygone", 0), // parent archived
      node("domainInDomain", "domain", "ipLab", 5), // wrong kind of parent
      node("teamAtTop", "team", null, 9),
      node("teamInDivision", "team", "hq", 0),
    ];
    const strays = buildTree(odd).stray;
    expect(ids(strays).sort()).toEqual(
      ["domainInDomain", "orphan", "teamAtTop", "teamInDivision", "underArchived"].sort(),
    );
  });

  it("keeps extra fields on the rows", () => {
    const counted = ROWS.map((r) => ({ ...r, members: r.id.length }));
    expect(buildTree(counted).divisions[0].domains[0].teams[0].members).toBe(3);
  });

  it("handles no rows", () => {
    expect(buildTree([])).toEqual({ divisions: [], unplaced: [], archived: [], stray: [] });
  });

  it("doesn't loop on a cycle", () => {
    const loop = [node("a", "domain", "b", 0), node("b", "domain", "a", 0)];
    expect(ids(buildTree(loop).stray).sort()).toEqual(["a", "b"]);
  });
});

describe("breadcrumb", () => {
  it("goes from the division down to the node", () => {
    expect(ids(breadcrumb("ip1", ROWS))).toEqual(["gather", "ipLab", "ip1"]);
    expect(ids(breadcrumb("atlas", ROWS))).toEqual(["culture", "atlas"]);
    expect(ids(breadcrumb("gather", ROWS))).toEqual(["gather"]);
    expect(ids(breadcrumb("legacyTeam", ROWS))).toEqual(["legacy", "legacyTeam"]);
    expect(ids(breadcrumb("oldDomain", ROWS))).toEqual(["oldDivision", "oldDomain"]);
  });

  it("is empty for an unknown id", () => {
    expect(breadcrumb("nope", ROWS)).toEqual([]);
  });

  it("stops at a parent it can't see, and on a cycle", () => {
    expect(ids(breadcrumb("x", [node("x", "team", "hidden", 0)]))).toEqual(["x"]);
    const loop = [node("a", "domain", "b", 0), node("b", "domain", "a", 0)];
    expect(ids(breadcrumb("a", loop))).toEqual(["b", "a"]);
  });

  it("works with just ids and parents", () => {
    expect(breadcrumb("t", [{ id: "d", parent_id: null }, { id: "t", parent_id: "d" }])).toEqual([
      { id: "d", parent_id: null },
      { id: "t", parent_id: "d" },
    ]);
  });
});

describe("canDrop", () => {
  it.each([
    ["division", null, true],
    ["division", "division", false],
    ["division", "domain", false],
    ["division", "team", false],
    ["domain", null, true],
    ["domain", "division", true],
    ["domain", "domain", false],
    ["domain", "team", false],
    ["team", null, false],
    ["team", "division", false],
    ["team", "domain", true],
    ["team", "team", false],
  ] as const)("%s into %s: %s", (kind, parent, allowed) => {
    expect(canDrop(kind, parent)).toBe(allowed);
  });

  it("covers every kind", () => {
    for (const kind of TEAM_KINDS) expect(typeof canDrop(kind, null)).toBe("boolean");
  });
});

describe("dropToMove", () => {
  it("within a list, takes the place of the node it's dropped on (like arrayMove)", () => {
    expect(dropToMove(ROWS, "ipLab", { type: "onto", id: "dinners" })).toEqual({
      teamId: "ipLab",
      parentId: "gather",
      index: 2,
    });
    expect(dropToMove(ROWS, "dinners", { type: "onto", id: "ipLab" })).toEqual({
      teamId: "dinners",
      parentId: "gather",
      index: 0,
    });
    expect(dropToMove(ROWS, "ip2", { type: "onto", id: "ip1" })).toEqual({
      teamId: "ip2",
      parentId: "ipLab",
      index: 0,
    });
  });

  it("from another list, goes just before the node it's dropped on", () => {
    expect(dropToMove(ROWS, "atlas", { type: "onto", id: "barbeques" })).toEqual({
      teamId: "atlas",
      parentId: "gather",
      index: 1,
    });
    expect(dropToMove(ROWS, "legacyTeam", { type: "onto", id: "ip2" })).toEqual({
      teamId: "legacyTeam",
      parentId: "ipLab",
      index: 1,
    });
  });

  it("onto a container, goes last", () => {
    expect(dropToMove(ROWS, "atlas", { type: "into", parentId: "gather" })).toEqual({
      teamId: "atlas",
      parentId: "gather",
      index: 3,
    });
    expect(dropToMove(ROWS, "ip1", { type: "into", parentId: "legacy" })).toEqual({
      teamId: "ip1",
      parentId: "legacy",
      index: 1,
    });
    expect(dropToMove(ROWS, "ip1", { type: "into", parentId: "zeta" })).toEqual({
      teamId: "ip1",
      parentId: "zeta",
      index: 0,
    });
    expect(dropToMove(ROWS, "ipLab", { type: "into", parentId: "gather" })).toEqual({
      teamId: "ipLab",
      parentId: "gather",
      index: 2,
    });
  });

  it("counts the whole top level, divisions and unplaced domains together", () => {
    // Top level now: gather 0, culture 1, legacy 2, hq 3, zeta 4.
    expect(dropToMove(ROWS, "zeta", { type: "onto", id: "legacy" })).toEqual({
      teamId: "zeta",
      parentId: null,
      index: 2,
    });
    expect(dropToMove(ROWS, "legacy", { type: "onto", id: "zeta" })).toEqual({
      teamId: "legacy",
      parentId: null,
      index: 4,
    });
    expect(dropToMove(ROWS, "hq", { type: "onto", id: "gather" })).toEqual({
      teamId: "hq",
      parentId: null,
      index: 0,
    });
    expect(dropToMove(ROWS, "gather", { type: "onto", id: "hq" })).toEqual({
      teamId: "gather",
      parentId: null,
      index: 3,
    });
    // A domain leaving its division for Unplaced goes after everything at the top.
    expect(dropToMove(ROWS, "atlas", { type: "into", parentId: null })).toEqual({
      teamId: "atlas",
      parentId: null,
      index: 5,
    });
    expect(dropToMove(ROWS, "atlas", { type: "onto", id: "legacy" })).toEqual({
      teamId: "atlas",
      parentId: null,
      index: 2,
    });
  });

  it.each([
    ["a team into a division", "ip1", { type: "into", parentId: "gather" }],
    ["a team to the top level", "ip1", { type: "into", parentId: null }],
    ["a team into a team", "ip1", { type: "into", parentId: "ip2" }],
    ["a domain into a domain", "atlas", { type: "into", parentId: "ipLab" }],
    ["a domain into a team", "atlas", { type: "into", parentId: "ip1" }],
    ["a division into a division", "hq", { type: "into", parentId: "gather" }],
    ["a division into a domain", "hq", { type: "into", parentId: "atlas" }],
    ["onto a node of another kind", "atlas", { type: "onto", id: "gather" }],
    ["a team onto a domain", "ip1", { type: "onto", id: "atlas" }],
    ["onto itself", "atlas", { type: "onto", id: "atlas" }],
    ["onto an archived node", "atlas", { type: "onto", id: "bygone" }],
    ["into an archived parent", "atlas", { type: "into", parentId: "oldDivision" }],
    ["into an unknown parent", "atlas", { type: "into", parentId: "missing" }],
    ["onto an unknown node", "atlas", { type: "onto", id: "missing" }],
  ] as const)("refuses %s", (_label, dragged, target) => {
    expect(dropToMove(ROWS, dragged, target)).toBeNull();
  });

  it("refuses dragging an archived or unknown node", () => {
    expect(dropToMove(ROWS, "bygone", { type: "into", parentId: "gather" })).toBeNull();
    expect(dropToMove(ROWS, "missing", { type: "into", parentId: "gather" })).toBeNull();
  });

  it("returns null for a drop that changes nothing", () => {
    expect(dropToMove(ROWS, "dinners", { type: "into", parentId: "gather" })).toBeNull();
    expect(dropToMove(ROWS, "zeta", { type: "into", parentId: null })).toBeNull();
    expect(dropToMove(ROWS, "ip2", { type: "into", parentId: "ipLab" })).toBeNull();
  });

  it("agrees with arrayMove for every drop within a list", () => {
    const list = ["ipLab", "barbeques", "dinners"];
    for (const [from, dragged] of list.entries()) {
      for (const [to, over] of list.entries()) {
        const move = dropToMove(ROWS, dragged, { type: "onto", id: over });
        if (from === to) {
          expect(move).toBeNull();
          continue;
        }
        const expected = [...list];
        expected.splice(to, 0, ...expected.splice(from, 1));
        expect(childIds(applyMove(ROWS, move!), "gather")).toEqual(expected);
      }
    }
  });

  it("agrees with the page's view of the top level for every drop among unplaced domains and divisions", () => {
    for (const shown of [["gather", "culture", "hq"], ["legacy", "zeta"]]) {
      for (const [from, dragged] of shown.entries()) {
        for (const [to, over] of shown.entries()) {
          if (from === to) continue;
          const move = dropToMove(ROWS, dragged, { type: "onto", id: over })!;
          const kind = ROWS.find((r) => r.id === dragged)!.kind;
          const expected = [...shown];
          expected.splice(to, 0, ...expected.splice(from, 1));
          const after = applyMove(ROWS, move);
          expect(ids(activeChildren(after, null).filter((r) => r.kind === kind))).toEqual(expected);
        }
      }
    }
  });
});

describe("applyMove", () => {
  const sortOrders = (rows: readonly TeamRow[], parentId: string | null) =>
    Object.fromEntries(rows.filter((r) => r.parent_id === parentId).map((r) => [r.id, r.sort_order]));

  it("renumbers the destination and closes the gap at the old parent, leaving archived siblings alone", () => {
    const after = applyMove(ROWS, { teamId: "barbeques", parentId: "culture", index: 1 });
    expect(sortOrders(after, "culture")).toEqual({ atlas: 0, barbeques: 1, flagLab: 2 });
    expect(sortOrders(after, "gather")).toEqual({ ipLab: 0, dinners: 1, bygone: 1 });
    expect(after.find((r) => r.id === "barbeques")?.parent_id).toBe("culture");
  });

  it("clamps an index past the end", () => {
    const after = applyMove(ROWS, { teamId: "ip1", parentId: "legacy", index: 99 });
    expect(sortOrders(after, "legacy")).toEqual({ legacyTeam: 0, ip1: 1 });
    expect(sortOrders(after, "ipLab")).toEqual({ ip2: 0, ip3: 0 });
  });

  it("reorders within one parent", () => {
    const after = applyMove(ROWS, { teamId: "dinners", parentId: "gather", index: 0 });
    expect(childIds(after, "gather")).toEqual(["dinners", "ipLab", "barbeques"]);
    expect(sortOrders(after, "gather")).toEqual({ dinners: 0, ipLab: 1, barbeques: 2, bygone: 1 });
  });

  it("puts a moved archived node after the active siblings", () => {
    const after = applyMove(ROWS, { teamId: "bygone", parentId: "culture", index: 0 });
    expect(sortOrders(after, "culture")).toEqual({ atlas: 0, flagLab: 1, bygone: 2 });
  });

  it("returns the rows unchanged for an unknown node, and never edits its input", () => {
    const before = structuredClone(ROWS);
    expect(applyMove(ROWS, { teamId: "missing", parentId: null, index: 0 })).toEqual(ROWS);
    applyMove(ROWS, { teamId: "ip1", parentId: "legacy", index: 0 });
    expect(ROWS).toEqual(before);
  });
});

describe("moveOptions", () => {
  it("offers a division the top level, with positions among the divisions only", () => {
    const options = moveOptions(ROWS, "hq");
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ parentId: null, label: "Top level", current: true });
    expect(options[0].positions).toEqual([
      { index: 0, label: "First", current: false },
      { index: 1, label: "After Gather", current: false },
      { index: 2, label: "After Culture", current: true },
    ]);
  });

  it("offers a domain every division, then Unplaced", () => {
    const options = moveOptions(ROWS, "barbeques");
    expect(options.map((o) => [o.label, o.current])).toEqual([
      ["Gather", true],
      ["Culture", false],
      ["Hq", false],
      ["Unplaced", false],
    ]);
    expect(options[0].positions.map((p) => [p.label, p.index, p.current])).toEqual([
      ["First", 0, false],
      ["After IpLab", 1, true],
      ["After Dinners", 2, false],
    ]);
    expect(options[2].positions).toEqual([{ index: 0, label: "First", current: false }]);
    // Unplaced positions count the whole top level: gather 0, culture 1, legacy 2, hq 3, zeta 4.
    expect(options[3].positions.map((p) => [p.label, p.index])).toEqual([
      ["First", 2],
      ["After Legacy", 3],
      ["After Zeta", 5],
    ]);
  });

  it("offers a team every active domain, in tree order", () => {
    expect(moveOptions(ROWS, "ip1").map((o) => o.label)).toEqual([
      "Gather › IpLab",
      "Gather › Barbeques",
      "Gather › Dinners",
      "Culture › Atlas",
      "Culture › FlagLab",
      "Unplaced › Legacy",
      "Unplaced › Zeta",
    ]);
  });

  it("puts the node where each position says", () => {
    for (const option of moveOptions(ROWS, "zeta")) {
      for (const position of option.positions) {
        const move: TeamMove = { teamId: "zeta", parentId: option.parentId, index: position.index };
        const after = applyMove(ROWS, move);
        const shown = activeChildren(after, option.parentId).filter((r) => r.kind === "domain");
        const at = shown.findIndex((r) => r.id === "zeta");
        if (position.label === "First") expect(at).toBe(0);
        else expect(shown[at - 1].name).toBe(position.label.replace("After ", ""));
      }
    }
  });

  it("offers nothing for an archived or unknown node", () => {
    expect(moveOptions(ROWS, "bygone")).toEqual([]);
    expect(moveOptions(ROWS, "missing")).toEqual([]);
  });
});

describe("moveAnnouncement", () => {
  it("says where the node went, counting from 1 among what's shown with it", () => {
    expect(moveAnnouncement(ROWS, { teamId: "atlas", parentId: "gather", index: 1 })).toBe(
      "Moved Atlas to Gather, position 2",
    );
    expect(moveAnnouncement(ROWS, { teamId: "hq", parentId: null, index: 0 })).toBe(
      "Moved Hq to the top level, position 1",
    );
    expect(moveAnnouncement(ROWS, { teamId: "atlas", parentId: null, index: 3 })).toBe(
      "Moved Atlas to Unplaced, position 2",
    );
    expect(moveAnnouncement(ROWS, { teamId: "missing", parentId: null, index: 0 })).toBe("");
  });
});

describe("typeLabel", () => {
  it.each([
    [{ kind: "domain", domain_type: "lab", division_type: null }, "Lab"],
    [{ kind: "domain", domain_type: "ip", division_type: null }, "IP"],
    [{ kind: "domain", domain_type: "development", division_type: null }, "Development domain"],
    [{ kind: "division", domain_type: null, division_type: "strategy" }, "Strategy division"],
    [{ kind: "division", domain_type: null, division_type: "support_development" }, "Support and development division"],
    [{ kind: "domain", domain_type: null, division_type: null }, null],
    [{ kind: "team", domain_type: null, division_type: null }, null],
  ] as const)("%o → %s", (row, label) => {
    expect(typeLabel(row)).toBe(label);
  });
});
