// @vitest-environment happy-dom
// What the Structure canvas does when people use it: refusals from the database reach the admin
// and the chart goes back, dialogs can't be closed while saving, codes are upper-cased as they're
// typed, and the side panel opens on a box and hands focus back when it closes.
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import type { ActionResult } from "@/lib/admin/errors";
import type { TeamRow } from "@/lib/admin/tree";
import { button, choose, click, deferred, dialog, labelled, press, render, settle, text, type } from "@/test/dom";
import type { StructureRow } from "./counts";
import type { StructureActions } from "./editor-context";
import { StructureCanvas } from "./structure-canvas";

// React Flow measures with ResizeObserver and reads the viewport's scale from DOMMatrixReadOnly.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
  } as unknown as typeof DOMMatrixReadOnly;
});

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
  node("ip1", "IP Lab 1", "team", "ipLab", 0, { members: 1 }),
  node("atlas", "Atlas", "domain", "culture", 0),
  node("old", "Old Lab", "domain", "gather", 1, { archived_at: "2026-10-01T02:00:00Z" }),
];

const MEMBERS: MemberRow[] = [
  { id: "m-ana", name: "Ana Lee", role: "member", team_id: "ip1", auth_user_id: null, login_given_by: null, login_given_at: null },
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
const TEAM_ACTIONS = {
  addMember: vi.fn(ok),
  createMember: vi.fn(ok),
  giveLogin: vi.fn(ok),
  resendInvite: vi.fn(ok),
  removeFromTeam: vi.fn(ok),
  setRole: vi.fn(ok),
  addLead: vi.fn(ok),
  removeLead: vi.fn(ok),
};

const canvas = (structure: StructureActions = actions()) =>
  render(
    <StructureCanvas
      rows={ROWS}
      members={MEMBERS}
      leads={[]}
      grants={[]}
      adminMemberId="m-admin"
      actions={structure}
      teamActions={TEAM_ACTIONS}
    />,
  );

// A box's ⋯ menu, then one of its items. (Radix opens the menu on pointer down; right after another
// menu closed, it can take a moment, so try for a little while.)
async function menu(name: string, item: string) {
  const find = () => [...document.querySelectorAll('[role="menuitem"]')].find((el) => text(el) === item);
  for (let tries = 0; tries < 10 && !find(); tries++) {
    await act(async () => {
      button(`More for ${name}`).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    });
    if (!find()) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  const entry = find();
  if (!entry) throw new Error(`no menu item ${item}`);
  await click(entry);
}

const banner = () => text(document.querySelector('[role="alert"]')!);
const box = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

describe("StructureCanvas", () => {
  it("shows the database's reason when a move is refused, and puts the box back", async () => {
    const reason = "You lead where this is going, so another admin has to move it there.";
    const moveNode = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: reason }));
    await canvas(actions({ moveNode }));
    const before = box("atlas").style.transform;
    expect(before).toMatch(/translate\(/);
    await menu("Atlas", "Move to…");
    await choose(labelled("Put it in"), "gather");
    await click(button("Move"));
    await settle();
    expect(moveNode).toHaveBeenCalledWith({ teamId: "atlas", parentId: "gather", index: 1 });
    expect(banner()).toBe(`Atlas wasn't moved. ${reason}`);
    expect(box("atlas").style.transform).toBe(before);
  });

  it("shows the database's reason when restoring is refused", async () => {
    const restoreNode = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: "Restore the parent first: it is archived." }));
    await canvas(actions({ restoreNode }));
    await click(button("Restore Old Lab"));
    expect(banner()).toBe("Old Lab wasn't restored. Restore the parent first: it is archived.");
  });

  it("keeps Archive open while archiving, then shows the database's refusal in it", async () => {
    const answer = deferred<ActionResult>();
    await canvas(actions({ archiveNode: vi.fn(() => answer.promise) }));
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
    await canvas(actions({ createNode: vi.fn(() => answer.promise) }));
    await click(button("Add a division"));
    await type(labelled<HTMLInputElement>("Name"), "Special Projects");
    await click(button("Add"));
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();

    await act(async () => answer.resolve({ ok: false, error: "That code is already used." }));
    expect(text(dialog()!)).toContain("That code is already used.");
  });

  it("upper-cases a code as it's typed", async () => {
    await canvas();
    await menu("Atlas", "Edit…");
    const code = labelled<HTMLInputElement>("Code");
    await type(code, "at.x");
    expect(code.value).toBe("AT.X");
  });

  it("opens a box's people and leads in the side panel, and Escape closes it", async () => {
    await canvas();
    await menu("IP Lab 1", "People and leads");
    const panel = document.querySelector("aside")!;
    expect(text(panel.querySelector("[data-panel-heading]")!)).toBe("IP Lab 1");
    expect(text(panel)).toContain("Ana Lee");
    await press(document.body, "Escape");
    expect(document.querySelector("aside")).toBeNull();
  });

  it("starts each box's panel afresh", async () => {
    await canvas();
    await menu("IP Lab 1", "People and leads");
    const first = document.querySelector("aside");
    await menu("Atlas", "People and leads");
    const second = document.querySelector("aside");
    expect(text(second!.querySelector("[data-panel-heading]")!)).toBe("Atlas");
    expect(second).not.toBe(first);
  });

  // Focus moves a tick after a dialog closes (Radix, then focusSoon): wait for it.
  const focused = async () => {
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    return document.activeElement as HTMLElement | null;
  };

  it("hands focus back to the panel's Edit when Edit was opened from the panel", async () => {
    await canvas();
    await menu("IP Lab 1", "People and leads");
    await click(button("Edit"));
    expect(dialog()).not.toBeNull();
    await press(dialog()!, "Escape");
    expect((await focused())?.getAttribute("data-node-menu")).toBe("panel:ip1");
  });

  it("hands focus back to a box's + when what it opened is cancelled", async () => {
    await canvas();
    await click(button("Add a domain to Gather"));
    await press(dialog()!, "Escape");
    expect((await focused())?.getAttribute("data-add-under")).toBe("gather");
  });

  it("focuses the box itself after Move to…, so the chart pans to where it went", async () => {
    await canvas();
    await menu("Atlas", "Move to…");
    await choose(labelled("Put it in"), "gather");
    await click(button("Move"));
    expect((await focused())?.getAttribute("data-id")).toBe("atlas");
  });

  it("closes the panel on Escape from a box's ⋯ too", async () => {
    await canvas();
    await menu("IP Lab 1", "People and leads");
    await press(button("More for Atlas"), "Escape");
    expect(document.querySelector("aside")).toBeNull();
  });

  it("leaves the panel open when something above it already handled the Escape (a menu closing)", async () => {
    await canvas();
    await menu("IP Lab 1", "People and leads");
    const handled = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", handled, true);
    try {
      await press(document.body, "Escape");
    } finally {
      document.removeEventListener("keydown", handled, true);
    }
    expect(document.querySelector("aside")).not.toBeNull();
  });

  it("tells screen readers what Enter does on a box and on a person", async () => {
    await canvas();
    const described = box("atlas").getAttribute("aria-describedby")!;
    expect(text(document.getElementById(described)!)).toBe(
      "Press Enter or Space for its people and leads. Its menu edits, adds under or moves it.",
    );
    expect(text(document.getElementById("canvas-person-hint")!)).toContain("Drag them onto a box to move them there.");
  });
});
