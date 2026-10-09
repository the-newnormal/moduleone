"use client";

import { startTransition, useId, useMemo, useState, useTransition } from "react";
import { ActionError } from "@/components/admin/action-error";
import { NodeFieldsForm } from "@/components/admin/node-fields-form";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settle } from "@/lib/admin/errors";
import { EMPTY_NODE_FORM, nodeToForm } from "@/lib/admin/node-fields";
import { KIND_LABELS, moveOptions, type TeamMove } from "@/lib/admin/tree";
import type { TeamKind } from "@/lib/admin/validate";
import type { StructureRow } from "./counts";
import type { StructureActions } from "./editor-context";

// Every dialog is controlled by the editor, which also decides where focus goes once it closes
// (the row may have moved, or been archived).
type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
};

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

// ---------- add and edit ----------

export type NodeFormTarget =
  | { mode: "create"; kind: TeamKind; parent: StructureRow | null }
  | { mode: "edit"; row: StructureRow };

function formTitle(target: NodeFormTarget): { title: string; description: string } {
  if (target.mode === "edit") {
    if (target.row.kind === "organisation") {
      return { title: `Edit ${target.row.name}`, description: "It stays above every division." };
    }
    const kind = KIND_LABELS[target.row.kind].toLowerCase();
    return {
      title: `Edit ${target.row.name}`,
      description: `It stays ${article(kind)} ${kind}. To move it, drag it or use Move to….`,
    };
  }
  const { kind, parent } = target;
  if (kind === "division") return { title: "Add a division", description: "It goes after the other divisions." };
  if (parent === null) {
    return {
      title: "Add an unplaced domain",
      description: "It goes in Unplaced, after the domains there. Move it into a division when you're ready.",
    };
  }
  return { title: `Add ${article(kind)} ${kind} to ${parent.name}`, description: `It goes last in ${parent.name}.` };
}

// Add or edit a node, with the form both admin pages share. `onDone` gets the sentence to show and
// the id of the node to focus afterwards.
export function NodeFormDialog({
  target,
  actions,
  onDone,
  ...dialog
}: DialogProps & {
  target: NodeFormTarget;
  actions: Pick<StructureActions, "createNode" | "updateNode">;
  onDone: (message: string, focusId: string) => void;
}) {
  // Stays open while saving, so a refusal has somewhere to show.
  const [busy, setBusy] = useState(false);
  const { title, description } = formTitle(target);
  const shared = { title, description, onPendingChange: setBusy };

  return (
    <Dialog open={dialog.open} onOpenChange={(open) => !busy && dialog.onOpenChange(open)}>
      <DialogContent onCloseAutoFocus={dialog.onCloseAutoFocus}>
        {target.mode === "edit" ? (
          <NodeFieldsForm
            {...shared}
            kind={target.row.kind}
            saved={nodeToForm(target.row)}
            editing
            context="updateNode"
            save={(form) => actions.updateNode({ ...form, id: target.row.id })}
            onSaved={(_, name) => onDone(`Saved ${name}.`, target.row.id)}
          />
        ) : (
          <NodeFieldsForm
            {...shared}
            kind={target.kind}
            saved={EMPTY_NODE_FORM}
            editing={false}
            context="createNode"
            save={(form) => actions.createNode({ ...form, kind: target.kind, parentId: target.parent?.id ?? null })}
            onSaved={({ id }, name) =>
              onDone(
                target.kind === "division"
                  ? `Added the division ${name}.`
                  : `Added ${name} to ${target.parent?.name ?? "Unplaced"}.`,
                id,
              )
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- move to… ----------

const parentKey = (parentId: string | null) => parentId ?? "top";

// The accessible fallback for dragging: pick the parent, then the position among what's shown
// there. moveOptions works out admin_move_team's index for each choice.
export function MoveDialog({
  rows,
  row,
  onMove,
  ...dialog
}: DialogProps & { rows: readonly StructureRow[]; row: StructureRow; onMove: (move: TeamMove) => void }) {
  const id = useId();
  const options = useMemo(() => moveOptions(rows, row.id), [rows, row.id]);
  const current = options.find((o) => o.current) ?? options[0];
  const defaultIndex = (option: (typeof options)[number] | undefined) =>
    (option?.positions.find((p) => p.current) ?? option?.positions.at(-1))?.index ?? 0;

  const [chosenParent, setChosenParent] = useState(() => parentKey(current?.parentId ?? null));
  const [chosenIndex, setChosenIndex] = useState(() => defaultIndex(current));
  const option = options.find((o) => parentKey(o.parentId) === chosenParent) ?? current;
  const position = option?.positions.find((p) => p.index === chosenIndex) ?? option?.positions.at(-1);
  const unchanged = !option || !position || (option.current && position.current);
  const kind = KIND_LABELS[row.kind].toLowerCase();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (unchanged) return;
    onMove({ teamId: row.id, parentId: option.parentId, index: position.index });
  };

  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogContent onCloseAutoFocus={dialog.onCloseAutoFocus}>
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Move {row.name}</DialogTitle>
            <DialogDescription>
              Choose where the {kind} goes. Dragging it by its handle does the same.
            </DialogDescription>
          </DialogHeader>

          {!option ? (
            <p className="text-sm">This {kind} can&apos;t be moved right now. Reload the page and try again.</p>
          ) : (
            <>
              {options.length > 1 && (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-parent`}>{row.kind === "team" ? "Domain" : "Put it in"}</Label>
                  <Select
                    value={parentKey(option.parentId)}
                    onValueChange={(value) => {
                      setChosenParent(value);
                      setChosenIndex(defaultIndex(options.find((o) => parentKey(o.parentId) === value)));
                    }}
                  >
                    <SelectTrigger id={`${id}-parent`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((o) => (
                        <SelectItem key={parentKey(o.parentId)} value={parentKey(o.parentId)}>
                          {o.label}
                          {o.current && " (now)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-position`}>Position</Label>
                {/* Keyed by the parent, so it starts afresh with that parent's positions: changing the
                    value and the options of a mounted Select in one render makes Radix's hidden
                    native select report a missing option, and the position would fall back to First. */}
                <Select
                  key={parentKey(option.parentId)}
                  value={String(position?.index)}
                  onValueChange={(value) => setChosenIndex(Number(value))}
                >
                  <SelectTrigger id={`${id}-position`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {option.positions.map((p) => (
                      <SelectItem key={p.index} value={String(p.index)}>
                        {p.label}
                        {p.current && " (now)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={unchanged}>
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- archive ----------

// Asks first, then archives. The database refuses while anything active or anyone is still in
// the node; its sentence shows here, so the dialog can't be closed while archiving.
export function ArchiveDialog({
  row,
  archiveNode,
  onDone,
  ...dialog
}: DialogProps & { row: StructureRow; archiveNode: StructureActions["archiveNode"]; onDone: (message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startArchiving] = useTransition();
  const kind = KIND_LABELS[row.kind].toLowerCase();

  const archive = () =>
    startArchiving(async () => {
      const result = await settle(() => archiveNode(row.id), "archiveNode");
      startTransition(() => {
        if (result.ok) onDone(`Archived ${row.name}. It's listed under Archived.`);
        else setError(result.error);
      });
    });

  return (
    <AlertDialog open={dialog.open} onOpenChange={(open) => !pending && dialog.onOpenChange(open)}>
      <AlertDialogContent onCloseAutoFocus={dialog.onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {row.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The {kind} leaves the tree and is listed under Archived, where you can restore it. Its check-ins
            and leads are kept. It can only be archived once nothing active and nobody is left in it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ActionError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={archive}>
            {pending ? "Archiving…" : "Archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
