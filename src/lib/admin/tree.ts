// The team tree as the admin pages see it (migration 0003): divisions at the top, domains under a
// division or at the top ("unplaced"), teams under a domain. Archived nodes stay in the table
// (never deleted) but are left out of the tree and listed on their own. Since migration 0006 one
// organisation node sits at the top and holds every division; until then divisions sit at the top
// themselves. Code here takes either: a division's parent is the organisation node if there is
// one, else the top level.
//
// Positions follow admin_move_team: siblings are ordered by (sort_order, name, id), and a move's
// index counts the ACTIVE (non-archived) siblings at the destination, other than the node being
// moved. The top level can hold divisions and unplaced domains together, so an index there counts
// both, even though the page shows them in separate sections. dropToMove and moveOptions do that
// translation; don't count positions in the page.

import type { DivisionType, DomainType, TeamKind } from "./validate";

// A teams row with every column the admin pages use. (teams.division, the free-text column 0003
// deprecated, is left out: the app doesn't read it.)
export type TeamRow = {
  id: string;
  name: string;
  parent_id: string | null;
  kind: TeamKind;
  domain_type: DomainType | null;
  division_type: DivisionType | null;
  code: string | null;
  sort_order: number;
  note: string | null;
  leader_title: string | null; // what the leaders who sit here are called, like President (0006)
  archived_at: string | null;
};

// For supabase.from("teams").select(TEAM_COLUMNS).
export const TEAM_COLUMNS =
  "id, name, parent_id, kind, domain_type, division_type, code, sort_order, note, leader_title, archived_at";

// ---------- labels ----------

export const KIND_LABELS: Record<TeamKind, string> = {
  organisation: "Organisation",
  division: "Division",
  domain: "Domain",
  team: "Team",
};

export const DOMAIN_TYPE_LABELS: Record<DomainType, string> = {
  development: "Development domain",
  ip: "IP",
  lab: "Lab",
};

export const DIVISION_TYPE_LABELS: Record<DivisionType, string> = {
  strategy: "Strategy division",
  support_development: "Support and development division",
};

// The type badge for a row ("Lab", "Strategy division", …), or null when it has none (a team, or
// a domain or division whose type isn't set).
export function typeLabel(row: Pick<TeamRow, "kind" | "domain_type" | "division_type">): string | null {
  if (row.kind === "domain" && row.domain_type) return DOMAIN_TYPE_LABELS[row.domain_type];
  if (row.kind === "division" && row.division_type) return DIVISION_TYPE_LABELS[row.division_type];
  return null;
}

// ---------- ordering ----------

type Sortable = Pick<TeamRow, "id" | "name" | "sort_order">;

// Siblings in admin_move_team's order: sort_order, then name, then id.
export function compareSiblings(a: Sortable, b: Sortable): number {
  return (
    a.sort_order - b.sort_order ||
    a.name.localeCompare(b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// The active children of parentId (null: the top level), in order, optionally without one node.
export function activeChildren<T extends TeamRow>(
  rows: readonly T[],
  parentId: string | null,
  exceptId?: string,
): T[] {
  return rows
    .filter((r) => r.parent_id === parentId && r.archived_at === null && r.id !== exceptId)
    .sort(compareSiblings);
}

// ---------- the tree ----------

export type DomainNode<T extends TeamRow = TeamRow> = { row: T; teams: T[] };
export type DivisionNode<T extends TeamRow = TeamRow> = { row: T; domains: DomainNode<T>[] };

export type TeamTree<T extends TeamRow = TeamRow> = {
  organisation: T | null; // the node above every division (migration 0006), or null before it
  divisions: DivisionNode<T>[]; // active divisions in order, each with its active domains and their active teams
  unplaced: DomainNode<T>[]; // active domains at the top level, with their active teams
  archived: T[]; // every archived node, parents before their children
  // Active nodes that can't be shown in the tree because their parent is missing, archived or of
  // the wrong kind. The database forbids this, so it should stay empty; it's here so that
  // nothing silently disappears if it ever isn't.
  stray: T[];
};

export function buildTree<T extends TeamRow>(rows: readonly T[]): TeamTree<T> {
  const placed = new Set<string>();
  const place = (row: T) => {
    placed.add(row.id);
    return row;
  };
  const domainNode = (row: T): DomainNode<T> => ({
    row: place(row),
    teams: activeChildren(rows, row.id)
      .filter((t) => t.kind === "team")
      .map(place),
  });

  const top = activeChildren(rows, null);
  const organisation = top.find((r) => r.kind === "organisation") ?? null;
  if (organisation) place(organisation);
  const divisions = activeChildren(rows, organisation?.id ?? null)
    .filter((r) => r.kind === "division")
    .map((row) => ({
      row: place(row),
      domains: activeChildren(rows, row.id)
        .filter((d) => d.kind === "domain")
        .map(domainNode),
    }));
  const unplaced = top.filter((r) => r.kind === "domain").map(domainNode);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const byPath = (a: T, b: T) => comparePaths(lineage(byId, a), lineage(byId, b));
  const archived = rows.filter((r) => r.archived_at !== null).sort(byPath);
  const stray = rows.filter((r) => r.archived_at === null && !placed.has(r.id)).sort(byPath);

  return { organisation, divisions, unplaced, archived, stray };
}

// The node and the ancestors above it, top first. Stops at a missing parent and never loops.
function lineage<T extends Pick<TeamRow, "id" | "parent_id">>(
  byId: ReadonlyMap<string, T>,
  node: T,
): T[] {
  const chain = [node];
  const seen = new Set([node.id]);
  for (let parent = node.parent_id; parent !== null && !seen.has(parent); ) {
    const next = byId.get(parent);
    if (!next) break;
    chain.push(next);
    seen.add(next.id);
    parent = next.parent_id;
  }
  return chain.reverse();
}

// Depth-first order: compare two lineages node by node, parents before their children.
function comparePaths(a: readonly Sortable[], b: readonly Sortable[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].id !== b[i].id) return compareSiblings(a[i], b[i]);
  }
  return a.length - b.length;
}

// Where a node sits, top first and ending with the node itself: [division, domain, team] for a
// team, for example. Empty if the id isn't among the rows. Stops at a parent that isn't among the
// rows, and never loops.
export function breadcrumb<T extends Pick<TeamRow, "id" | "parent_id">>(
  id: string,
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const node = byId.get(id);
  return node ? lineage(byId, node) : [];
}

// ---------- moving ----------

// What may hold each kind: the organisation node never moves; a division sits in it, or at the top
// level (null) before there is one; a domain at the top level (unplaced) or in a division; a team
// in a domain.
const PARENT_KINDS: Record<TeamKind, readonly (TeamKind | null)[]> = {
  organisation: [],
  division: [null, "organisation"],
  domain: [null, "division"],
  team: ["domain"],
};

// Whether a node of dragKind may be dropped into a parent of targetParentKind (null: the top
// level). Use it to offer only valid drop targets while dragging.
export function canDrop(dragKind: TeamKind, targetParentKind: TeamKind | null): boolean {
  return PARENT_KINDS[dragKind].includes(targetParentKind);
}

// admin_move_team's arguments.
export type TeamMove = { teamId: string; parentId: string | null; index: number };

// Where a drag ended:
// - "into": on a container (a division's domain list, a domain's team list, the Unplaced section
//   or the division list, with parentId null for the last two). The node goes last there.
// - "onto": on another node of the same kind. Like @dnd-kit/sortable's arrayMove, within one list
//   the node takes that node's place (so dragging down past it lands after it); from another list
//   it goes just before it.
export type DropTarget = { type: "into"; parentId: string | null } | { type: "onto"; id: string };

// The move a drop asks for, or null when the drop isn't allowed (unknown or archived nodes, the
// wrong kind of parent) or wouldn't change anything.
export function dropToMove(
  rows: readonly TeamRow[],
  draggedId: string,
  target: DropTarget,
): TeamMove | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dragged = byId.get(draggedId);
  if (!dragged || dragged.archived_at !== null) return null;

  let parentId: string | null;
  let index: number;
  if (target.type === "into") {
    parentId = target.parentId;
    index = activeChildren(rows, parentId, dragged.id).length;
  } else {
    const over = byId.get(target.id);
    if (!over || over.archived_at !== null || over.kind !== dragged.kind || over.id === dragged.id) {
      return null;
    }
    parentId = over.parent_id;
    // Same list: count the dragged node too, so the index is the slot it takes (arrayMove).
    const list = activeChildren(rows, parentId, parentId === dragged.parent_id ? undefined : dragged.id);
    index = list.findIndex((r) => r.id === over.id);
  }

  const parent = parentId === null ? null : byId.get(parentId);
  if (parent === undefined || parent?.archived_at) return null;
  if (!canDrop(dragged.kind, parent?.kind ?? null)) return null;

  if (parentId === dragged.parent_id) {
    const now = activeChildren(rows, parentId).findIndex((r) => r.id === dragged.id);
    if (now === index) return null;
  }
  return { teamId: dragged.id, parentId, index };
}

// The rows after a move, as admin_move_team leaves them: the node under its new parent at
// min(index, active siblings), active siblings renumbered 0, 1, 2, … at the destination, the gap
// closed at the old parent, archived siblings untouched (an archived node goes after the active
// ones). For optimistic updates; the page reloads the real rows afterwards.
export function applyMove<T extends TeamRow>(rows: readonly T[], move: TeamMove): T[] {
  const node = rows.find((r) => r.id === move.teamId);
  if (!node) return [...rows];

  const updates = new Map<string, Partial<TeamRow>>();
  const siblings = activeChildren(rows, move.parentId, node.id);
  const pos = node.archived_at === null ? Math.min(move.index, siblings.length) : siblings.length;
  siblings.forEach((s, rank) => updates.set(s.id, { sort_order: rank < pos ? rank : rank + 1 }));
  if (node.parent_id !== move.parentId) {
    activeChildren(rows, node.parent_id, node.id).forEach((s, rank) =>
      updates.set(s.id, { sort_order: rank }),
    );
  }
  updates.set(node.id, { parent_id: move.parentId, sort_order: pos });
  return rows.map((r) => (updates.has(r.id) ? { ...r, ...updates.get(r.id) } : r));
}

// A place to move a node to, for the "Move to…" dialog (the accessible fallback for dragging).
export type MovePosition = {
  index: number; // admin_move_team's p_index
  label: string; // "First", "After Gather", …
  current: boolean; // where the node is now
};
export type MoveOption = {
  parentId: string | null;
  label: string; // "Gather", "Gather › IP Lab", "Unplaced", "Top level"
  current: boolean; // the node's parent now
  positions: MovePosition[];
};

// Every active parent the node may move to, in tree order (the top level last for a domain, as
// "Unplaced"), each with the positions it offers among the siblings shown with the node: other
// divisions for a division, other unplaced domains for an unplaced domain (their indexes count the
// whole top level, as admin_move_team does). Empty for an unknown or archived node, and for the
// organisation node, which never moves.
export function moveOptions(rows: readonly TeamRow[], nodeId: string): MoveOption[] {
  const node = rows.find((r) => r.id === nodeId);
  if (!node || node.archived_at !== null) return [];

  const tree = buildTree(rows);
  const option = (parentId: string | null, label: string): MoveOption => {
    const all = activeChildren(rows, parentId, node.id);
    const shown = all.filter((r) => r.kind === node.kind);
    const fullIndex = (r: TeamRow) => all.indexOf(r);
    const current = parentId === node.parent_id;
    const currentSlot = current
      ? activeChildren(rows, parentId)
          .filter((r) => r.kind === node.kind)
          .findIndex((r) => r.id === node.id)
      : -1;
    const positions = [0, ...shown.map((_, i) => i + 1)].map((slot) => ({
      index:
        slot === 0
          ? shown.length > 0
            ? fullIndex(shown[0])
            : all.length
          : fullIndex(shown[slot - 1]) + 1,
      label: slot === 0 ? "First" : `After ${shown[slot - 1].name}`,
      current: slot === currentSlot,
    }));
    return { parentId, label, current, positions };
  };

  if (node.kind === "organisation") return [];
  if (node.kind === "division") {
    return [option(tree.organisation?.id ?? null, tree.organisation?.name ?? "Top level")];
  }
  if (node.kind === "domain") {
    return [
      ...tree.divisions.map((d) => option(d.row.id, d.row.name)),
      option(null, "Unplaced"),
    ];
  }
  return [
    ...tree.divisions.flatMap((d) =>
      d.domains.map((dom) => option(dom.row.id, `${d.row.name} › ${dom.row.name}`)),
    ),
    ...tree.unplaced.map((dom) => option(dom.row.id, `Unplaced › ${dom.row.name}`)),
  ];
}

// A plain-words sentence for screen readers after a move: "Moved Atlas to Gather, position 2".
// The position counts the nodes shown with it (other divisions, or other unplaced domains), from 1.
export function moveAnnouncement(rows: readonly TeamRow[], move: TeamMove): string {
  const after = applyMove(rows, move);
  const node = after.find((r) => r.id === move.teamId);
  if (!node) return "";
  const parent = move.parentId === null ? null : after.find((r) => r.id === move.parentId);
  const where = parent ? parent.name : node.kind === "division" ? "the top level" : "Unplaced";
  const position =
    activeChildren(after, move.parentId)
      .filter((r) => r.kind === node.kind)
      .findIndex((r) => r.id === node.id) + 1;
  return `Moved ${node.name} to ${where}, position ${position}`;
}
