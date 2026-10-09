// @vitest-environment happy-dom
// What the Structure page does when people use it: refusals from the database reach the admin,
// dialogs can't be closed while saving, and codes are upper-cased as they're typed.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/admin/errors";
import type { TeamRow } from "@/lib/admin/tree";
import { button, choose, click, deferred, dialog, labelled, press, render, text, type } from "@/test/dom";
import type { StructureRow } from "./counts";
import type { StructureActions } from "./editor-context";
import { StructureEditor } from "./structure-editor";

function node(id: string, name: string, kind: TeamRow["kind"], parent_id: string | null, sort_order: number, extra: Partial<StructureRow> = {}): StructureRow {
  return {
    id,
    name,
    parent_id,
    kind,
    domain_type: null,
    division_type: null,
    code: null,
    sort_order,
    note: null,
    archived_at: null,
    members: 0,
    leads: 0,
    ...extra,
  };
}

const ROWS: StructureRow[] = [
  node("gather", "Gather", "division", null, 0),
  node("culture", "Culture", "division", null, 1),
  node("ipLab", "IP Lab", "domain", "gather", 0),
  node("ip1", "IP Lab 1", "team", "ipLab", 0, { members: 2 }),
  node("atlas", "Atlas", "domain", "culture", 0),
  node("old", "Old Lab", "domain", "gather", 1, { archived_at: "2026-10-01T02:00:00Z" }),
];

const ok = async (): Promise<ActionResult> => ({ ok: true, value: null });
function actions(changes: Partial<StructureActions> = {}): StructureActions {
  return {
    moveNode: vi.fn(ok),
    createNode: vi.fn(async () => ({ ok: true as const, value: { id: "new" } })),
    updateNode: vi.fn(ok),
    archiveNode: vi.fn(ok),
    restoreNode: vi.fn(ok),
    ...changes,
  };
}

// The node's ⋯ menu, then one of its items. (Radix opens the menu on pointer down.)
async function menu(name: string, item: string) {
  const trigger = button(`More for ${name}`);
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  const entry = [...document.querySelectorAll('[role="menuitem"]')].find((el) => text(el) === item);
  if (!entry) throw new Error(`no menu item ${item}`);
  await click(entry);
}

const banner = () => text(document.querySelector('[role="alert"]')!);

describe("StructureEditor", () => {
  it("shows the database's reason when a move is refused, and leaves the tree as it was", async () => {
    const reason = "You lead where this is going, so another admin has to move it there.";
    const moveNode = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: reason }));
    await render(<StructureEditor rows={ROWS} actions={actions({ moveNode })} />);
    await click(button("Atlas: Move to…"));
    await choose(labelled("Put it in"), "gather");
    await click(button("Move"));
    expect(moveNode).toHaveBeenCalledWith({ teamId: "atlas", parentId: "gather", index: 1 });
    expect(banner()).toBe(`Atlas wasn't moved. ${reason}`);
    expect(text(document.querySelector('[aria-label="Domains in Culture"]')!)).toContain("Atlas");
  });

  it("shows the database's reason when restoring is refused", async () => {
    const restoreNode = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: "Restore the parent first: it is archived." }));
    await render(<StructureEditor rows={ROWS} actions={actions({ restoreNode })} />);
    await click(button("Restore Old Lab"));
    expect(banner()).toBe("Old Lab wasn't restored. Restore the parent first: it is archived.");
  });

  it("keeps Archive open while archiving, then shows the database's refusal in it", async () => {
    const answer = deferred<ActionResult>();
    await render(<StructureEditor rows={ROWS} actions={actions({ archiveNode: vi.fn(() => answer.promise) })} />);
    await menu("IP Lab", "Archive…");
    await click(button("Archive"));
    expect(button("Cancel").disabled).toBe(true);
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();

    await act(async () => answer.resolve({ ok: false, error: "Archive or move the 1 active team under it first." }));
    expect(text(dialog()!)).toContain("Archive or move the 1 active team under it first.");
    await click(button("Cancel"));
    expect(dialog()).toBeNull();
  });

  it("keeps Add open while saving, then shows the refusal in the form", async () => {
    const answer = deferred<ActionResult<{ id: string }>>();
    await render(<StructureEditor rows={ROWS} actions={actions({ createNode: vi.fn(() => answer.promise) })} />);
    await click(button("Add a division"));
    await type(labelled<HTMLInputElement>("Name"), "Special Projects");
    await click(button("Add"));
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();

    await act(async () => answer.resolve({ ok: false, error: "That code is already used." }));
    expect(text(dialog()!)).toContain("That code is already used.");
  });

  it("upper-cases a code as it's typed", async () => {
    await render(<StructureEditor rows={ROWS} actions={actions()} />);
    await menu("Atlas", "Edit…");
    const code = labelled<HTMLInputElement>("Code");
    await type(code, "at.x");
    expect(code.value).toBe("AT.X");
  });
});
