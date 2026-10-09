import { ReactFlow } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import { buildTree, type TeamRow } from "@/lib/admin/tree";
import { type CanvasPerson, layoutStructure } from "./canvas-layout";
import { flowNodes, NODE_TYPES, PERSON_HINT_ID } from "./canvas-nodes";
import type { StructureRow } from "./counts";
import { StructureCanvas } from "./structure-canvas";

function node(id: string, name: string, kind: TeamRow["kind"], parent_id: string | null, sort_order: number, extra: Partial<StructureRow> = {}): StructureRow {
  return {
    id,
    name,
    parent_id,
    kind,
    domain_type: null,
    division_type: null,
    code: null,
    sort_order,
    note: null,
    archived_at: null,
    members: 0,
    leads: 0,
    ...extra,
  };
}

const ROWS: StructureRow[] = [
  node("d-gather", "Gather", "division", null, 0, { division_type: "strategy", members: 1, leads: 1 }),
  node("ip-x", "IP Lab", "domain", "d-gather", 0, { domain_type: "lab", code: "IP.X" }),
  node("ip-1", "IP Lab 1", "team", "ip-x", 0, { code: "IP.1", members: 2, leads: 1 }),
  node("legacy", "Legacy", "domain", null, 1),
  node("old", "Old Lab", "domain", "d-gather", 1, { archived_at: "2026-10-01T02:00:00Z" }),
];

const fail = vi.fn(async () => ({ ok: false as const, error: "no" }));
const ACTIONS = { moveNode: fail, createNode: fail, updateNode: fail, archiveNode: fail, restoreNode: fail };
const TEAM_ACTIONS = {
  addMember: fail,
  createMember: fail,
  giveLogin: fail,
  resendInvite: fail,
  removeFromTeam: fail,
  setRole: fail,
  addLead: fail,
  removeLead: fail,
};
const member = (id: string, name: string, role: string, team_id: string | null): MemberRow => ({
  id,
  name,
  role,
  team_id,
  auth_user_id: null,
  login_given_by: null,
  login_given_at: null,
});

const render = (rows = ROWS) =>
  renderToStaticMarkup(
    <StructureCanvas
      rows={rows}
      members={[member("m-ana", "Ana Lee", "leader", "ip-1"), member("m-hana", "Hana Lim", "hq", null)]}
      leads={[]}
      grants={[]}
      adminMemberId="m-hana"
      actions={ACTIONS}
      teamActions={TEAM_ACTIONS}
    />,
  );
// The boxes as the canvas draws them. (The page itself draws them in the browser: its flow's store
// lives in an outer provider, which the server doesn't fill.)
const chart = (rows = ROWS, people: CanvasPerson[] | null = null) =>
  renderToStaticMarkup(
    <ReactFlow nodes={flowNodes(layoutStructure(buildTree(rows), people).items, { dragged: null, selectedId: null })} edges={[]} nodeTypes={NODE_TYPES} />,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
const boxes = (html: string) => [...html.matchAll(/class="react-flow__node[^"]*"[^>]*data-id="([^"]+)"/g)].map((m) => m[1]);

describe("the chart's boxes", () => {
  const html = chart();

  it("draws a box for every active node, and Unplaced", () => {
    expect(boxes(html).sort()).toEqual(["d-gather", "ip-1", "ip-x", "legacy", "unplaced"].sort());
  });

  it("shows each box's kind, type, code and counts", () => {
    expect(text(html)).toContain("Gather Division · Strategy division 1 person · 1 lead");
    expect(text(html)).toContain("IP Lab Domain · Lab · IP.X 0 people");
    expect(text(html)).toContain("IP Lab 1 Team · IP.1 2 people · 1 lead");
  });

  it("gives every box a menu and an add button for what it holds, and teams no add button", () => {
    for (const name of ["Gather", "IP Lab", "IP Lab 1", "Legacy"]) expect(html).toContain(`aria-label="More for ${name}"`);
    expect(html).toContain('aria-label="Add a domain to Gather"');
    expect(html).toContain('aria-label="Add a team to IP Lab"');
    expect(html).not.toContain('aria-label="Add a team to IP Lab 1"');
    expect(html).toContain('aria-label="Add an unplaced domain"');
  });

  it("never shows a role on the boxes", () => {
    expect(text(html)).not.toMatch(/Master Admin|Leader\b/);
  });

  it("puts the organisation node at the top, and never lets it be dragged (since 0006)", () => {
    const rows = [node("org", "The New Normal", "organisation", null, 0, { members: 1 }), ...ROWS.map((r) => (r.kind === "division" ? { ...r, parent_id: "org" } : r))];
    const out = chart(rows);
    expect(boxes(out)).toContain("org");
    expect(text(out)).toContain("The New Normal Organisation 1 person");
    expect(out).toContain('aria-label="Add a division to The New Normal"');
    const org = flowNodes(layoutStructure(buildTree(rows), null).items, { dragged: null, selectedId: null }).find((n) => n.id === "org");
    expect(org?.draggable).toBe(false);
  });

  it("shows people beside their box, locking those the admin can't move", () => {
    const out = chart(ROWS, [
      { id: "m-ana", name: "Ana Lee", role: "leader", teamId: "ip-1", editable: true },
      { id: "m-hana", name: "Hana Lim", role: "hq", teamId: null, editable: false },
    ]);
    expect(text(out)).toMatch(/1 person .*Ana Lee Leader/);
    expect(text(out)).toMatch(/No team · 1 .*Hana Lim Master Admin/);
    expect(out).toContain('title="Master Admins, your own row and the organisation&#x27;s people can&#x27;t be moved here."');
  });
});

describe("flowNodes", () => {
  const people: CanvasPerson[] = [
    { id: "m-ana", name: "Ana Lee", role: "leader", teamId: "ip-1", editable: true },
    { id: "m-hana", name: "Hana Lim", role: "hq", teamId: null, editable: false },
  ];
  const nodes = (dragged: { id: string; position: { x: number; y: number } } | null = null) =>
    flowNodes(layoutStructure(buildTree(ROWS), people).items, { dragged, selectedId: null });
  const byId = (id: string, list = nodes()) => list.find((n) => n.id === id)!;

  it("lets only people the admin may move be dragged, and never Unplaced or a stack", () => {
    expect(byId("person:m-ana").draggable).toBe(true);
    expect(byId("person:m-hana").draggable).toBe(false);
    expect(byId("unplaced").draggable).toBe(false);
    for (const stack of nodes().filter((n) => n.type === "stack")) expect(stack.draggable).toBe(false);
  });

  it("names people with their role and whether they're locked, and describes what to do with them", () => {
    expect(byId("person:m-ana").ariaLabel).toBe("Ana Lee, leader");
    expect(byId("person:m-hana").ariaLabel).toBe("Hana Lim, Master Admin, can't be moved here");
    expect(byId("person:m-ana").domAttributes).toEqual({ "aria-describedby": PERSON_HINT_ID });
  });

  it("keeps Unplaced's + clickable but not the box itself a tab stop", () => {
    expect(byId("unplaced")).toMatchObject({ focusable: false, style: { pointerEvents: "all" } });
  });

  it("draws the box being dragged above the others, where the pointer has it", () => {
    const dragged = byId("ip-x", nodes({ id: "ip-x", position: { x: 999, y: 5 } }));
    expect(dragged).toMatchObject({ zIndex: 1000, position: { x: 999, y: 5 } });
    expect(byId("ip-1").zIndex).toBe(0);
  });
});

describe("StructureCanvas", () => {
  const html = render();

  it("offers adding a division and showing people, and lists archived nodes apart", () => {
    expect(text(html)).toContain("Add a division");
    expect(text(html)).toContain("Show people");
    expect(html).not.toContain("aria-pressed");
    expect(text(html)).toContain("Old Lab");
    expect(text(html)).toContain("Was in Gather");
  });

  it("says an archived division or organisation was at the top level, and a domain in Unplaced", () => {
    const archived = text(
      render([
        ...ROWS,
        node("gone-org", "Old Org", "organisation", null, 9, { archived_at: "2026-10-03T02:00:00Z" }),
        node("gone-div", "Old Division", "division", null, 9, { archived_at: "2026-10-03T02:00:00Z" }),
        node("gone-dom", "Old Domain", "domain", null, 9, { archived_at: "2026-10-03T02:00:00Z" }),
      ]),
    );
    expect(archived).toContain("Old Org Organisation Was in the top level.");
    expect(archived).toContain("Old Division Division Was in the top level.");
    expect(archived).toContain("Old Domain Domain Was in Unplaced.");
  });

  it("lists nodes the chart can't place, with Move to…", () => {
    const out = render([...ROWS, node("lost", "Lost Team", "team", "d-gather", 3)]);
    expect(text(out)).toContain("Not in the tree");
    expect(out).toMatch(/<span class="sr-only">Lost Team: <\/span>Move to…/);
  });
});
