// Where everything goes on the Structure canvas: a top-down chart, worked out from the rows every
// time (nothing about positions is saved). The organisation node (migration 0006) is the root when
// there is one, divisions under it, their domains under them and teams under those; before 0006
// each division is a root. Domains outside every division hang under an "Unplaced" root beside
// them. With people shown, each node's people stack beside it, and people with no team gather in
// a "No team" pool at the end.
//
// When none of a node's children has children of its own (a domain's teams, a division of domains
// without teams), they go in an indented column under it, joined by a trunk on its left; otherwise
// they sit side by side under it, the node centred over them. Either way they keep their order.
// No two subtrees overlap: each is as wide as the wider of its own box (with its people) and what's
// under it.

import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import { asRole, isEditableMember } from "@/lib/admin/roles";
import type { TeamTree } from "@/lib/admin/tree";
import type { StructureRow } from "./counts";

export const NODE_W = 232;
export const NODE_H = 76;
export const PERSON_W = 196;
export const PERSON_H = 34;
const PERSON_GAP = 6;
const STACK_PAD = 8;
const STACK_HEAD = 26; // the stack's title ("3 people")
const STACK_W = PERSON_W + STACK_PAD * 2;
const SIDE_GAP = 24; // between a node and its people
const H_GAP = 28; // between subtrees side by side
const V_GAP = 64; // between a node and the row under it
const COLUMN_INDENT = 44; // a column sits this far right of its parent's left edge
const COLUMN_TOP = 28; // between a node and the column under it
const COLUMN_GAP = 14; // between boxes in a column
const ROOT_GAP = 72; // between roots

// Where the trunk of a column leaves its parent, from the parent's left edge.
export const TRUNK_X = 20;

export const UNPLACED_ID = "unplaced";
export const NO_TEAM_ID = "no-team";
export const stackId = (teamId: string) => `people:${teamId}`;
export const personNodeId = (memberId: string) => `person:${memberId}`;

// Someone on the canvas.
export type CanvasPerson = { id: string; name: string; role: string; teamId: string | null; editable: boolean };

// The people the chart shows (no team, or in an active node; never anyone removed from Module One)
// and whether this admin may move them: not Master Admins or themselves (RLS refuses those), nor
// whoever sits in the organisation (the project owner's to change).
export function canvasPeopleOf(
  members: readonly MemberRow[],
  rows: readonly StructureRow[],
  adminMemberId: string,
): CanvasPerson[] {
  const shown = new Set(rows.filter((r) => r.archived_at === null).map((r) => r.id));
  const organisation = rows.find((r) => r.kind === "organisation")?.id;
  return members
    .filter((m) => m.removed_at === null && (m.team_id === null || shown.has(m.team_id)))
    .map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      teamId: m.team_id,
      editable: m.team_id !== organisation && isEditableMember({ id: m.id, role: asRole(m.role) }, adminMemberId),
    }));
}

export type Box = { x: number; y: number; width: number; height: number };

export type LayoutItem =
  | ({ type: "node"; id: string; row: StructureRow } & Box)
  | ({ type: "unplaced"; id: typeof UNPLACED_ID } & Box)
  | ({ type: "stack"; id: string; teamId: string | null; count: number } & Box)
  | ({ type: "person"; id: string; person: CanvasPerson; stack: string } & Box);

// How an edge joins two boxes: parent to child below ("row"), parent's trunk to a child in its
// column ("column"), or a node to its people beside it ("people").
export type LayoutEdge = { id: string; source: string; target: string; kind: "row" | "column" | "people" };

export type Layout = { items: LayoutItem[]; edges: LayoutEdge[] };

type StackItem = Extract<LayoutItem, { type: "stack" }>;

// A subtree to place: its own box, its people beside it, and what hangs under it.
type Branch = {
  item: LayoutItem;
  stack: StackItem | null;
  leaves: Branch[]; // the children, in a column, when none of them has children
  nested: Branch[]; // otherwise the children, in a row
  width: number; // the subtree's, once measured
};

const stackHeight = (n: number) => STACK_HEAD + STACK_PAD * 2 + n * PERSON_H + Math.max(0, n - 1) * PERSON_GAP;

const stackItem = (teamId: string | null, count: number): StackItem => ({
  type: "stack",
  id: teamId === null ? NO_TEAM_ID : stackId(teamId),
  teamId,
  count,
  x: 0,
  y: 0,
  width: STACK_W,
  height: stackHeight(count),
});

// The box and its people side by side.
const blockWidth = (b: Branch) => b.item.width + (b.stack ? SIDE_GAP + b.stack.width : 0);
const blockHeight = (b: Branch) => Math.max(b.item.height, b.stack?.height ?? 0);

const rowWidth = (row: readonly Branch[]) => row.reduce((sum, c) => sum + c.width, 0) + H_GAP * Math.max(0, row.length - 1);
const columnWidth = (b: Branch) => (b.leaves.length > 0 ? COLUMN_INDENT + Math.max(...b.leaves.map(blockWidth)) : 0);

function measure(b: Branch): number {
  for (const child of [...b.leaves, ...b.nested]) measure(child);
  const column = columnWidth(b);
  const row = rowWidth(b.nested);
  const below = column > 0 && row > 0 ? column + H_GAP + row : column + row;
  b.width = Math.max(blockWidth(b), below);
  return b.width;
}

// Puts the subtree's left edge at x and its top at y. With a column, the node sits at the left, over
// its trunk; with only a row, it's centred over the row.
function place(b: Branch, x: number, y: number) {
  const column = columnWidth(b);
  b.item.x = column > 0 || b.nested.length === 0 ? x : x + (b.width - blockWidth(b)) / 2;
  b.item.y = y;
  if (b.stack) {
    b.stack.x = b.item.x + b.item.width + SIDE_GAP;
    b.stack.y = y;
  }
  let top = y + blockHeight(b) + COLUMN_TOP;
  for (const leaf of b.leaves) {
    place(leaf, x + COLUMN_INDENT, top);
    top += blockHeight(leaf) + COLUMN_GAP;
  }
  let left = column > 0 ? x + column + H_GAP : x + (b.width - rowWidth(b.nested)) / 2;
  for (const child of b.nested) {
    place(child, left, y + blockHeight(b) + V_GAP);
    left += child.width + H_GAP;
  }
}

// Leaders first, then by name: who's who in a stack.
export function comparePeople(a: CanvasPerson, b: CanvasPerson): number {
  const rank = (p: CanvasPerson) => (p.role === "hq" ? 0 : p.role === "leader" ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function layoutStructure(
  tree: TeamTree<StructureRow>,
  people: readonly CanvasPerson[] | null, // null: people hidden
): Layout {
  const byTeam = new Map<string | null, CanvasPerson[]>();
  for (const p of people ?? []) byTeam.set(p.teamId, [...(byTeam.get(p.teamId) ?? []), p]);
  for (const list of byTeam.values()) list.sort(comparePeople);

  const isLeaf = (b: Branch) => b.leaves.length + b.nested.length === 0;
  const branch = (item: LayoutItem, children: Branch[]): Branch => {
    const own = item.type === "node" ? byTeam.get(item.id) : undefined;
    return {
      item,
      stack: own && own.length > 0 ? stackItem(item.id, own.length) : null,
      leaves: children.every(isLeaf) ? children : [],
      nested: children.every(isLeaf) ? [] : children,
      width: 0,
    };
  };
  const nodeBranch = (row: StructureRow, children: Branch[]) =>
    branch({ type: "node", id: row.id, row, x: 0, y: 0, width: NODE_W, height: NODE_H }, children);
  const domainBranch = (domain: TeamTree<StructureRow>["unplaced"][number]) =>
    nodeBranch(
      domain.row,
      domain.teams.map((team) => nodeBranch(team, [])),
    );
  const divisions = tree.divisions.map((division) => nodeBranch(division.row, division.domains.map(domainBranch)));

  const roots: Branch[] = tree.organisation ? [nodeBranch(tree.organisation, divisions)] : divisions;
  roots.push(branch({ type: "unplaced", id: UNPLACED_ID, x: 0, y: 0, width: NODE_W, height: NODE_H }, tree.unplaced.map(domainBranch)));
  if (people !== null) roots.push(branch(stackItem(null, byTeam.get(null)?.length ?? 0), []));

  let left = 0;
  for (const root of roots) {
    measure(root);
    place(root, left, 0);
    left += root.width + ROOT_GAP;
  }

  const items: LayoutItem[] = [];
  const edges: LayoutEdge[] = [];
  const addPeople = (stack: StackItem) => {
    items.push(stack);
    (byTeam.get(stack.teamId) ?? []).forEach((person, i) =>
      items.push({
        type: "person",
        id: personNodeId(person.id),
        person,
        stack: stack.id,
        x: stack.x + STACK_PAD,
        y: stack.y + STACK_HEAD + STACK_PAD + i * (PERSON_H + PERSON_GAP),
        width: PERSON_W,
        height: PERSON_H,
      }),
    );
  };
  const walk = (b: Branch) => {
    if (b.item.type === "stack") addPeople(b.item);
    else items.push(b.item);
    if (b.stack) {
      addPeople(b.stack);
      edges.push({ id: `edge:${b.item.id}:${b.stack.id}`, source: b.item.id, target: b.stack.id, kind: "people" });
    }
    for (const [children, kind] of [[b.leaves, "column"], [b.nested, "row"]] as const) {
      for (const child of children) {
        edges.push({ id: `edge:${b.item.id}:${child.item.id}`, source: b.item.id, target: child.item.id, kind });
        walk(child);
      }
    }
  };
  roots.forEach(walk);
  return { items, edges };
}

// The item under a point, preferring the smallest (a person over their stack): what a drop there
// lands on. `skip` leaves out the item being dragged.
export function itemAt(items: readonly LayoutItem[], point: { x: number; y: number }, skip?: string): LayoutItem | null {
  let best: LayoutItem | null = null;
  for (const item of items) {
    if (item.id === skip) continue;
    const inside = point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height;
    if (inside && (best === null || item.width * item.height < best.width * best.height)) best = item;
  }
  return best;
}
