import { describe, expect, it } from "vitest";
import { buildTree, type TeamRow } from "@/lib/admin/tree";
import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import {
  type CanvasPerson,
  canvasPeopleOf,
  itemAt,
  type LayoutItem,
  layoutStructure,
  NO_TEAM_ID,
  personNodeId,
  stackId,
  UNPLACED_ID,
} from "./canvas-layout";
import type { StructureRow } from "./counts";

function node(id: string, kind: TeamRow["kind"], parent_id: string | null, sort_order = 0): StructureRow {
  return {
    id,
    name: id,
    parent_id,
    kind,
    domain_type: null,
    division_type: null,
    code: null,
    sort_order,
    note: null,
    leader_title: null,
    archived_at: null,
    members: 0,
    leads: 0,
  };
}

// Gather holds IP Lab (two teams) and two domains without teams; Culture three domains without
// teams; Legacy is unplaced, with a team.
const ROWS: StructureRow[] = [
  node("gather", "division", null, 0),
  node("culture", "division", null, 1),
  node("legacy", "domain", null, 2),
  node("ipLab", "domain", "gather", 0),
  node("barbeques", "domain", "gather", 1),
  node("dinners", "domain", "gather", 2),
  node("ip1", "team", "ipLab", 0),
  node("ip2", "team", "ipLab", 1),
  node("flag", "domain", "culture", 0),
  node("atlas", "domain", "culture", 1),
  node("archive", "domain", "culture", 2),
  node("legacyA", "team", "legacy", 0),
];

const person = (id: string, teamId: string | null, role = "member"): CanvasPerson => ({
  id,
  name: id,
  role,
  teamId,
  editable: true,
});

const at = (items: readonly LayoutItem[], id: string) => {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
};
const overlaps = (a: LayoutItem, b: LayoutItem) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Every pair of boxes apart, except a person inside their own stack.
function expectNoOverlaps(items: readonly LayoutItem[]) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [a, b] = [items[i], items[j]];
      const nested = (a.type === "person" && a.stack === b.id) || (b.type === "person" && b.stack === a.id);
      if (!nested) expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

describe("layoutStructure", () => {
  const { items, edges } = layoutStructure(buildTree(ROWS), null);

  it("draws every active node once, plus the Unplaced root", () => {
    expect(items.map((i) => i.id).sort()).toEqual([...ROWS.map((r) => r.id), UNPLACED_ID].sort());
  });

  it("never overlaps two boxes", () => {
    expectNoOverlaps(items);
  });

  it("puts the divisions side by side at the top, then Unplaced", () => {
    const [gather, culture, unplaced] = [at(items, "gather"), at(items, "culture"), at(items, UNPLACED_ID)];
    expect([gather.y, culture.y, unplaced.y]).toEqual([0, 0, 0]);
    expect(gather.x).toBeLessThan(culture.x);
    expect(culture.x).toBeLessThan(unplaced.x);
  });

  it("lists children without children of their own in a column under the node, joined by its trunk", () => {
    const culture = at(items, "culture");
    const column = ["flag", "atlas", "archive"].map((id) => at(items, id));
    for (const box of column) expect(box.x).toBeGreaterThan(culture.x);
    expect(new Set(column.map((b) => b.x)).size).toBe(1);
    expect(column.map((b) => b.y)).toEqual([...column.map((b) => b.y)].sort((a, b) => a - b));
    expect(edges.filter((e) => e.source === "culture").map((e) => [e.target, e.kind])).toEqual([
      ["flag", "column"],
      ["atlas", "column"],
      ["archive", "column"],
    ]);
  });

  it("puts children side by side, in their order, when any of them has children", () => {
    const [ipLab, barbeques, dinners] = [at(items, "ipLab"), at(items, "barbeques"), at(items, "dinners")];
    expect(ipLab.y).toBe(barbeques.y);
    expect(ipLab.x + ipLab.width).toBeLessThan(barbeques.x);
    expect(barbeques.x + barbeques.width).toBeLessThan(dinners.x);
    expect(edges.filter((e) => e.source === "gather").map((e) => [e.target, e.kind])).toEqual([
      ["ipLab", "row"],
      ["barbeques", "row"],
      ["dinners", "row"],
    ]);
    // IP Lab's teams in its own column.
    expect(at(items, "ip1").y).toBeGreaterThan(ipLab.y + ipLab.height);
    expect(edges.find((e) => e.target === "ip2")).toMatchObject({ source: "ipLab", kind: "column" });
  });

  it("hangs unplaced domains under Unplaced", () => {
    expect(edges.find((e) => e.target === "legacy")).toMatchObject({ source: UNPLACED_ID });
    expect(at(items, "legacyA").y).toBeGreaterThan(at(items, "legacy").y);
  });

  it("leaves archived nodes off", () => {
    const { items: shown } = layoutStructure(buildTree([...ROWS, { ...node("old", "team", "ipLab", 2), archived_at: "2026-01-01" }]), null);
    expect(shown.some((i) => i.id === "old")).toBe(false);
  });

  it("roots everything at the organisation node when there is one (since 0006)", () => {
    const rows = [node("org", "organisation", null), ...ROWS.map((r) => (r.kind === "division" ? { ...r, parent_id: "org" } : r))];
    const { items: withOrg, edges: orgEdges } = layoutStructure(buildTree(rows), null);
    const [org, gather, culture] = [at(withOrg, "org"), at(withOrg, "gather"), at(withOrg, "culture")];
    expect(gather.y).toBeGreaterThan(org.y + org.height);
    expect(org.x).toBeGreaterThan(gather.x);
    expect(org.x).toBeLessThan(culture.x);
    expect(orgEdges.filter((e) => e.source === "org").map((e) => [e.target, e.kind])).toEqual([
      ["gather", "row"],
      ["culture", "row"],
    ]);
    expectNoOverlaps(withOrg);
  });

  describe("with people", () => {
    const people = [
      person("zed", "ip1"),
      person("amy", "ip1", "leader"),
      person("nora", "gather", "leader"),
      person("ola", null),
      person("hana", "ip1", "hq"),
    ];
    const { items: shown, edges: shownEdges } = layoutStructure(buildTree(ROWS), people);

    it("stacks each node's people beside it: Master Admins, then leaders, then by name", () => {
      const stack = at(shown, stackId("ip1"));
      const ip1 = at(shown, "ip1");
      expect(stack.x).toBeGreaterThan(ip1.x + ip1.width);
      expect(stack.y).toBe(ip1.y);
      const names = shown.filter((i) => i.type === "person" && i.stack === stack.id).sort((a, b) => a.y - b.y).map((i) => i.id);
      expect(names).toEqual(["hana", "amy", "zed"].map(personNodeId));
      expect(shownEdges.find((e) => e.target === stack.id)).toMatchObject({ source: "ip1", kind: "people" });
    });

    it("gives a division's own people a stack too", () => {
      expect(at(shown, stackId("gather"))).toMatchObject({ type: "stack", count: 1 });
    });

    it("gathers people with no team in the No team pool, last", () => {
      const pool = at(shown, NO_TEAM_ID);
      expect(pool).toMatchObject({ type: "stack", teamId: null, count: 1 });
      expect(pool.x).toBeGreaterThan(at(shown, UNPLACED_ID).x);
    });

    it("still never overlaps two boxes, with every person inside their stack", () => {
      expectNoOverlaps(shown);
      for (const p of shown.filter((i) => i.type === "person")) {
        const stack = at(shown, p.type === "person" ? p.stack : "");
        expect(p.x >= stack.x && p.y >= stack.y && p.x + p.width <= stack.x + stack.width && p.y + p.height <= stack.y + stack.height).toBe(true);
      }
    });

    it("shows an empty pool while people are shown, so there's somewhere to drop them", () => {
      const { items: none } = layoutStructure(buildTree(ROWS), [person("amy", "ip1")]);
      expect(at(none, NO_TEAM_ID)).toMatchObject({ count: 0 });
    });
  });
});

describe("itemAt", () => {
  const { items } = layoutStructure(buildTree(ROWS), [person("amy", "ip1")]);

  it("finds the box under a point, the smallest when they nest (a person in their stack)", () => {
    const amy = at(items, personNodeId("amy"));
    expect(itemAt(items, { x: amy.x + 5, y: amy.y + 5 })?.id).toBe(personNodeId("amy"));
    const stack = at(items, stackId("ip1"));
    expect(itemAt(items, { x: stack.x + 2, y: stack.y + 2 })?.id).toBe(stackId("ip1"));
  });

  it("skips the box being dragged, and finds nothing on empty canvas", () => {
    const ip1 = at(items, "ip1");
    expect(itemAt(items, { x: ip1.x + 5, y: ip1.y + 5 }, "ip1")).toBeNull();
    expect(itemAt(items, { x: -500, y: -500 })).toBeNull();
  });
});

describe("canvasPeopleOf", () => {
  const member = (id: string, role: string, team_id: string | null): MemberRow => ({
    id,
    name: id,
    role,
    team_id,
    auth_user_id: null,
    login_given_by: null,
    login_given_at: null,
    login_email_changed_by: null,
    login_email_changed_at: null,
    removed_at: null,
  });
  const rows = [node("org", "organisation", null), ...ROWS, { ...node("old", "team", "ipLab", 3), archived_at: "2026-10-01" }];
  const editable = (members: MemberRow[], admin = "m-admin") =>
    Object.fromEntries(canvasPeopleOf(members, rows, admin).map((p) => [p.id, p.editable]));

  it("lets the admin move ordinary members and leaders, in a node or in no team", () => {
    expect(editable([member("amy", "member", "ip1"), member("bo", "leader", "gather"), member("ola", "member", null)])).toEqual({
      amy: true,
      bo: true,
      ola: true,
    });
  });

  it("locks Master Admins, the admin's own row and whoever sits in the organisation", () => {
    expect(editable([member("hq", "hq", "ip1"), member("m-admin", "leader", "ip1"), member("eli", "leader", "org")])).toEqual({
      hq: false,
      "m-admin": false,
      eli: false,
    });
  });

  it("leaves out people in an archived node, who have nowhere to show", () => {
    expect(canvasPeopleOf([member("gone", "member", "old"), member("amy", "member", "ip1")], rows, "x").map((p) => p.id)).toEqual(["amy"]);
  });

  // Removed from Module One (0009). The database also takes their team; one who keeps it here
  // checks that the chart doesn't rely on that.
  const removed = (m: MemberRow): MemberRow => ({ ...m, removed_at: "2026-10-09T03:00:00Z" });

  it("leaves out people removed from Module One, with a team or without", () => {
    const members = [
      removed(member("rae", "member", null)),
      removed(member("sam", "leader", "ip1")),
      member("amy", "member", "ip1"),
      member("ola", "member", null),
    ];
    expect(canvasPeopleOf(members, rows, "x").map((p) => p.id)).toEqual(["amy", "ola"]);
  });

  it("keeps removed people out of the No team pool, which is sized for those left", () => {
    const left = [member("ola", "member", null)];
    const people = canvasPeopleOf([...left, removed(member("rae", "member", null)), removed(member("sam", "leader", "ip1"))], ROWS, "x");
    const { items } = layoutStructure(buildTree(ROWS), people);
    expect(at(items, NO_TEAM_ID)).toMatchObject({ type: "stack", teamId: null, count: 1 });
    expect(items.filter((i) => i.type === "person").map((i) => i.id)).toEqual([personNodeId("ola")]);
    expect(items.some((i) => i.id === stackId("ip1"))).toBe(false);
    // Laid out exactly as if they'd never been there.
    expect(items).toEqual(layoutStructure(buildTree(ROWS), canvasPeopleOf(left, ROWS, "x")).items);
    // With only removed people in no team, the pool is still there, empty, to drop people on.
    const { items: none } = layoutStructure(buildTree(ROWS), canvasPeopleOf([removed(member("rae", "member", null))], ROWS, "x"));
    expect(at(none, NO_TEAM_ID)).toMatchObject({ count: 0 });
    expect(none.some((i) => i.type === "person")).toBe(false);
  });
});
