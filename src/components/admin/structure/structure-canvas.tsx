"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type NodeChange,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type XYPosition,
} from "@xyflow/react";
import { MoveIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import {
  buildNoTeamPeople,
  buildTeamView,
  type GrantRow,
  type LeadRow,
  type LoginStates,
  type MemberRow,
  removeDescription,
} from "@/app/admin/teams/[id]/team-view";
import { focusSoon } from "@/components/admin/focus";
import type { TeamActions } from "@/components/admin/team/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { settle } from "@/lib/admin/errors";
import { applyMove, buildTree, moveAnnouncement, type TeamMove } from "@/lib/admin/tree";
import { ArchivedSection, type Report } from "./archived-list";
import { type Dragged, type DropPlan, type PlacePlan, placeAction, planDrop } from "./canvas-drop";
import { canvasPeopleOf, itemAt, layoutStructure, NO_TEAM_ID, personNodeId } from "./canvas-layout";
import { CanvasContext, type CanvasNode, dragging, flowNodes, NODE_TYPES, PERSON_HINT_ID } from "./canvas-nodes";
import type { StructureRow } from "./counts";
import { type EditorDialog, menuButton, nodeSelector, type StructureActions } from "./editor-context";
import { NoTeamPanel } from "./no-team-panel";
import { NodePanel } from "./node-panel";
import { ArchiveDialog, MoveDialog, NodeFormDialog } from "./node-dialogs";

type Notice = { tone: "done" | "error"; text: string } | null;

type Props = {
  rows: StructureRow[]; // every teams row, with its counts
  members: MemberRow[];
  leads: LeadRow[];
  grants: GrantRow[];
  logins?: LoginStates; // whether each login has been used; null if it couldn't be read
  adminMemberId: string;
  actions: StructureActions;
  teamActions: Omit<TeamActions, "updateNode">;
};

// The Structure page: the organisation as a top-down chart (canvas-layout). Drag a box onto
// another to move it there (canvas-drop), or use its menu's Move to…; click a box (or press Enter
// on it) for its people and leads in a side panel. "Show people" puts everyone on the chart under
// the node they sit in; drag a person onto another box to move them. Moves show at once and roll
// back if the database refuses, with its reason; every write re-renders the page from the server.
export function StructureCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

// (React Flow reads "keyboardDisabled" while keyboard use is on, and "default" when it's off; the
// names are the other way round upstream. Both say the same here.)
const NODE_HINT = "Press Enter or Space for its people and leads. Its menu edits, adds under or moves it.";
const ARIA = {
  "node.a11yDescription.default": NODE_HINT,
  "node.a11yDescription.keyboardDisabled": NODE_HINT,
  // Arrow keys don't move boxes here (they'd only move the drawing): say nothing.
  "node.a11yDescription.ariaLiveMessage": () => "",
};

// Which handles each kind of edge joins (canvas-nodes' Ends).
const HANDLES = {
  row: { sourceHandle: "bottom", targetHandle: "top" },
  column: { sourceHandle: "trunk", targetHandle: "left" },
  people: { sourceHandle: "right", targetHandle: "left" },
} as const;

function Canvas({ rows, members, leads, grants, logins = null, adminMemberId, actions, teamActions }: Props) {
  const flow = useReactFlow();
  const [view, addMove] = useOptimistic(rows, (current: StructureRow[], move: TeamMove) => applyMove(current, move));
  const [people, addPlace] = useOptimistic(members, (current: MemberRow[], place: { memberId: string; to: string | null }) =>
    current.map((m) => (m.id === place.memberId ? { ...m, team_id: place.to } : m)),
  );
  const tree = useMemo(() => buildTree(view), [view]);
  const [saving, startSaving] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const report: Report = useCallback((next) => startTransition(() => setNotice(next)), []);

  // ---------- what's drawn ----------

  const [showPeople, setShowPeople] = useState(false);
  const canvasPeople = useMemo(
    () => (showPeople ? canvasPeopleOf(people, view, adminMemberId) : null),
    [showPeople, people, view, adminMemberId],
  );
  const layout = useMemo(() => layoutStructure(tree, canvasPeople), [tree, canvasPeople]);

  // Opens on the top-left of the chart at a readable size: the whole chart if it fits at 60% or
  // more, else as much as fits at 60% (pan, zoom out or press Fit for the rest). Again when people
  // are shown or hidden, as the chart changes size.
  const pane = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const box = pane.current;
    if (!ready || !box || layout.items.length === 0) return;
    const minX = Math.min(...layout.items.map((i) => i.x));
    const minY = Math.min(...layout.items.map((i) => i.y));
    const maxX = Math.max(...layout.items.map((i) => i.x + i.width));
    const maxY = Math.max(...layout.items.map((i) => i.y + i.height));
    const pad = 32;
    const fit = Math.min((box.clientWidth - pad * 2) / (maxX - minX), (box.clientHeight - pad * 2) / (maxY - minY));
    const zoom = Math.min(1, Math.max(0.6, fit));
    flow.setViewport({ x: pad - minX * zoom, y: pad - minY * zoom, zoom });
    // Only when the chart's shape changes, not on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, showPeople]);

  // ---------- the side panel ----------

  // A node's id, or NO_TEAM_ID for everyone with no team.
  const [panelId, setPanelId] = useState<string | null>(null);
  const panel = useMemo(
    () =>
      panelId === null || panelId === NO_TEAM_ID
        ? null
        : buildTeamView({ teamId: panelId, adminMemberId, teams: view, members: people, leads, grants, logins }),
    [panelId, adminMemberId, view, people, leads, grants, logins],
  );
  const noTeam = useMemo(
    () =>
      panelId === NO_TEAM_ID
        ? buildNoTeamPeople({ adminMemberId, teams: view, members: people, leads, grants, logins })
        : null,
    [panelId, adminMemberId, view, people, leads, grants, logins],
  );
  const noTeamCount = useMemo(() => people.filter((m) => m.team_id === null && m.removed_at === null).length, [people]);
  const openPanel = useCallback((id: string) => {
    setPanelId(id);
    focusSoon("[data-panel-heading]");
  }, []);
  const closePanel = useCallback(() => {
    const id = panelId;
    setPanelId(null);
    if (id === NO_TEAM_ID) focusSoon("[data-no-team-button]", "#structure-heading");
    else if (id) focusSoon(nodeSelector(id), "#structure-heading");
  }, [panelId]);

  // ---------- moving ----------

  // Shows the move at once and saves it. If the database refuses, the optimistic rows fall away
  // when the transition ends (the page wasn't revalidated), so the box goes back by itself.
  const runMove = (move: TeamMove) => {
    const name = view.find((r) => r.id === move.teamId)?.name ?? "It";
    setNotice({ tone: "done", text: `${moveAnnouncement(view, move)}.` });
    startSaving(async () => {
      addMove(move);
      const result = await settle(() => actions.moveNode(move), "moveNode");
      if (!result.ok) report({ tone: "error", text: `${name} wasn't moved. ${result.error}` });
    });
  };

  const runPlace = (plan: PlacePlan) => {
    const name = people.find((m) => m.id === plan.memberId)?.name ?? "They";
    const to = plan.to === null ? null : view.find((r) => r.id === plan.to);
    const lead = plan.leads && to ? ` They lead ${to.name} now.` : "";
    setNotice({ tone: "done", text: to ? `Moved ${name} to ${to.name}.${lead}` : `${name} is in no team now.` });
    startSaving(async () => {
      addPlace({ memberId: plan.memberId, to: plan.to });
      const { run, context } = placeAction(plan, teamActions);
      const result = await settle(run, context);
      if (!result.ok) report({ tone: "error", text: `${name} wasn't moved. ${result.error}` });
    });
  };

  // A person dropped somewhere: moving them out of a team (or making them a leader) asks first, as
  // the team page does; someone with no team goes straight in.
  const [confirming, setConfirming] = useState<PlacePlan | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const place = (plan: PlacePlan) => {
    if (plan.from === null && !plan.leads) return runPlace(plan);
    setConfirming(plan);
    setConfirmOpen(true);
  };
  const confirmText = useMemo(() => {
    if (!confirming) return null;
    const name = people.find((m) => m.id === confirming.memberId)?.name ?? "this person";
    const from = confirming.from === null ? null : view.find((r) => r.id === confirming.from);
    const to = confirming.to === null ? null : view.find((r) => r.id === confirming.to);
    if (!to) {
      // Out of every team: the team page's wording for Remove from team.
      const fromView = from && buildTeamView({ teamId: from.id, adminMemberId, teams: view, members: people, leads, grants });
      const person = fromView?.people.find((p) => p.id === confirming.memberId);
      return {
        title: `Take ${name} out of ${from?.name ?? "their team"}?`,
        body: fromView && person ? removeDescription(person, fromView.team) : `${name} stays in Module One without a team.`,
        action: "Take out",
      };
    }
    const leadsNote = confirming.leads
      ? ` Everyone placed in a ${to.kind} leads it, so they'll be a leader of ${to.name} (and stay a leader if they move again).`
      : "";
    return {
      title: from ? `Move ${name} from ${from.name} to ${to.name}?` : `Move ${name} to ${to.name}?`,
      body: `${from ? `People are in one team at a time. Their past check-ins stay with ${from.name}.` : ""}${leadsNote}`.trim(),
      action: "Move",
    };
  }, [confirming, people, view, adminMemberId, leads, grants]);

  // The box being dragged, where it is now, and what dropping it there would do.
  const [drag, setDrag] = useState<{ id: string; position: XYPosition; over: string | null; plan: DropPlan | null } | null>(null);

  const draggedOf = (id: string): Dragged | null => {
    const item = layout.items.find((i) => i.id === id);
    if (item?.type === "person") return { type: "person", person: item.person };
    if (item?.type === "node") return { type: "node", id };
    return null;
  };

  // The box under the pointer, or null when what's on top there isn't the chart itself (off the
  // chart, the side panel, the minimap or zoom buttons, the notices): a drop only lands where it can
  // be seen. (Release off the chart to drop nowhere.)
  const targetAt = (event: MouseEvent | TouchEvent, skip: string) => {
    const at = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!at) return null;
    const { clientX: x, clientY: y } = at;
    const top = document.elementFromPoint(x, y);
    if (!top?.closest(".react-flow") || top.closest(".react-flow__panel")) return null;
    return itemAt(layout.items, flow.screenToFlowPosition({ x, y }), skip);
  };

  // Escape during a drag cancels it: the box goes back and dropping it does nothing.
  const cancelled = useRef(false);
  const inDrag = drag !== null;
  useEffect(() => {
    if (!inDrag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Before the side panel's own Escape (a window listener too): this one only cancels the drag.
      event.stopPropagation();
      cancelled.current = true;
      setDrag(null);
      setNotice({ tone: "done", text: "Move cancelled." });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inDrag]);

  const onNodeDragStart: OnNodeDrag<CanvasNode> = () => {
    cancelled.current = false;
    setDrag(null);
  };

  const onNodeDrag: OnNodeDrag<CanvasNode> = (event, node) => {
    const dragged = draggedOf(node.id);
    if (!dragged || cancelled.current) return;
    const target = targetAt(event as unknown as MouseEvent | TouchEvent, node.id);
    // Over someone, their stack rings: it's what takes the drop.
    const over = target?.type === "person" ? target.stack : (target?.id ?? null);
    setDrag({ id: node.id, position: node.position, over, plan: planDrop(view, layout.items, dragged, target) });
  };

  const onNodeDragStop: OnNodeDrag<CanvasNode> = (event, node) => {
    const dragged = draggedOf(node.id);
    setDrag(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (!dragged) return;
    const plan = planDrop(view, layout.items, dragged, targetAt(event as unknown as MouseEvent | TouchEvent, node.id));
    if (plan?.type === "move") {
      runMove(plan.move);
      // Where it went may be off the chart's view: focusing it pans there.
      focusSoon(nodeSelector(plan.move.teamId));
    }
    else if (plan?.type === "place") place(plan);
    else if (plan?.type === "refuse") report({ tone: "error", text: plan.label });
  };

  // Positions come from the layout; only a drag in progress moves a box (arrow keys don't). A drag
  // that ends without a drop (React Flow gave up on it) puts the box back.
  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.dragging && change.position && !cancelled.current) {
        const position = change.position;
        setDrag((d) => (d?.id === change.id ? { ...d, position } : { id: change.id, position, over: null, plan: null }));
      }
      if (change.type === "position" && change.dragging === false) {
        setDrag((d) => (d?.id === change.id ? null : d));
      }
      if (change.type === "select" && change.selected) {
        const item = layout.items.find((i) => i.id === change.id);
        if (item?.type === "node") openPanel(item.id);
        if (item?.type === "person") openPanel(item.person.teamId ?? NO_TEAM_ID);
      }
    }
  };

  // ---------- nodes and edges ----------

  // Built once per layout; a drag swaps in only the box being dragged, so the others don't redraw.
  const placed = useMemo(() => flowNodes(layout.items, { dragged: null, selectedId: panelId }), [layout, panelId]);
  const nodes = useMemo(
    () => (drag ? placed.map((n) => (n.id === drag.id ? dragging(n, drag.position) : n)) : placed),
    [placed, drag],
  );
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...HANDLES[e.kind],
        type: "smoothstep",
        pathOptions: { borderRadius: 8, offset: 12 },
        selectable: false,
        focusable: false,
        style: e.kind === "people" ? { strokeDasharray: "4 4" } : undefined,
      })),
    [layout],
  );

  // ---------- dialogs ----------

  const [dialog, setDialog] = useState<EditorDialog | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [opened, setOpened] = useState(0);
  const returnFocus = useRef<string[]>([]);

  const openDialog = useCallback((next: EditorDialog, returnTo?: string[]) => {
    returnFocus.current =
      returnTo ??
      (next.type === "create"
        ? [next.parentId ? menuButton(next.parentId) : `[data-add="${next.kind === "division" ? "division" : "unplaced"}"]`]
        : [menuButton(next.id)]);
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

  // Changes only when the box under a drag does, not on every pointer move.
  const overId = drag?.over ?? null;
  const overOk = drag?.plan?.type === "move" || drag?.plan?.type === "place";
  const context = useMemo(
    () => ({ openDialog, openPanel, over: overId ? { id: overId, ok: overOk } : null }),
    [openDialog, openPanel, overId, overOk],
  );

  return (
    <CanvasContext value={context}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button data-add="division" onClick={() => openDialog({ type: "create", kind: "division", parentId: null })}>
            <PlusIcon />
            Add a division
          </Button>
          <Button variant="outline" onClick={() => setShowPeople((on) => !on)}>
            <UsersIcon />
            {showPeople ? "Hide people" : "Show people"}
          </Button>
          <Button variant="outline" data-no-team-button onClick={() => openPanel(NO_TEAM_ID)}>
            No team ({noTeamCount})
          </Button>
          {saving && <span className="text-sm text-muted-foreground">Saving…</span>}
          {drag?.plan && (
            <span
              className={`flex items-center gap-1.5 text-sm ${drag.plan.type === "refuse" ? "text-destructive" : "text-muted-foreground"}`}
            >
              <MoveIcon aria-hidden className="size-4" />
              {drag.plan.label}
            </span>
          )}
        </div>

        <div className="sticky top-[calc(var(--app-bar-h)+0.5rem)] z-20 grid gap-2 empty:hidden">
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
            {notice?.tone === "done" && <p className="rounded-lg border bg-background p-3 text-sm shadow-sm">{notice.text}</p>}
          </div>
        </div>

        <div ref={pane} className="relative h-[75vh] min-h-[32rem] overflow-hidden rounded-xl border bg-muted/30">
          <ReactFlow<CanvasNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onPaneClick={() => panelId && closePanel()}
            nodesConnectable={false}
            selectNodesOnDrag={false}
            deleteKeyCode={null}
            multiSelectionKeyCode={null}
            selectionKeyCode={null}
            nodeDragThreshold={4}
            // The page scrolls as usual over the chart: zoom with Ctrl and the wheel, a pinch, or the
            // buttons; drag the background to pan.
            zoomOnScroll={false}
            preventScrolling={false}
            zoomActivationKeyCode="Control"
            onInit={() => setReady(true)}
            fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
            minZoom={0.15}
            maxZoom={1.5}
            ariaLabelConfig={ARIA}
            aria-label="Organisation chart"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable ariaLabel="Overview of the chart" className="!hidden sm:!block" />
          </ReactFlow>
          {noTeam && <NoTeamPanel people={noTeam} actions={teamActions} onClose={closePanel} />}
          {panel && (
            <NodePanel
              key={panel.team.id}
              view={panel}
              actions={teamActions}
              onEdit={() =>
                openDialog({ type: "edit", id: panel.team.id }, [`[data-node-menu="panel:${panel.team.id}"]`, menuButton(panel.team.id)])
              }
              onClose={closePanel}
            />
          )}
          <p id={PERSON_HINT_ID} hidden>
            Press Enter or Space for their team&apos;s people and leads (or, for someone with no team, everyone with
            no team). Drag them onto a box to move them there.
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          Drag a box onto another to move it there: a team into a domain, a domain into a division or Unplaced, or onto a
          box of its own kind to take its place. Every box&apos;s menu has Move to… too.
          {showPeople && " Drag a person onto a box to move them into it, or into No team."}
        </p>

        {tree.stray.length > 0 && (
          <section aria-labelledby="stray-heading" className="grid gap-2 rounded-xl border border-destructive/40 p-3 sm:p-4">
            <h2 id="stray-heading" className="text-2xl">
              Not in the tree
            </h2>
            <p className="text-sm text-muted-foreground">
              These sit somewhere the chart can&apos;t show, with their people. Use Move to… to put each one in
              its place.
            </p>
            <ul className="grid gap-1">
              {tree.stray.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <Button variant="ghost" size="sm" data-node-menu={row.id} onClick={() => openDialog({ type: "move", id: row.id })}>
                    <span className="sr-only">{row.name}: </span>Move to…
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openPanel(row.id)}>
                    <span className="sr-only">{row.name}: </span>People and leads
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
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
          onDone={(text, id) => finish(text, [nodeSelector(id), ...returnFocus.current])}
        />
      )}
      {dialog?.type === "edit" && dialogRow && (
        <NodeFormDialog
          key={opened}
          {...dialogProps}
          actions={actions}
          target={{ mode: "edit", row: dialogRow }}
          onDone={(text) => finish(text, returnFocus.current)}
        />
      )}
      {dialog?.type === "move" && dialogRow && (
        <MoveDialog
          key={opened}
          {...dialogProps}
          rows={view}
          row={dialogRow}
          onMove={(move) => {
            // The box itself first: focusing it pans the chart to where it went.
            returnFocus.current = [nodeSelector(move.teamId), menuButton(move.teamId)];
            closeDialog();
            runMove(move);
          }}
        />
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (confirming) focusSoon(nodeSelector(personNodeId(confirming.memberId)), "#structure-heading");
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText?.title}</AlertDialogTitle>
            {confirmText?.body && <AlertDialogDescription>{confirmText.body}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && runPlace(confirming)}>{confirmText?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {dialog?.type === "archive" && dialogRow && (
        <ArchiveDialog
          key={opened}
          {...dialogProps}
          row={dialogRow}
          archiveNode={actions.archiveNode}
          onDone={(text) => {
            if (panelId === dialogRow.id) setPanelId(null);
            finish(text, ["#archived-summary"]);
          }}
        />
      )}
    </CanvasContext>
  );
}
