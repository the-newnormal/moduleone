// @vitest-environment happy-dom
// What the Structure canvas does when people use it: refusals from the database reach the admin
// and the chart goes back, dialogs can't be closed while saving, codes are upper-cased as they're
// typed, and the side panel opens on a box and hands focus back when it closes.
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import type { ActionResult } from "@/lib/admin/errors";
import type { TeamRow } from "@/lib/admin/tree";
import { button, choose, click, deferred, dialog, labelled, press, queryButton, render, settle, text, type } from "@/test/dom";
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
    leader_title: null,
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
  { id: "m-ana", name: "Ana Lee", role: "member", team_id: "ip1", auth_user_id: null, login_given_by: null, login_given_at: null, login_email_changed_by: null, login_email_changed_at: null, removed_at: null },
];
const member = (id: string, name: string, team_id: string | null, extra: Partial<MemberRow> = {}): MemberRow => ({
  ...MEMBERS[0],
  id,
  name,
  team_id,
  ...extra,
});
// Ana sits in IP Lab 1; Ben and Hana (a Master Admin) sit nowhere; Olga was removed from Module One.
const WITH_NO_TEAM: MemberRow[] = [
  ...MEMBERS,
  member("m-ben", "Ben Kho", null, { auth_user_id: "u-ben" }),
  member("m-hana", "Hana Lim", null, { role: "hq", auth_user_id: "u-hana" }),
  member("m-olga", "Olga Day", null, { removed_at: "2026-10-08T02:00:00Z" }),
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
  changeEmail: vi.fn(async () => ({ ok: true as const, value: { invited: false } })),
  removePerson: vi.fn(async () => ({ ok: true as const, value: { outcome: "removed" as const, loginKept: false } })),
};

const page = (structure: StructureActions = actions(), members = MEMBERS, teamActions = TEAM_ACTIONS) => (
  <StructureCanvas
    rows={ROWS}
    members={members}
    leads={[]}
    grants={[]}
    adminMemberId="m-admin"
    actions={structure}
    teamActions={teamActions}
  />
);
const canvas = (structure: StructureActions = actions(), members = MEMBERS, teamActions = TEAM_ACTIONS) =>
  render(page(structure, members, teamActions));

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

  const panelHeading = () => document.querySelector<HTMLElement>("aside [data-panel-heading]");

  it("counts everyone with no team on No team, and opens them in the side panel with focus on its heading", async () => {
    await canvas(actions(), WITH_NO_TEAM);
    await click(button("No team (2)"));
    const panel = document.querySelector("aside")!;
    expect(text(panelHeading()!)).toBe("No team (2)");
    expect(await focused()).toBe(panelHeading());
    expect(text(panel)).toContain("Ben Kho");
    expect(text(panel)).toContain("Hana Lim");
    expect(text(panel)).not.toContain("Olga Day");
    expect(text(panel)).not.toContain("Ana Lee");
    expect(button("Change email (Ben Kho)", panel)).toBeDefined();
    expect(button("Remove from Module One (Ben Kho)", panel)).toBeDefined();
    expect(queryButton(/\(Hana Lim\)$/, panel)).toBeNull();
    expect(queryButton(/^(Make leader|Make member|Remove from team)/, panel)).toBeNull();
  });

  it("closes the No team panel on Escape and on ×, handing focus back to No team", async () => {
    await canvas(actions(), WITH_NO_TEAM);
    await click(button("No team (2)"));
    await press(document.body, "Escape");
    expect(document.querySelector("aside")).toBeNull();
    expect((await focused())?.hasAttribute("data-no-team-button")).toBe(true);

    await click(button("No team (2)"));
    expect(await focused()).toBe(panelHeading());
    await click(button("Close"));
    expect(document.querySelector("aside")).toBeNull();
    expect((await focused())?.hasAttribute("data-no-team-button")).toBe(true);
  });

  it("removes someone from Module One from the No team panel, says so there, and drops them once the page comes back", async () => {
    const removePerson = vi.fn(async () => ({ ok: true as const, value: { outcome: "removed" as const, loginKept: false } }));
    const teamActions = { ...TEAM_ACTIONS, removePerson };
    const structure = actions();
    const shown = await canvas(structure, WITH_NO_TEAM, teamActions);
    await click(button("No team (2)"));
    await click(button("Remove from Module One (Ben Kho)"));
    await click(button("Remove from Module One"));
    expect(removePerson).toHaveBeenCalledExactlyOnceWith("m-ben");
    const done = "Removed Ben Kho from Module One. Anything they recorded stays.";
    expect(text(document.querySelector('aside [role="status"]')!)).toBe(done);

    // The server action re-renders the page with Ben removed.
    const removed = WITH_NO_TEAM.map((m) => (m.id === "m-ben" ? { ...m, auth_user_id: null, removed_at: "2026-10-09T02:00:00Z" } : m));
    await shown.rerender(page(structure, removed, teamActions));
    expect(text(panelHeading()!)).toBe("No team (1)");
    expect(button("No team (1)")).toBeDefined();
    expect(text(document.querySelector("aside ul")!)).not.toContain("Ben Kho");
    expect(await focused()).toBe(panelHeading());
    expect(text(document.querySelector('aside [role="status"]')!)).toBe(done);
  });

  it("opens the No team panel for someone with no team picked on the chart, and the team's panel for someone in one", async () => {
    await canvas(actions(), WITH_NO_TEAM);
    await click(button("Show people"));
    expect(document.querySelector('.react-flow__node[data-id="person:m-olga"]')).toBeNull();
    await press(box("person:m-ben"), "Enter");
    expect(text(panelHeading()!)).toBe("No team (2)");
    await press(box("person:m-ana"), "Enter");
    expect(text(panelHeading()!)).toBe("IP Lab 1");
  });
});

describe("Find a person or team", () => {
  const find = () => labelled<HTMLInputElement>("Find a person or team");
  // Each option's name and what it is ("IP Lab · Domain"), or the whole text when it has no parts.
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map((el) =>
      el.children.length === 2 ? `${text(el.children[0])} · ${text(el.children[1])}` : text(el),
    );
  const heading = () => text(document.querySelector("aside [data-panel-heading]")!);

  it("lists matching boxes and people, leaving out archived boxes and removed people", async () => {
    await canvas(actions(), [...WITH_NO_TEAM, member("m-lab", "Labib Old", "old")]);
    await type(find(), "l");
    expect(options()).toContain("IP Lab · Domain");
    expect(options()).toContain("Ana Lee · In IP Lab 1");
    expect(options()).toContain("Hana Lim · No team");
    expect(options().join(" ")).not.toContain("Old Lab");
    expect(options().join(" ")).not.toContain("Olga Day");
    expect(options().join(" ")).not.toContain("Labib Old");
    await type(find(), "zzz");
    // Nothing to pick is said as a status, not offered as an option.
    expect(options()).toEqual([]);
    expect(find().getAttribute("aria-expanded")).toBe("false");
    expect([...document.querySelectorAll('[role="status"]')].map((el) => text(el))).toContain(
      "No one and nothing by that name.",
    );
  });

  it("opens the first match's panel on Enter, and a highlighted one's after the arrow keys", async () => {
    await canvas();
    await type(find(), "ip lab");
    expect(find().getAttribute("aria-expanded")).toBe("true");
    await press(find(), "Enter");
    expect(heading()).toBe("IP Lab");
    // The list closes and the box is cleared for the next search.
    expect(find().value).toBe("");
    expect(find().getAttribute("aria-expanded")).toBe("false");

    await type(find(), "ip lab");
    await press(find(), "ArrowDown");
    const active = find().getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)!.getAttribute("data-match")).toBe("node:ip1");
    await press(find(), "Enter");
    expect(heading()).toBe("IP Lab 1");
  });

  it("opens a person's team panel, or No team's, whether or not people are shown", async () => {
    await canvas(actions(), WITH_NO_TEAM);
    await type(find(), "ana");
    await press(find(), "Enter");
    expect(heading()).toBe("IP Lab 1");
    await type(find(), "ben");
    await press(find(), "Enter");
    expect(heading()).toBe("No team (2)");

    await click(button("Show people"));
    await type(find(), "ana");
    await press(find(), "Enter");
    expect(heading()).toBe("IP Lab 1");
  });

  it("offers only what the chart draws: not a node outside the tree, nor the people in it", async () => {
    // Lost Team's parent doesn't exist, so it's listed under "Not in the tree", not on the chart.
    await render(
      <StructureCanvas
        rows={[...ROWS, node("lost", "Lost Team", "team", "nowhere", 0)]}
        members={[...MEMBERS, member("m-lou", "Lou Tan", "lost")]}
        leads={[]}
        grants={[]}
        adminMemberId="m-admin"
        actions={actions()}
        teamActions={TEAM_ACTIONS}
      />,
    );
    expect(text(document.querySelector('[aria-labelledby="stray-heading"]')!)).toContain("Lost Team");
    await type(find(), "lo");
    expect(options().join(" ")).not.toContain("Lost Team");
    expect(options().join(" ")).not.toContain("Lou Tan");
  });

  it("picks a match on a click too", async () => {
    await canvas();
    await type(find(), "atl");
    await act(async () => {
      document
        .querySelector('[data-match="node:atlas"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(heading()).toBe("Atlas");
  });

  it("closes the list on Escape without closing an open panel", async () => {
    await canvas();
    await press(box("ip1"), "Enter");
    expect(heading()).toBe("IP Lab 1");
    await type(find(), "atl");
    let escape: KeyboardEvent | undefined;
    find().addEventListener("keydown", (event) => (escape = event), { once: true });
    await press(find(), "Escape");
    expect(find().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("aside")).not.toBeNull();
    // What was typed stays (the browser's own Escape would clear a search input).
    expect(escape?.defaultPrevented).toBe(true);
    expect(find().value).toBe("atl");
  });

  it("falls back to the first match when the highlighted one goes away under an open list", async () => {
    const shown = await canvas(actions(), WITH_NO_TEAM);
    await type(find(), "an");
    expect(options()).toEqual(["Ana Lee · In IP Lab 1", "Hana Lim · No team"]);
    await press(find(), "ArrowDown");
    expect(document.getElementById(find().getAttribute("aria-activedescendant")!)!.getAttribute("data-match")).toBe("person:m-hana");
    // A save re-renders the page without Hana.
    await shown.rerender(page(actions(), WITH_NO_TEAM.filter((m) => m.id !== "m-hana")));
    expect(document.getElementById(find().getAttribute("aria-activedescendant")!)!.getAttribute("data-match")).toBe("person:m-ana");
    await press(find(), "Enter");
    expect(heading()).toBe("IP Lab 1");
  });
});
