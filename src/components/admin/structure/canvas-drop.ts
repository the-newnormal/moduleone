// What dropping something on the Structure canvas does, apart from React: the plan for a dragged
// node or person and the item it's over (canvas-layout's itemAt). A node goes INTO a node that may
// hold it (a team into a domain, a domain into a division or Unplaced, a division into the
// organisation), last there; onto a node of its own kind it takes that node's place (dropToMove).
// A person goes into the division, domain or team they're dropped on, or out of every team in the
// "No team" pool. The database has the last word: it refuses what it must, in its own words.

import type { TeamActions } from "@/components/admin/team/types";
import { breadcrumb, canDrop, dropToMove, moveAnnouncement, type TeamMove } from "@/lib/admin/tree";
import type { TeamKind } from "@/lib/admin/validate";
import type { CanvasPerson, LayoutItem } from "./canvas-layout";
import type { StructureRow } from "./counts";

export type Dragged = { type: "node"; id: string } | { type: "person"; person: CanvasPerson };

export type DropPlan =
  // `label` says what the drop will do, while hovering ("Move Atlas to Gather, position 2").
  | { type: "move"; move: TeamMove; label: string }
  // `leads`: they'll lead where they go (since 0006, everyone placed in a division leads it).
  | { type: "place"; memberId: string; from: string | null; to: string | null; leads: boolean; label: string }
  | { type: "refuse"; label: string };

export type PlacePlan = Extract<DropPlan, { type: "place" }>;

const WHERE_IT_GOES: Record<TeamKind, string> = {
  organisation: "The organisation stays where it is.",
  division: "Drop a division on another division to reorder them.",
  domain: "A domain goes in a division, or in Unplaced.",
  team: "A team goes in a domain.",
};

// The row a drop target stands for: a node, a node's people, or one of the people there. null for
// the No team pool and the Unplaced root; undefined when it's nothing (or a node not in the rows).
function targetRow(rows: readonly StructureRow[], items: readonly LayoutItem[], target: LayoutItem): StructureRow | null | undefined {
  const byId = (id: string | null) => (id === null ? null : rows.find((r) => r.id === id));
  if (target.type === "node") return byId(target.id);
  if (target.type === "stack") return byId(target.teamId);
  if (target.type === "person") {
    const stack = items.find((i) => i.id === target.stack);
    return stack?.type === "stack" ? byId(stack.teamId) : undefined;
  }
  return null;
}

const imperative = (sentence: string) => sentence.replace(/^Moved /, "Move ");

// The plan for dropping `dragged` on `target`, or null when the drop does nothing (no target, or
// the same place).
export function planDrop(
  rows: readonly StructureRow[],
  items: readonly LayoutItem[],
  dragged: Dragged,
  target: LayoutItem | null,
): DropPlan | null {
  if (target === null) return null;
  const into = targetRow(rows, items, target);
  if (into === undefined) return null;
  const isUnplaced = target.type === "unplaced";
  // The No team pool, or someone in it.
  const isPool = !isUnplaced && into === null;

  if (dragged.type === "person") {
    const { person } = dragged;
    if (!person.editable) return null;
    if (isUnplaced) return { type: "refuse", label: "People go in a division, domain or team." };
    if (into === null) {
      if (person.teamId === null) return null;
      const from = rows.find((r) => r.id === person.teamId)?.name ?? "their team";
      const label = `Take ${person.name} out of ${from}`;
      return { type: "place", memberId: person.id, from: person.teamId, to: null, leads: false, label };
    }
    if (into.id === person.teamId) return null;
    if (into.kind === "organisation") {
      return { type: "refuse", label: "Only the project owner places people in the organisation." };
    }
    const leads = person.role === "member" && into.kind === "division" && rows.some((r) => r.kind === "organisation");
    const label = `Move ${person.name} to ${into.name}${leads ? `, where they'll be a leader` : ""}`;
    return { type: "place", memberId: person.id, from: person.teamId, to: into.id, leads, label };
  }

  const node = rows.find((r) => r.id === dragged.id);
  if (!node || node.archived_at !== null) return null;
  if (isPool) return { type: "refuse", label: "Drag people here, not teams." };

  let move: TeamMove | null;
  if (isUnplaced || into === null) {
    if (node.kind !== "domain") return { type: "refuse", label: WHERE_IT_GOES[node.kind] };
    if (node.parent_id === null) return null;
    move = dropToMove(rows, node.id, { type: "into", parentId: null });
  } else {
    if (into.id === node.id) return null;
    if (breadcrumb(into.id, rows).some((r) => r.id === node.id)) {
      return { type: "refuse", label: `${node.name} can't go inside itself.` };
    }
    if (canDrop(node.kind, into.kind)) {
      // Dropped on the node that already holds it: nothing to do (drop it on a sibling to reorder).
      if (into.id === node.parent_id) return null;
      move = dropToMove(rows, node.id, { type: "into", parentId: into.id });
    } else if (into.kind === node.kind) {
      move = dropToMove(rows, node.id, { type: "onto", id: into.id });
    } else {
      return { type: "refuse", label: WHERE_IT_GOES[node.kind] };
    }
  }
  if (!move) return null;
  return { type: "move", move, label: imperative(moveAnnouncement(rows, move)) };
}

// The server action a person drop calls: out of their team into No team, or into a node from where
// the chart showed them (if they've moved since, nothing changes).
export function placeAction(plan: PlacePlan, actions: Pick<TeamActions, "addMember" | "removeFromTeam">) {
  return plan.to === null
    ? { context: "removeFromTeam", run: () => actions.removeFromTeam(plan.from ?? "", plan.memberId) }
    : { context: "addMember", run: () => actions.addMember(plan.to as string, plan.memberId, plan.from) };
}
