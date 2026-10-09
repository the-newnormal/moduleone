import { createContext, useContext } from "react";
import type { ActionResult } from "@/lib/admin/errors";
import type { CreateNodeInput, UpdateNodeInput } from "@/lib/admin/node-fields";
import type { TeamMove } from "@/lib/admin/tree";
import type { TeamKind } from "@/lib/admin/validate";
import type { Dragging } from "./drag";

// The page's server actions (src/app/admin/structure/actions.ts), handed to the editor by the page.
// Calls go through settle (@/lib/admin/errors), so one that throws reads like any other failure.
export type StructureActions = {
  moveNode: (move: TeamMove) => Promise<ActionResult>;
  createNode: (input: CreateNodeInput) => Promise<ActionResult<{ id: string }>>;
  updateNode: (input: UpdateNodeInput) => Promise<ActionResult>;
  archiveNode: (id: string) => Promise<ActionResult>;
  restoreNode: (id: string) => Promise<ActionResult>;
};

// The dialogs the Structure editor opens. One shows at a time.
export type EditorDialog =
  | { type: "create"; kind: TeamKind; parentId: string | null }
  | { type: "edit"; id: string }
  | { type: "move"; id: string }
  | { type: "archive"; id: string };

// What's being dragged: its kind, so only places that take it are offered, and its parent, so a
// row can tell a drag from its own list from one coming from another list.
export type DragInfo = Dragging;

export type EditorContextValue = {
  dragging: DragInfo;
  openDialog: (dialog: EditorDialog) => void;
};

export const EditorContext = createContext<EditorContextValue>({ dragging: null, openDialog: () => {} });

export const useEditor = () => useContext(EditorContext);

// Each row's controls, found again after a dialog closes or the row moves (its element may have
// been re-created elsewhere in the tree).
export const moveButton = (id: string) => `[data-node-move="${id}"]`;
export const menuButton = (id: string) => `[data-node-menu="${id}"]`;
