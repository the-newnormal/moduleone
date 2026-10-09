import { describe, expect, it, vi } from "vitest";
import { buildTree, type TeamRow } from "@/lib/admin/tree";
import { type PlacePlan, placeAction, planDrop } from "./canvas-drop";
import { type CanvasPerson, type LayoutItem, layoutStructure, NO_TEAM_ID, personNodeId, stackId, UNPLACED_ID } from "./canvas-layout";
import type { StructureRow } from "./counts";

function node(id: string, kind: TeamRow["kind"], parent_id: string | null, sort_order = 0, archived_at: string | null = null): StructureRow {
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
    archived_at,
    members: 0,
    leads: 0,
  };
}

const ROWS: StructureRow[] = [
  node("gather", "division", null, 0),
  node("culture", "division", null, 1),
  node("legacy", "domain", null, 2),
  node("ipLab", "domain", "gather", 0),
  node("barbeques", "domain", "gather", 1),
  node("atlas", "domain", "culture", 0),
  node("ip1", "team", "ipLab", 0),
  node("ip2", "team", "ipLab", 1),
];

const person = (id: string, teamId: string | null, role = "member"): CanvasPerson => ({ id, name: id, role, teamId, editable: true });
const PEOPLE = [person("amy", "ip1"), person("bo", "gather", "leader"), person("ola", null)];
const { items } = layoutStructure(buildTree(ROWS), PEOPLE);
const item = (id: string): LayoutItem => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const plan = (dragged: Parameters<typeof planDrop>[2], target: string | null, rows = ROWS) =>
  planDrop(rows, items, dragged, target === null ? null : item(target));
const nodeDrag = (id: string) => ({ type: "node" as const, id });
const personDrag = (id: string) => ({ type: "person" as const, person: PEOPLE.find((p) => p.id === id)! });

describe("planDrop for a box", () => {
  it("moves a team into another domain, last there", () => {
    expect(plan(nodeDrag("ip2"), "barbeques")).toEqual({
      type: "move",
      move: { teamId: "ip2", parentId: "barbeques", index: 0 },
      label: "Move Ip2 to Barbeques, position 1",
    });
  });

  it("moves a domain into another division, or out to Unplaced", () => {
    expect(plan(nodeDrag("barbeques"), "culture")).toMatchObject({ type: "move", move: { teamId: "barbeques", parentId: "culture", index: 1 } });
    expect(plan(nodeDrag("barbeques"), UNPLACED_ID)).toMatchObject({ type: "move", move: { teamId: "barbeques", parentId: null } });
  });

  it("puts a box in another's place when dropped on one of its own kind", () => {
    expect(plan(nodeDrag("ip2"), "ip1")).toMatchObject({ type: "move", move: { teamId: "ip2", parentId: "ipLab", index: 0 } });
    expect(plan(nodeDrag("culture"), "gather")).toMatchObject({ type: "move", move: { teamId: "culture", parentId: null, index: 0 } });
    expect(plan(nodeDrag("atlas"), "barbeques")).toMatchObject({ type: "move", move: { teamId: "atlas", parentId: "gather", index: 1 } });
  });

  it("drops onto a box's people as onto the box", () => {
    expect(plan(nodeDrag("ip2"), stackId("gather"))).toEqual(plan(nodeDrag("ip2"), "gather"));
    expect(plan(nodeDrag("atlas"), personNodeId("bo"))).toMatchObject({ type: "move", move: { teamId: "atlas", parentId: "gather" } });
  });

  it("refuses what can't hold it, saying where it goes", () => {
    expect(plan(nodeDrag("ip1"), "gather")).toEqual({ type: "refuse", label: "A team goes in a domain." });
    expect(plan(nodeDrag("ipLab"), "ip1")).toEqual({ type: "refuse", label: "IpLab can't go inside itself." });
    expect(plan(nodeDrag("ipLab"), "atlas")).toMatchObject({ type: "move" }); // onto a domain: its place
    expect(plan(nodeDrag("gather"), "atlas")).toEqual({ type: "refuse", label: "Drop a division on another division to reorder them." });
    expect(plan(nodeDrag("ip1"), UNPLACED_ID)).toEqual({ type: "refuse", label: "A team goes in a domain." });
    expect(plan(nodeDrag("ip1"), NO_TEAM_ID)).toEqual({ type: "refuse", label: "Drag people here, not teams." });
  });

  it("refuses a box dropped on someone in the No team pool, as on the pool itself", () => {
    for (const id of ["barbeques", "ip1", "gather"]) {
      expect(plan(nodeDrag(id), personNodeId("ola"))).toEqual({ type: "refuse", label: "Drag people here, not teams." });
    }
  });

  it("does nothing on its own parent, itself, an unplaced domain on Unplaced, or empty canvas", () => {
    expect(plan(nodeDrag("ip2"), "ipLab")).toBeNull();
    expect(plan(nodeDrag("legacy"), UNPLACED_ID)).toBeNull();
    expect(plan(nodeDrag("ip2"), null)).toBeNull();
    expect(plan(nodeDrag("missing"), "ipLab")).toBeNull();
  });

  it("moves a division within the organisation once there is one (since 0006)", () => {
    const rows = [node("org", "organisation", null), ...ROWS.map((r) => (r.kind === "division" ? { ...r, parent_id: "org" } : r))];
    const withOrg = layoutStructure(buildTree(rows), null).items;
    const orgPlan = (dragged: string, target: string) =>
      planDrop(rows, withOrg, nodeDrag(dragged), withOrg.find((i) => i.id === target)!);
    expect(orgPlan("culture", "gather")).toMatchObject({ type: "move", move: { teamId: "culture", parentId: "org", index: 0 } });
    expect(orgPlan("gather", "org")).toBeNull(); // already there
    expect(orgPlan("ipLab", "org")).toEqual({ type: "refuse", label: "A domain goes in a division, or in Unplaced." });
  });
});

describe("planDrop for a person", () => {
  it("moves them into the division, domain or team they're dropped on, from where they are", () => {
    expect(plan(personDrag("amy"), "ip2")).toEqual({
      type: "place",
      memberId: "amy",
      from: "ip1",
      to: "ip2",
      leads: false,
      label: "Move amy to Ip2",
    });
    expect(plan(personDrag("amy"), "culture")).toMatchObject({ type: "place", to: "culture" });
    expect(plan(personDrag("ola"), personNodeId("bo"))).toMatchObject({ type: "place", from: null, to: "gather" });
  });

  it("takes them out of every team in the No team pool", () => {
    expect(plan(personDrag("amy"), NO_TEAM_ID)).toEqual({
      type: "place",
      memberId: "amy",
      from: "ip1",
      to: null,
      leads: false,
      label: "Take amy out of Ip1",
    });
    expect(plan(personDrag("ola"), NO_TEAM_ID)).toBeNull();
  });

  it("does nothing where they already are", () => {
    expect(plan(personDrag("amy"), "ip1")).toBeNull();
    expect(plan(personDrag("amy"), stackId("ip1"))).toBeNull();
  });

  it("refuses Unplaced and the organisation node (only the project owner places people there)", () => {
    expect(plan(personDrag("amy"), UNPLACED_ID)).toEqual({ type: "refuse", label: "People go in a division, domain or team." });
    const rows = [node("org", "organisation", null), ...ROWS.map((r) => (r.kind === "division" ? { ...r, parent_id: "org" } : r))];
    const withOrg = layoutStructure(buildTree(rows), PEOPLE).items;
    expect(planDrop(rows, withOrg, personDrag("amy"), withOrg.find((i) => i.id === "org")!)).toEqual({
      type: "refuse",
      label: "Only the project owner places people in the organisation.",
    });
  });

  it("says when a member put in a division will lead it, once there's an organisation (since 0006)", () => {
    const rows = [node("org", "organisation", null), ...ROWS.map((r) => (r.kind === "division" ? { ...r, parent_id: "org" } : r))];
    const withOrg = layoutStructure(buildTree(rows), PEOPLE).items;
    const at = (id: string) => withOrg.find((i) => i.id === id)!;
    expect(planDrop(rows, withOrg, personDrag("amy"), at("culture"))).toMatchObject({
      type: "place",
      leads: true,
      label: "Move amy to Culture, where they'll be a leader",
    });
    expect(planDrop(rows, withOrg, personDrag("bo"), at("culture"))).toMatchObject({ leads: false }); // a leader already
    expect(planDrop(rows, withOrg, personDrag("amy"), at("ip2"))).toMatchObject({ leads: false }); // a team
    expect(plan(personDrag("amy"), "culture")).toMatchObject({ leads: false }); // before 0006
  });

  it("never moves someone the admin can't (Master Admins, themselves, the organisation's people)", () => {
    const locked = { type: "person" as const, person: { ...PEOPLE[0], editable: false } };
    expect(plan(locked, "ip2")).toBeNull();
    expect(plan(locked, NO_TEAM_ID)).toBeNull();
  });
});

describe("placeAction", () => {
  const actions = () => ({ addMember: vi.fn(async () => ({ ok: true as const, value: null })), removeFromTeam: vi.fn(async () => ({ ok: true as const, value: null })) });
  const place = (from: string | null, to: string | null): PlacePlan => ({ type: "place", memberId: "amy", from, to, leads: false, label: "" });

  it("moves them into the node, from where the chart showed them", async () => {
    const fakes = actions();
    const { run, context } = placeAction(place("ip1", "ip2"), fakes);
    await run();
    expect(context).toBe("addMember");
    expect(fakes.addMember).toHaveBeenCalledWith("ip2", "amy", "ip1");
    await placeAction(place(null, "ip2"), fakes).run();
    expect(fakes.addMember).toHaveBeenLastCalledWith("ip2", "amy", null);
    expect(fakes.removeFromTeam).not.toHaveBeenCalled();
  });

  it("takes them out of their team for No team", async () => {
    const fakes = actions();
    const { run, context } = placeAction(place("ip1", null), fakes);
    await run();
    expect(context).toBe("removeFromTeam");
    expect(fakes.removeFromTeam).toHaveBeenCalledWith("ip1", "amy");
    expect(fakes.addMember).not.toHaveBeenCalled();
  });
});
