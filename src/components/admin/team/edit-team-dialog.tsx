"use client";

import { useState } from "react";
import type { TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { NodeFieldsForm } from "@/components/admin/node-fields-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { nodeToForm } from "@/lib/admin/node-fields";
import type { TeamActions } from "./types";

type Props = {
  team: TeamSummary;
  updateNode: TeamActions["updateNode"];
};

// "Edit" next to the team's name: name, code, a domain's type, and note, in the same form the
// Structure page uses. (Its place in the tree changes on the Structure page.) Screen readers hear
// "Saved <name>." afterwards, as on the Structure page.
export function EditTeamDialog({ team, updateNode }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" onClick={() => setStatus("")}>
            Edit<span className="sr-only"> ({team.name})</span>
          </Button>
        </DialogTrigger>
        <DialogContent>
          <EditTeamForm
            team={team}
            updateNode={updateNode}
            onPendingChange={setBusy}
            onSaved={(name) => {
              setStatus(`Saved ${name}.`);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
      <p role="status" className="sr-only">
        {status}
      </p>
    </>
  );
}

// The dialog's content (exported for tests). Its state resets each time the dialog opens.
export function EditTeamForm({
  team,
  updateNode,
  onPendingChange,
  onSaved,
}: Props & { onPendingChange?: (pending: boolean) => void; onSaved: (name: string) => void }) {
  const saved = nodeToForm({ ...team, domain_type: team.domainType, division_type: null });
  return (
    <NodeFieldsForm
      kind={team.kind}
      saved={saved}
      editing
      title={`Edit ${team.name}`}
      description={`It stays a ${team.kindLabel.toLowerCase()}. To move it, use the Structure page.`}
      context="updateNode"
      save={(form) => updateNode({ ...form, id: team.id })}
      onSaved={(_, name) => onSaved(name)}
      onPendingChange={onPendingChange}
    />
  );
}
