"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { startTransition, useCallback, useId, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { focusSoon } from "@/components/admin/focus";
import { Button } from "@/components/ui/button";
import { settle } from "@/lib/admin/errors";
import { applyMove, buildTree, KIND_LABELS, moveAnnouncement, type TeamMove } from "@/lib/admin/tree";
import { ArchivedSection, type Report } from "./archived-list";
import type { StructureRow } from "./counts";
import {
  collisionDetection,
  keyboardSensorOptions,
  listStrategy,
  moveFor,
  SCREEN_READER_INSTRUCTIONS,
  structureAnnouncements,
} from "./drag";
import {
  EditorContext,
  type EditorDialog,
  menuButton,
  moveButton,
  type StructureActions,
} from "./editor-context";
import { ArchiveDialog, MoveDialog, NodeFormDialog } from "./node-dialogs";
import { DivisionSection, OrganisationRow, StrayList, UnplacedSection } from "./tree-nodes";

type Notice = { tone: "done" | "error"; text: string } | null;

// Pointer drags start after a few pixels, so a click on the handle isn't a drag.
const POINTER = { activationConstraint: { distance: 6 } };
// Places are enabled and disabled as a drag starts (only the dragged kind's are offered), so
// measure them throughout.
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };

// The Structure page's editor: the tree of divisions, domains and teams, with drag and drop,
// Move to…, add, edit, archive and restore. `rows` are every teams row with its counts, as the
// server read them; `actions` are the page's server actions. Moves show at once (optimistically)
// and roll back if the database refuses, with its reason; every write re-renders the page with
// the rows as they now are.
export function StructureEditor({ rows, actions }: { rows: StructureRow[]; actions: StructureActions }) {
  const dndId = useId();
  const [view, addMove] = useOptimistic(rows, (current: StructureRow[], move: TeamMove) => applyMove(current, move));
  const tree = useMemo(() => buildTree(view), [view]);
  const [saving, startSaving] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRow = activeId === null ? null : (view.find((r) => r.id === activeId) ?? null);
  const dragging = useMemo(
    () => (activeRow ? { kind: activeRow.kind, parentId: activeRow.parent_id } : null),
    [activeRow],
  );

  const report: Report = useCallback((next) => startTransition(() => setNotice(next)), []);

  // ---------- moving ----------

  // Shows the move at once and saves it. If the database refuses, the optimistic rows fall away
  // when the transition ends (the page wasn't revalidated), so the node goes back by itself.
  const runMove = (move: TeamMove, announce: boolean) => {
    const name = view.find((r) => r.id === move.teamId)?.name ?? "It";
    setNotice(announce ? { tone: "done", text: `${moveAnnouncement(view, move)}.` } : null);
    startSaving(async () => {
      addMove(move);
      const result = await settle(() => actions.moveNode(move), "moveNode");
      if (!result.ok) report({ tone: "error", text: `${name} wasn't moved. ${result.error}` });
    });
  };

  // The keyboard steps through the places the dragged node can go, worked out from the rows.
  const keyboard = useMemo(() => keyboardSensorOptions(view), [view]);
  const sensors = useSensors(useSensor(PointerSensor, POINTER), useSensor(KeyboardSensor, keyboard));
  const announcements = useMemo(() => structureAnnouncements(view), [view]);
  const onDragStart = ({ active }: DragStartEvent) => setActiveId(String(active.id));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const move = moveFor(view, active, over);
    // dnd-kit's live region says what happened, in the same words.
    if (move) runMove(move, false);
  };

  // ---------- dialogs ----------

  const [dialog, setDialog] = useState<EditorDialog | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Counts openings, so each one starts with a fresh dialog (no state left from the last time).
  const [opened, setOpened] = useState(0);
  // Where focus goes when the dialog closes: the control that opened it, or what the dialog
  // changed (the moved row, the new node).
  const returnFocus = useRef<string[]>([]);

  const openDialog = useCallback((next: EditorDialog) => {
    returnFocus.current =
      next.type === "create"
        ? [next.parentId ? menuButton(next.parentId) : `[data-add="${next.kind === "division" ? "division" : "unplaced"}"]`]
        : [next.type === "move" ? moveButton(next.id) : menuButton(next.id)];
    setDialog(next);
    setDialogOpen(true);
    setOpened((n) => n + 1);
  }, []);
  const closeDialog = () => setDialogOpen(false);
  const dialogProps = {
    open: dialogOpen,
    onOpenChange: setDialogOpen,
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const [first = "#structure-heading", ...rest] = returnFocus.current;
      focusSoon(first, ...rest, "#structure-heading");
    },
  };
  const finish = (text: string, focus: string[]) => {
    setNotice({ tone: "done", text });
    returnFocus.current = focus;
    closeDialog();
  };

  const dialogRow = dialog && dialog.type !== "create" ? view.find((r) => r.id === dialog.id) : undefined;

  const context = useMemo(() => ({ dragging, openDialog }), [dragging, openDialog]);

  return (
    <EditorContext value={context}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button data-add="division" onClick={() => openDialog({ type: "create", kind: "division", parentId: null })}>
            <PlusIcon />
            Add a division
          </Button>
          {saving && <span className="text-sm text-muted-foreground">Saving…</span>}
        </div>

        <div className="sticky top-2 z-20 grid gap-2 empty:hidden">
          <div role="alert" className="empty:hidden">
            {notice?.tone === "error" && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-background p-3 text-sm shadow-sm">
                <p className="flex-1 text-destructive">{notice.text}</p>
                <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice(null)}>
                  <XIcon />
                </Button>
              </div>
            )}
          </div>
          <div role="status" className="empty:hidden">
            {notice?.tone === "done" && (
              <p className="rounded-lg border bg-background p-3 text-sm shadow-sm">{notice.text}</p>
            )}
          </div>
        </div>

        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={collisionDetection}
          measuring={MEASURING}
          accessibility={{ announcements, screenReaderInstructions: { draggable: SCREEN_READER_INSTRUCTIONS } }}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          {tree.organisation && <OrganisationRow row={tree.organisation} />}
          <SortableContext id="list:divisions" items={tree.divisions.map((d) => d.row.id)} strategy={listStrategy}>
            {tree.divisions.length > 0 ? (
              <div className="grid gap-4">
                {tree.divisions.map((division) => (
                  <DivisionSection key={division.row.id} division={division} />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border p-4 text-muted-foreground">No divisions yet.</p>
            )}
          </SortableContext>
          <UnplacedSection domains={tree.unplaced} />
          <DragOverlay dropAnimation={null}>
            {activeRow && (
              <div className="flex w-fit max-w-xs items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-lg">
                <GripVerticalIcon className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">{KIND_LABELS[activeRow.kind]}</span>
                <span className="truncate">{activeRow.name}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <StrayList rows={tree.stray} />
        <ArchivedSection archived={tree.archived} rows={view} restoreNode={actions.restoreNode} report={report} />
      </div>

      {dialog?.type === "create" && (
        <NodeFormDialog
          key={opened}
          {...dialogProps}
          actions={actions}
          target={{
            mode: "create",
            kind: dialog.kind,
            parent: dialog.parentId === null ? null : (view.find((r) => r.id === dialog.parentId) ?? null),
          }}
          onDone={(text, id) => finish(text, [menuButton(id), ...returnFocus.current])}
        />
      )}
      {dialog?.type === "edit" && dialogRow && (
        <NodeFormDialog
          key={opened}
          {...dialogProps}
          actions={actions}
          target={{ mode: "edit", row: dialogRow }}
          onDone={(text, id) => finish(text, [menuButton(id)])}
        />
      )}
      {dialog?.type === "move" && dialogRow && (
        <MoveDialog
          key={opened}
          {...dialogProps}
          rows={view}
          row={dialogRow}
          onMove={(move) => {
            returnFocus.current = [moveButton(move.teamId)];
            closeDialog();
            runMove(move, true);
          }}
        />
      )}
      {dialog?.type === "archive" && dialogRow && (
        <ArchiveDialog
          key={opened}
          {...dialogProps}
          row={dialogRow}
          archiveNode={actions.archiveNode}
          onDone={(text) => finish(text, ["#archived-summary"])}
        />
      )}
    </EditorContext>
  );
}
