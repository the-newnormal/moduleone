"use client";

import { ArchiveRestoreIcon } from "lucide-react";
import { useTransition } from "react";
import { focusSoon } from "@/components/admin/focus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { settle } from "@/lib/admin/errors";
import { formatDate } from "@/lib/admin/format";
import { breadcrumb, KIND_LABELS } from "@/lib/admin/tree";
import type { StructureRow } from "./counts";
import type { StructureActions } from "./editor-context";

export type Report = (notice: { tone: "done" | "error"; text: string }) => void;

// Where an archived node sat: its parents' names, top first ("Gather › IP Lab"), marking the ones
// archived too (restore those first).
function where(row: StructureRow, rows: readonly StructureRow[]): string {
  const parents = breadcrumb(row.id, rows).slice(0, -1);
  if (parents.length === 0) return row.kind === "division" ? "the top level" : "Unplaced";
  return parents.map((p) => (p.archived_at ? `${p.name} (archived)` : p.name)).join(" › ");
}

type Restore = StructureActions["restoreNode"];

function ArchivedItem({
  row,
  rows,
  restoreNode,
  report,
}: {
  row: StructureRow;
  rows: readonly StructureRow[];
  restoreNode: Restore;
  report: Report;
}) {
  const [pending, startRestoring] = useTransition();
  const archivedOn = formatDate(row.archived_at);

  const restore = () =>
    startRestoring(async () => {
      const result = await settle(() => restoreNode(row.id), "restoreNode");
      if (result.ok) {
        report({ tone: "done", text: `Restored ${row.name}. It's back in the tree.` });
        // Its row here goes away; stay in the list, so restoring several is quick.
        focusSoon("#archived-summary");
      } else {
        report({ tone: "error", text: `${row.name} wasn't restored. ${result.error}` });
      }
    });

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
      <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium break-words">{row.name}</span>
          {row.code && <code className="font-mono text-xs text-muted-foreground">{row.code}</code>}
          <Badge variant="outline">{KIND_LABELS[row.kind]}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Was in {where(row, rows)}
          {archivedOn && <>. Archived {archivedOn}</>}.
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={pending} onClick={restore}>
        <ArchiveRestoreIcon />
        {pending ? "Restoring…" : <>Restore<span className="sr-only"> {row.name}</span></>}
      </Button>
    </li>
  );
}

// Archived nodes, out of the tree, collapsed until opened. Restoring puts a node back where it
// was; the database refuses while its parent is archived, and says so.
export function ArchivedSection({
  archived,
  rows,
  restoreNode,
  report,
}: {
  archived: StructureRow[];
  rows: readonly StructureRow[];
  restoreNode: Restore;
  report: Report;
}) {
  return (
    <details className="group rounded-xl border p-3 sm:p-4">
      <summary id="archived-summary" className="cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <h2 className="inline text-2xl">Archived</h2>{" "}
        <span className="text-muted-foreground">({archived.length})</span>
      </summary>
      <div className="mt-3 grid gap-2">
        <p className="text-sm text-muted-foreground">
          Archived divisions, domains and teams keep their check-ins and leads. Restore one to put it
          back in the tree; if its parent is archived too, restore the parent first.
        </p>
        {archived.length > 0 ? (
          <ul className="grid">
            {archived.map((row) => (
              <ArchivedItem key={row.id} row={row} rows={rows} restoreNode={restoreNode} report={report} />
            ))}
          </ul>
        ) : (
          <p className="text-sm">Nothing is archived.</p>
        )}
      </div>
    </details>
  );
}
