"use client";

import { type DraggableAttributes, type DraggableSyntheticListeners, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS, useCombinedRefs } from "@dnd-kit/utilities";
import { ArchiveIcon, EllipsisIcon, GripVerticalIcon, PencilIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DivisionNode, type DomainNode, KIND_LABELS, typeLabel } from "@/lib/admin/tree";
import { cn } from "@/lib/utils";
import type { StructureRow } from "./counts";
import { containerOffered, intoData, intoId, listStrategy, nodeData, nodeTakesDrops } from "./drag";
import { useEditor } from "./editor-context";

// What a row needs from dnd-kit, taken apart (the hooks' results hold refs, which mustn't be
// read while rendering). `attach` is the callback ref that registers an element with dnd-kit.
type Attach = (element: HTMLElement | null) => void;
type Handle = {
  attach: Attach;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
};

// A node as a sortable item. While something else is dragged, it only takes drops of its own
// kind; other kinds pass over it.
function useNode(row: StructureRow) {
  const { dragging } = useEditor();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging, isOver } =
    useSortable({
      id: row.id,
      data: nodeData(row),
      disabled: { draggable: false, droppable: !nodeTakesDrops(dragging, row.kind) },
    });
  const handle: Handle = { attach: setActivatorNodeRef, attributes, listeners };
  return {
    attach: setNodeRef,
    handle,
    style: { transform: CSS.Translate.toString(transform), transition },
    isDragging,
    // Dragged here from another list, the node goes just before this one: show the line it
    // lands on. (Within its own list, the other items make room instead.)
    dropBefore: isOver && dragging !== null && dragging.parentId !== row.parent_id,
  };
}

// A node as a container for the kind below it (a division takes domains, a domain teams): a
// drop on it, but not on one of its rows, puts the node last there (see containerOffered).
function useContainer(parentId: string | null, accepts: "domain" | "team") {
  const { dragging } = useEditor();
  const offered = containerOffered(dragging, parentId, accepts);
  const { setNodeRef, isOver } = useDroppable({
    id: intoId(parentId),
    data: intoData(accepts, parentId),
    disabled: !offered,
  });
  return { attach: setNodeRef, offered, isOver };
}

function DropLine({ show }: { show: boolean }) {
  if (!show) return null;
  return <span aria-hidden className="pointer-events-none absolute inset-x-0 -top-0.5 h-1 rounded-full bg-primary" />;
}

// While a node is dragged, the places that take it are outlined, and the one it's over stands out.
const containerClasses = ({ offered, isOver }: { offered: boolean; isOver: boolean }) =>
  cn(offered && "outline-1 outline-offset-2 outline-primary/50 outline-dashed", isOver && "bg-primary/5 ring-2 ring-primary");

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
const leads = (n: number) => (n === 1 ? "1 lead" : `${n} leads`);

function DragHandle({ row, handle }: { row: StructureRow; handle: Handle }) {
  const { attach, attributes, listeners } = handle;
  return (
    <button
      type="button"
      ref={attach}
      {...attributes}
      {...listeners}
      aria-label={`Drag ${KIND_LABELS[row.kind].toLowerCase()} ${row.name}`}
      className="mt-0.5 inline-flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
    >
      <GripVerticalIcon className="size-4" />
    </button>
  );
}

function RowMenu({ row }: { row: StructureRow }) {
  const { openDialog } = useEditor();
  // The dialog an item opens takes focus; don't let the closing menu take it back.
  const openingDialog = useRef(false);
  const open = (dialog: Parameters<typeof openDialog>[0]) => {
    openingDialog.current = true;
    openDialog(dialog);
  };
  const child = row.kind === "division" ? "domain" : row.kind === "domain" ? "team" : null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" data-node-menu={row.id} aria-label={`More for ${row.name}`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (openingDialog.current) event.preventDefault();
          openingDialog.current = false;
        }}
      >
        <DropdownMenuItem onSelect={() => open({ type: "edit", id: row.id })}>
          <PencilIcon />
          Edit…
        </DropdownMenuItem>
        {child && (
          <DropdownMenuItem onSelect={() => open({ type: "create", kind: child, parentId: row.id })}>
            <PlusIcon />
            Add a {child}…
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => open({ type: "archive", id: row.id })}>
          <ArchiveIcon />
          Archive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One node's line: handle, name (a link into its team page), code, type, counts and note, then
// Move to… and the menu.
export function NodeRow({ row, handle, headingId }: { row: StructureRow; handle?: Handle; headingId?: string }) {
  const { openDialog } = useEditor();
  const type = typeLabel(row);
  const name = (
    <Link href={`/admin/teams/${row.id}`} className="underline-offset-4 hover:underline">
      {row.name}
    </Link>
  );
  const Name = row.kind === "division" ? "h2" : row.kind === "domain" ? "h3" : "p";

  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1 py-1.5">
      {handle && <DragHandle row={row} handle={handle} />}
      <div className="grid min-w-0 flex-1 basis-48 gap-0.5 pt-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Name
            id={headingId}
            className={cn("min-w-0 break-words", row.kind === "division" ? "text-2xl" : "font-medium", row.kind === "domain" && "text-lg")}
          >
            {name}
          </Name>
          {row.code && <code className="font-mono text-xs text-muted-foreground">{row.code}</code>}
          {type && <Badge variant="secondary">{type}</Badge>}
          <span className="text-xs text-muted-foreground">
            {people(row.members)}
            {row.leads > 0 && ` · ${leads(row.leads)}`}
          </span>
        </div>
        {row.note && <p className="text-sm whitespace-pre-line text-muted-foreground">{row.note}</p>}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" data-node-move={row.id} onClick={() => openDialog({ type: "move", id: row.id })}>
          <span className="sr-only">{row.name}: </span>Move to…
        </Button>
        <RowMenu row={row} />
      </div>
    </div>
  );
}

// The organisation node (migration 0006), above every division: its name opens its page (who sits
// there), and Edit renames it. It never moves or archives, so it has no handle or menu.
export function OrganisationRow({ row }: { row: StructureRow }) {
  const { openDialog } = useEditor();
  return (
    <section aria-labelledby={`organisation-${row.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-3">
      <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
        <span className="text-xs text-muted-foreground">{KIND_LABELS[row.kind]}</span>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 id={`organisation-${row.id}`} className="min-w-0 text-2xl break-words">
            <Link href={`/admin/teams/${row.id}`} className="underline-offset-4 hover:underline">
              {row.name}
            </Link>
          </h2>
          {row.code && <code className="font-mono text-xs text-muted-foreground">{row.code}</code>}
          <span className="text-xs text-muted-foreground">
            {people(row.members)}
            {row.leads > 0 && ` · ${leads(row.leads)}`}
          </span>
        </div>
        {row.note && <p className="text-sm whitespace-pre-line text-muted-foreground">{row.note}</p>}
      </div>
      <Button variant="ghost" size="sm" data-node-menu={row.id} onClick={() => openDialog({ type: "edit", id: row.id })}>
        <PencilIcon />
        Edit<span className="sr-only"> {row.name}</span>…
      </Button>
    </section>
  );
}

function TeamItem({ row }: { row: StructureRow }) {
  const { attach, style, isDragging, dropBefore, handle } = useNode(row);
  return (
    <li ref={attach} style={style} className={cn("relative", isDragging && "opacity-40")}>
      <DropLine show={dropBefore} />
      <NodeRow row={row} handle={handle} />
    </li>
  );
}

function DomainItem({ domain }: { domain: DomainNode<StructureRow> }) {
  const { row, teams } = domain;
  const node = useNode(row);
  const container = useContainer(row.id, "team");
  const ref = useCombinedRefs(node.attach, container.attach);

  return (
    <li
      ref={ref}
      style={node.style}
      className={cn("relative rounded-lg px-2", node.isDragging && "opacity-40", containerClasses(container))}
    >
      <DropLine show={node.dropBefore} />
      <NodeRow row={row} handle={node.handle} />
      <SortableContext id={`list:${row.id}`} items={teams.map((t) => t.id)} strategy={listStrategy}>
        {teams.length > 0 && (
          <ul aria-label={`Teams in ${row.name}`} className="mb-2 ml-4 grid border-l pl-2 sm:ml-8">
            {teams.map((team) => (
              <TeamItem key={team.id} row={team} />
            ))}
          </ul>
        )}
      </SortableContext>
    </li>
  );
}

function DomainList({ label, domains }: { label: string; domains: DomainNode<StructureRow>[] }) {
  return (
    <ul aria-label={label} className="grid gap-1">
      {domains.map((domain) => (
        <DomainItem key={domain.row.id} domain={domain} />
      ))}
    </ul>
  );
}

export function DivisionSection({ division }: { division: DivisionNode<StructureRow> }) {
  const { row, domains } = division;
  const { openDialog } = useEditor();
  const node = useNode(row);
  const container = useContainer(row.id, "domain");
  const ref = useCombinedRefs(node.attach, container.attach);
  const headingId = `division-${row.id}`;

  return (
    <section
      ref={ref}
      style={node.style}
      aria-labelledby={headingId}
      className={cn(
        "relative grid gap-2 rounded-xl border bg-card p-3 sm:p-4",
        node.isDragging && "opacity-40",
        containerClasses(container),
      )}
    >
      <NodeRow row={row} handle={node.handle} headingId={headingId} />
      <SortableContext id={`list:${row.id}`} items={domains.map((d) => d.row.id)} strategy={listStrategy}>
        {domains.length > 0 ? (
          <DomainList label={`Domains in ${row.name}`} domains={domains} />
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 px-2 pb-1 text-sm text-muted-foreground">
            No domains yet.
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => openDialog({ type: "create", kind: "domain", parentId: row.id })}>
              Add a domain
            </Button>
          </p>
        )}
      </SortableContext>
    </section>
  );
}

export function UnplacedSection({ domains }: { domains: DomainNode<StructureRow>[] }) {
  const { openDialog } = useEditor();
  const { attach, offered, isOver } = useContainer(null, "domain");

  return (
    <section
      ref={attach}
      aria-labelledby="unplaced-heading"
      className={cn("grid gap-2 rounded-xl border border-dashed p-3 sm:p-4", containerClasses({ offered, isOver }))}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 px-1">
        <div className="grid gap-1">
          <h2 id="unplaced-heading" className="text-2xl">
            Unplaced
          </h2>
          <p className="text-sm text-muted-foreground">
            Domains that aren&apos;t in a division yet. Drag one into a division, or use Move to… to place it.
          </p>
        </div>
        <Button variant="outline" size="sm" data-add="unplaced" onClick={() => openDialog({ type: "create", kind: "domain", parentId: null })}>
          <PlusIcon />
          Add a domain
        </Button>
      </div>
      <SortableContext id="list:unplaced" items={domains.map((d) => d.row.id)} strategy={listStrategy}>
        {domains.length > 0 ? (
          <DomainList label="Unplaced domains" domains={domains} />
        ) : (
          <p className="px-1 text-sm text-muted-foreground">None.</p>
        )}
      </SortableContext>
    </section>
  );
}

// Active nodes the tree can't place (the database forbids this, so normally none): listed so
// nothing disappears, with Move to… to put them back.
export function StrayList({ rows }: { rows: StructureRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="stray-heading" className="grid gap-2 rounded-xl border border-destructive/40 p-3 sm:p-4">
      <h2 id="stray-heading" className="text-2xl">
        Not in the tree
      </h2>
      <p className="text-sm text-muted-foreground">
        These sit somewhere the tree can&apos;t show. Use Move to… to put each one in its place.
      </p>
      <ul className="grid gap-1">
        {rows.map((row) => (
          <li key={row.id}>
            <NodeRow row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}
