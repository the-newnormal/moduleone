import type { ActionResult } from "@/lib/admin/errors";
import type { CreateNodeInput, UpdateNodeInput } from "@/lib/admin/node-fields";
import type { TeamMove } from "@/lib/admin/tree";
import type { CreatableKind } from "@/lib/admin/validate";

// The page's server actions (src/app/admin/structure/actions.ts), handed to the editor by the page.
// Calls go through settle (@/lib/admin/errors), so one that throws reads like any other failure.
export type StructureActions = {
  moveNode: (move: TeamMove) => Promise<ActionResult>;
  createNode: (input: CreateNodeInput) => Promise<ActionResult<{ id: string }>>;
  updateNode: (input: UpdateNodeInput) => Promise<ActionResult>;
  archiveNode: (id: string) => Promise<ActionResult>;
  restoreNode: (id: string) => Promise<ActionResult>;
};

// The dialogs the Structure canvas opens. One shows at a time.
export type EditorDialog =
  | { type: "create"; kind: CreatableKind; parentId: string | null }
  | { type: "edit"; id: string }
  | { type: "move"; id: string }
  | { type: "archive"; id: string };

// Each box's menu, found again after a dialog closes or the box moves (its element may have been
// re-created elsewhere on the canvas).
export const menuButton = (id: string) => `[data-node-menu="${id}"]`;
// A box itself (React Flow's wrapper, which takes focus and pans the chart to it).
export const nodeSelector = (id: string) => `.react-flow__node[data-id="${CSS.escape(id)}"]`;
