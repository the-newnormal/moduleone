// Drag and drop on the Structure page, apart from React: what each draggable and droppable stands
// for, which drops are offered while a node is dragged, and the plain words screen readers hear.
//
// Every node is a sortable item (draggable, and a droppable for nodes of its own kind: "onto").
// Divisions, domains and the Unplaced section are also containers for the kind below them ("into":
// the node goes last there). Only places that may take the dragged kind are offered: the others
// are disabled while dragging and filtered out here. The keyboard steps through those places in
// page order, one per arrow key (keyboardPlaces), without measuring anything but where they are.

import {
  type Active,
  type Announcements,
  type Collision,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type KeyboardSensorOptions,
  type Over,
  pointerWithin,
  rectIntersection,
} from "@dnd-kit/core";
import { type SortingStrategy, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  activeChildren,
  applyMove,
  buildTree,
  dropToMove,
  type DropTarget,
  KIND_LABELS,
  moveAnnouncement,
  type TeamMove,
  type TeamRow,
} from "@/lib/admin/tree";
import { isTeamKind, type TeamKind } from "@/lib/admin/validate";

// ---------- what draggables and droppables carry ----------

// A droppable's `data`: which kind of node it takes, and what dropping there means.
export type DropData = { accepts: TeamKind; target: DropTarget };
// A node's `data` (as a sortable item it is both): its kind and name too.
export type NodeData = DropData & { kind: TeamKind; name: string };

export function nodeData(row: Pick<TeamRow, "id" | "kind" | "name">): NodeData {
  return { kind: row.kind, name: row.name, accepts: row.kind, target: { type: "onto", id: row.id } };
}

// The kind each container takes: domains in a division (and at the top level, as Unplaced),
// teams in a domain.
export function intoData(accepts: TeamKind, parentId: string | null): DropData {
  return { accepts, target: { type: "into", parentId } };
}

// Container ids, apart from the node ids (uuids) used by the sortable items.
export const intoId = (parentId: string | null) => `into:${parentId ?? "top"}`;

type HasData = { data: { current?: unknown } } | null | undefined;
const record = (entry: HasData) => {
  const data = entry?.data.current;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
};

// The kind of node being dragged, or null.
export function dragKind(active: HasData): TeamKind | null {
  const kind = record(active)?.kind;
  return isTeamKind(kind) ? kind : null;
}

// What a drop on `over` means, or null when it isn't a place on this page.
export function targetOf(over: HasData): DropTarget | null {
  const target = record(over)?.target as DropTarget | undefined;
  if (target?.type === "onto" && typeof target.id === "string") return target;
  if (target?.type === "into" && (target.parentId === null || typeof target.parentId === "string")) {
    return target;
  }
  return null;
}

// What's being dragged, as the rows see it: its kind and its parent (null: nothing is dragged).
export type Dragging = { kind: TeamKind; parentId: string | null } | null;

// Whether a node's row takes drops: always when nothing is dragged, else only from its own kind
// (the others are disabled, so neither the pointer nor the keyboard is offered them).
export function nodeTakesDrops(dragging: Dragging, kind: TeamKind): boolean {
  return dragging === null || dragging.kind === kind;
}

// Whether a container (a division for domains, a domain for teams, the top level for unplaced
// domains) is offered: only while a node of the kind it takes is dragged, and not to the node's
// own parent, where it would only send the node to the end (its siblings' rows reorder it).
export function containerOffered(dragging: Dragging, parentId: string | null, takes: TeamKind): boolean {
  return dragging !== null && dragging.kind === takes && dragging.parentId !== parentId;
}

// Whether a droppable takes a dragged node of `kind`.
export function accepts(entry: HasData, kind: TeamKind | null): boolean {
  return kind !== null && record(entry)?.accepts === kind && targetOf(entry) !== null;
}

// ---------- collisions ----------

const isNode = (collision: Collision) =>
  targetOf(collision.data?.droppableContainer as DroppableContainer | undefined)?.type === "onto";

// A node sits inside its container, so a pointer on a node is on both: the node wins.
const nodesFirst = (collisions: Collision[]) => [
  ...collisions.filter(isNode),
  ...collisions.filter((c) => !isNode(c)),
];

// Where the keyboard puts the dragged item's top-left corner for a place: a node's top-left corner,
// and for a container ("last there") its bottom-left corner, which is below its last row, as the
// place is in keyboardPlaces. (Its top-left corner is above its rows: Down would then move the item
// up, and dnd-kit's keyboard sensor scrolls the page the wrong way instead of moving it.)
export function anchorOf(id: string | number, rect: { left: number; top: number; bottom: number }) {
  return String(id).startsWith("into:") ? { x: rect.left, y: rect.bottom } : { x: rect.left, y: rect.top };
}

// With the keyboard, the place whose anchor is nearest the dragged item's top-left corner: the
// keyboard puts the item's corner on the place it chose (keyboardCoordinates), and before the first
// arrow key it sits on its own row. (Comparing whole rectangles, as dnd-kit's closestCorners does,
// goes wrong here: the dragged item is a small chip, the rows are tall, and the row above a tall
// one can be "closer" than the row itself.)
const nearestAnchor: CollisionDetection = ({ collisionRect, droppableRects, droppableContainers }) =>
  droppableContainers
    .flatMap((droppableContainer) => {
      const rect = droppableRects.get(droppableContainer.id);
      if (!rect) return [];
      const at = anchorOf(droppableContainer.id, rect);
      const value = Math.hypot(at.x - collisionRect.left, at.y - collisionRect.top);
      return [{ id: droppableContainer.id, data: { droppableContainer, value } }];
    })
    .sort((a, b) => a.data.value - b.data.value);

// Only places that take the dragged kind. With a pointer: what's under it (a node before its
// container), else what the dragged item overlaps. With the keyboard: the place it was put on.
export const collisionDetection: CollisionDetection = (args) => {
  const kind = dragKind(args.active);
  const droppableContainers = args.droppableContainers.filter((c) => accepts(c, kind));
  if (droppableContainers.length === 0) return [];
  const scoped = { ...args, droppableContainers };
  if (args.pointerCoordinates) {
    const under = pointerWithin(scoped);
    return nodesFirst(under.length > 0 ? under : rectIntersection(scoped));
  }
  return nearestAnchor(scoped);
};

// ---------- the keyboard ----------

// Every place a dragged node can go, as droppable ids in page order, the node's own row among
// them: for a division the divisions; for a domain each division's domains and then the division
// itself (last there), then the same for Unplaced; for a team each domain's teams and then the
// domain. The node's own parent isn't offered as a container (its last row does that), so each
// place means a different move: one arrow key, one position.
export function keyboardPlaces(rows: readonly TeamRow[], activeId: string): string[] {
  const node = rows.find((r) => r.id === activeId);
  if (!node || node.archived_at !== null) return [];
  const tree = buildTree(rows);
  const list = (ids: string[], parentId: string | null) =>
    parentId === node.parent_id ? ids : [...ids, intoId(parentId)];

  if (node.kind === "division") return tree.divisions.map((d) => d.row.id);
  if (node.kind === "domain") {
    const divisions = tree.divisions.flatMap((d) => list(d.domains.map((dom) => dom.row.id), d.row.id));
    return [...divisions, ...list(tree.unplaced.map((dom) => dom.row.id), null)];
  }
  const domains = [...tree.divisions.flatMap((d) => d.domains), ...tree.unplaced];
  return domains.flatMap((dom) => list(dom.teams.map((t) => t.id), dom.row.id));
}

// The keyboard sensor's coordinate getter: Up and Down move the dragged item onto the previous or
// next place (keyboardPlaces) that's on the page now, by putting its top-left corner on that
// place's anchor (anchorOf), so Down always moves it down; nearestAnchor then finds it. At either
// end the item stays. (The sensor must scroll with scrollBehavior "auto": while a smooth scroll
// runs, the item passes over other places, and the next key would start from one of them.)
export function keyboardCoordinates(rows: readonly TeamRow[]): KeyboardCoordinateGetter {
  return (event, { active, context }) => {
    const step = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0;
    if (event.code.startsWith("Arrow")) event.preventDefault();
    if (step === 0) return undefined;

    const places = keyboardPlaces(rows, String(active)).filter((id) => {
      const container = context.droppableContainers.get(id);
      return container !== undefined && !container.disabled && context.droppableRects.has(id);
    });
    const now = places.indexOf(String(context.over?.id ?? active));
    const next = places[(now === -1 ? places.indexOf(String(active)) : now) + step];
    const rect = next === undefined ? undefined : context.droppableRects.get(next);
    return next !== undefined && rect ? anchorOf(next, rect) : undefined;
  };
}

// The keyboard sensor's options: the places above, and instant scrolling (see keyboardCoordinates).
export function keyboardSensorOptions(rows: readonly TeamRow[]): KeyboardSensorOptions {
  return { coordinateGetter: keyboardCoordinates(rows), scrollBehavior: "auto" };
}

// verticalListSortingStrategy, except when the pointer is outside this list: then nothing in it
// shifts. (dnd-kit's strategy would slide the items above the dragged one down, as if it had
// moved to the top, when it's really over another list; that list shows where it would go.)
export const listStrategy: SortingStrategy = (args) =>
  args.overIndex === -1 ? null : verticalListSortingStrategy(args);

// ---------- words ----------

export type Place = {
  name: string; // "Gather", "the top level" (divisions) or "Unplaced" (domains with no division)
  position: number; // from 1, among the nodes shown with it (its own kind)
  of: number;
};

// Where a node is now, as people see it on the page. Null for an unknown or archived node.
export function placeOf(rows: readonly TeamRow[], id: string): Place | null {
  const node = rows.find((r) => r.id === id);
  if (!node || node.archived_at !== null) return null;
  const parent = node.parent_id === null ? null : rows.find((r) => r.id === node.parent_id);
  const shown = activeChildren(rows, node.parent_id).filter((r) => r.kind === node.kind);
  return {
    name: parent ? parent.name : node.kind === "division" ? "the top level" : "Unplaced",
    position: shown.findIndex((r) => r.id === id) + 1,
    of: shown.length,
  };
}

const at = (place: Place) => `${place.name === "the top level" ? "at" : "in"} ${place.name}, position ${place.position} of ${place.of}`;
const to = (place: Place) => `to ${place.name}, position ${place.position} of ${place.of}`;

// The move a drag would make if dropped on `over` now (null: none, or nothing would change).
export function moveFor(rows: readonly TeamRow[], active: { id: string | number }, over: Over | null): TeamMove | null {
  const target = targetOf(over);
  return target ? dropToMove(rows, String(active.id), target) : null;
}

// What screen readers hear while dragging, worked out from the rows as they are before the drop.
export function structureAnnouncements(rows: readonly TeamRow[]): Announcements {
  const named = (active: Active) => {
    const node = rows.find((r) => r.id === String(active.id));
    return { node, name: node?.name ?? "The item" };
  };
  return {
    onDragStart({ active }) {
      const { node, name } = named(active);
      const place = node ? placeOf(rows, node.id) : null;
      if (!node || !place) return `Picked up ${name}.`;
      return `Picked up ${KIND_LABELS[node.kind].toLowerCase()} ${name}, ${at(place)}.`;
    },
    onDragOver({ active, over }) {
      const { node, name } = named(active);
      if (!node || !targetOf(over)) return `${name} isn't over a place it can go.`;
      const move = moveFor(rows, active, over);
      const place = move ? placeOf(applyMove(rows, move), node.id) : placeOf(rows, node.id);
      if (!place) return undefined;
      return move ? `${name} would move ${to(place)}.` : `${name} would stay where it is, ${at(place)}.`;
    },
    onDragEnd({ active, over }) {
      const { name } = named(active);
      const move = moveFor(rows, active, over);
      if (move) return `${moveAnnouncement(rows, move)}.`;
      return `${name} wasn't moved.`;
    },
    onDragCancel({ active }) {
      const { node, name } = named(active);
      const place = node ? placeOf(rows, node.id) : null;
      return place ? `Moving ${name} was cancelled. It's still ${at(place)}.` : `Moving ${name} was cancelled.`;
    },
  };
}

export const SCREEN_READER_INSTRUCTIONS =
  "To move this, press space or enter, then use the up and down arrow keys: only places it can go " +
  "are offered. Press space or enter to drop it there, or escape to cancel. The Move to… button " +
  "does the same without dragging.";
