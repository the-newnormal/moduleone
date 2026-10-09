"use client";

import { Handle, type Node, type NodeProps, Position, type XYPosition } from "@xyflow/react";
import {
  ArchiveIcon,
  Building2Icon,
  EllipsisIcon,
  FolderIcon,
  LayersIcon,
  LockIcon,
  MoveIcon,
  PanelRightOpenIcon,
  PencilIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import { createContext, useContext, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KIND_LABELS, typeLabel } from "@/lib/admin/tree";
import type { CreatableKind, TeamKind } from "@/lib/admin/validate";
import { cn } from "@/lib/utils";
import { type CanvasPerson, type LayoutItem, NO_TEAM_ID, TRUNK_X } from "./canvas-layout";
import type { StructureRow } from "./counts";
import { type EditorDialog, menuButton, nodeSelector } from "./editor-context";

// The canvas's boxes, as React Flow node types. Each box is drawn at the size canvas-layout gave
// it. Buttons inside a box carry "nodrag" so pressing them never starts a drag.

export type CanvasNode =
  | Node<{ row: StructureRow }, "structure">
  | Node<{ label: string }, "unplaced">
  | Node<{ title: string; pool: boolean }, "stack">
  | Node<{ person: CanvasPerson }, "person">;

// What the boxes read from the canvas: how to open a dialog or the side panel, and how the drag
// in progress affects them.
export type CanvasContextValue = {
  // `returnTo`: where focus goes when the dialog closes (by default the toolbar's Add a division).
  openDialog: (dialog: EditorDialog, returnTo?: string[]) => void;
  openPanel: (id: string) => void;
  over: { id: string; ok: boolean } | null; // the box a drag is over, and whether it takes the drop
};

export const CanvasContext = createContext<CanvasContextValue>({
  openDialog: () => {},
  openPanel: () => {},
  over: null,
});

const useCanvas = () => useContext(CanvasContext);

// What a node holds, for its "+": the organisation divisions, a division domains, a domain teams.
export const childKind = (kind: TeamKind): CreatableKind | null =>
  kind === "organisation" ? "division" : kind === "division" ? "domain" : kind === "domain" ? "team" : null;

const KIND_ICON = { organisation: Building2Icon, division: LayersIcon, domain: FolderIcon, team: UsersIcon };
const KIND_TINT: Record<TeamKind, string> = {
  organisation: "bg-foreground text-background",
  division: "bg-primary/15 text-primary",
  domain: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  team: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

// The "+" under a box: shown on hover, while the box is selected or when it has keyboard focus
// (its menu offers the same).
const PLUS =
  "nodrag absolute -bottom-3 left-1/2 flex size-6 -translate-x-1/2 items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow-sm outline-offset-2 transition-opacity group-hover:opacity-100 group-[.selected]:opacity-100 hover:scale-110 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring";

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
const leads = (n: number) => (n === 1 ? "1 lead" : `${n} leads`);

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
// Keys on a box's buttons: keep Enter and Space from React Flow (they'd select the box), but let
// Escape through to close the side panel.
const stopKeys = (event: { key: string; stopPropagation: () => void }) => {
  if (event.key !== "Escape") event.stopPropagation();
};

// The hint screen readers give for a person's box (React Flow's own is about a box's menu).
export const PERSON_HINT_ID = "canvas-person-hint";

// The ring a drag puts on the box it's over: green when the drop is taken, red when it isn't.
function overRing(id: string, over: CanvasContextValue["over"]) {
  if (over?.id !== id) return null;
  return over.ok ? "ring-2 ring-status-good bg-status-good/10" : "ring-2 ring-destructive";
}

// Where edges attach (canvas-layout's edge kinds); nobody connects boxes by hand here. In from
// above ("top") or, in a column, from the left ("left"); out below to a row ("bottom"), down the
// trunk to a column ("trunk"), or to the right to the box's people ("right").
const HIDDEN = "!pointer-events-none !opacity-0";
function Ends() {
  return (
    <>
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} className={HIDDEN} />
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} className={HIDDEN} />
      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} className={HIDDEN} />
      <Handle id="trunk" type="source" position={Position.Bottom} isConnectable={false} className={HIDDEN} style={{ left: TRUNK_X }} />
      <Handle id="right" type="source" position={Position.Right} isConnectable={false} className={HIDDEN} />
    </>
  );
}

// The handles' menu (the screenshot's "⋮"): open the side panel, edit, add under it, move, archive.
// The organisation never moves or archives.
function NodeMenu({ row }: { row: StructureRow }) {
  const { openDialog, openPanel } = useCanvas();
  // The dialog an item opens takes focus; don't let the closing menu take it back.
  const openingDialog = useRef(false);
  const open = (dialog: EditorDialog) => {
    openingDialog.current = true;
    openDialog(dialog, [menuButton(row.id), nodeSelector(row.id)]);
  };
  const child = childKind(row.kind);
  const fixed = row.kind === "organisation";

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="nodrag shrink-0"
          data-node-menu={row.id}
          aria-label={`More for ${row.name}`}
          onClick={stop}
          onKeyDown={stopKeys}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* Its items' clicks and keys reach the box through the portal (React's tree): stop them
          there, so they never select the box or open its panel. */}
      <DropdownMenuContent
        align="end"
        onClick={stop}
        onKeyDown={stop}
        onCloseAutoFocus={(event) => {
          if (openingDialog.current) event.preventDefault();
          openingDialog.current = false;
        }}
      >
        <DropdownMenuItem onSelect={() => openPanel(row.id)}>
          <PanelRightOpenIcon />
          People and leads
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open({ type: "edit", id: row.id })}>
          <PencilIcon />
          Edit…
        </DropdownMenuItem>
        {child && (
          <DropdownMenuItem
            onSelect={() => open({ type: "create", kind: child, parentId: child === "division" ? null : row.id })}
          >
            <PlusIcon />
            Add a {child}…
          </DropdownMenuItem>
        )}
        {!fixed && (
          <>
            <DropdownMenuItem onSelect={() => open({ type: "move", id: row.id })}>
              <MoveIcon />
              Move to…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => open({ type: "archive", id: row.id })}>
              <ArchiveIcon />
              Archive…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A division, domain or team (or the organisation): its kind, name, code and type, how many people
// sit in it and lead it, its menu, and a "+" under it to add what it holds.
export function StructureNodeView({ data, selected }: NodeProps<Extract<CanvasNode, { type: "structure" }>>) {
  const { row } = data;
  const { openDialog, over } = useCanvas();
  const Icon = KIND_ICON[row.kind];
  const type = typeLabel(row);
  const child = childKind(row.kind);

  return (
    <div
      className={cn(
        "group relative flex h-full w-full items-center gap-2.5 rounded-lg border bg-card px-2.5 text-card-foreground shadow-xs transition-colors",
        selected && "selected ring-2 ring-primary",
        overRing(row.id, over),
      )}
    >
      <Ends />
      <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", KIND_TINT[row.kind])}>
        <Icon className="size-4" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="truncate text-sm font-semibold" title={row.name}>
          {row.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {KIND_LABELS[row.kind]}
          {type && ` · ${type}`}
          {row.code && ` · ${row.code}`}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {people(row.members)}
          {row.leads > 0 && ` · ${leads(row.leads)}`}
        </p>
      </div>
      <NodeMenu row={row} />
      {child && (
        <button
          type="button"
          className={PLUS}
          aria-label={`Add a ${child} to ${row.name}`}
          data-add-under={row.id}
          onClick={(event) => {
            stop(event);
            openDialog({ type: "create", kind: child, parentId: child === "division" ? null : row.id }, [
              `[data-add-under="${row.id}"]`,
              menuButton(row.id),
            ]);
          }}
          onKeyDown={stopKeys}
        >
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// The root that holds domains outside every division. Drop a domain here to take it out of its
// division.
export function UnplacedNodeView({ id, data }: NodeProps<Extract<CanvasNode, { type: "unplaced" }>>) {
  const { openDialog, over } = useCanvas();
  return (
    <div
      className={cn(
        "group relative flex h-full w-full items-center gap-2.5 rounded-lg border border-dashed bg-muted/40 px-2.5",
        overRing(id, over),
      )}
    >
      <Ends />
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FolderIcon className="size-4" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="truncate text-sm font-semibold">{data.label}</p>
        <p className="truncate text-xs text-muted-foreground">Domains not in a division yet</p>
      </div>
      <button
        type="button"
        className={PLUS}
        aria-label="Add an unplaced domain"
        data-add="unplaced"
        onClick={(event) => {
          stop(event);
          openDialog({ type: "create", kind: "domain", parentId: null }, ['[data-add="unplaced"]']);
        }}
        onKeyDown={stopKeys}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

// The people who sit in a node, stacked under it (or, for the pool, those with no team).
export function StackNodeView({ id, data }: NodeProps<Extract<CanvasNode, { type: "stack" }>>) {
  const { over } = useCanvas();
  return (
    <div
      className={cn(
        "h-full w-full rounded-lg border border-dashed px-2 pt-1.5",
        data.pool ? "bg-muted/50" : "bg-background/70",
        overRing(id, over),
      )}
    >
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} className={HIDDEN} />
      <p className="truncate text-xs font-medium text-muted-foreground">{data.title}</p>
    </div>
  );
}

// One person. Drag them onto another division, domain or team to move them there, or into No team.
// Master Admins and the admin themselves (RLS refuses changing them) and whoever sits in the organisation
// (the project owner's to change) can't be moved here, so they're locked. A drag over someone rings
// their stack, which is what takes the drop.
export function PersonNodeView({ data }: NodeProps<Extract<CanvasNode, { type: "person" }>>) {
  const { person } = data;
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-2 rounded-md border bg-card px-2 text-sm shadow-xs",
        person.editable ? "cursor-grab active:cursor-grabbing" : "opacity-80",
      )}
      title={person.editable ? undefined : "Master Admins, your own row and the organisation's people can't be moved here."}
    >
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
        {person.name.trim().charAt(0).toUpperCase() || "?"}
      </span>
      <span className="min-w-0 flex-1 truncate">{person.name}</span>
      {person.role === "leader" && <Badge variant="secondary">Leader</Badge>}
      {person.role === "hq" && <Badge variant="secondary">Master Admin</Badge>}
      {!person.editable && <LockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
    </div>
  );
}

// "Mei Wong, leader", "Hana Lim, Master Admin, can't be moved here".
export function personLabel(person: CanvasPerson): string {
  const role = person.role === "leader" ? ", leader" : person.role === "hq" ? ", Master Admin" : "";
  return `${person.name}${role}${person.editable ? "" : ", can't be moved here"}`;
}

export const NODE_TYPES = {
  structure: StructureNodeView,
  unplaced: UnplacedNodeView,
  stack: StackNodeView,
  person: PersonNodeView,
};

// The layout's boxes as React Flow nodes, at their places (the one being dragged where the pointer
// has it). The organisation, Unplaced and the stacks never move; nor do people the admin can't
// move. Stacks aren't focusable: their people are, one by one.
export function flowNodes(
  items: readonly LayoutItem[],
  { dragged, selectedId }: { dragged: { id: string; position: XYPosition } | null; selectedId: string | null },
): CanvasNode[] {
  return items.map((item): CanvasNode => {
    const position = dragged?.id === item.id ? dragged.position : { x: item.x, y: item.y };
    const base = { id: item.id, position, width: item.width, height: item.height, selected: item.id === selectedId };
    switch (item.type) {
      case "node":
        return {
          ...base,
          type: "structure",
          data: { row: item.row },
          draggable: item.row.kind !== "organisation",
          ariaLabel: `${item.row.kind} ${item.row.name}`,
          zIndex: dragged?.id === item.id ? 1000 : 0,
        };
      case "unplaced":
        // Not a box you select or move, but its "+" takes clicks (React Flow turns pointer events
        // off for such nodes); the "+" is the tab stop, not the box.
        return {
          ...base,
          type: "unplaced",
          data: { label: "Unplaced" },
          draggable: false,
          selectable: false,
          focusable: false,
          style: { pointerEvents: "all" },
        };
      case "stack":
        return {
          ...base,
          type: "stack",
          data: {
            title: item.id === NO_TEAM_ID ? `No team · ${item.count}` : item.count === 1 ? "1 person" : `${item.count} people`,
            pool: item.id === NO_TEAM_ID,
          },
          draggable: false,
          selectable: false,
          focusable: false,
        };
      case "person":
        return {
          ...base,
          type: "person",
          data: { person: item.person },
          draggable: item.person.editable,
          ariaLabel: personLabel(item.person),
          domAttributes: { "aria-describedby": PERSON_HINT_ID },
          zIndex: dragged?.id === item.id ? 1000 : 1,
        };
    }
  });
}
