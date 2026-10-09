// @vitest-environment happy-dom
// The Structure page's No team panel: everyone who sits nowhere, with their logins, Change email
// and Remove from Module One as on a team page, but nothing that places them (that's done by
// dragging them on the chart).
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Person } from "@/app/admin/teams/[id]/team-view";
import type { ActionResult } from "@/lib/admin/errors";
import { button, click, dialog, press, queryButton, render, text } from "@/test/dom";
import { NoTeamPanel } from "./no-team-panel";

// As buildNoTeamPeople makes them: never editable, since there's no team to change them in.
const person = (id: string, name: string, changes: Partial<Person> = {}): Person => ({
  id,
  name,
  role: "member",
  roleLabel: "Member",
  title: null,
  isSelf: false,
  editable: false,
  hasLogin: false,
  loginGiven: null,
  canGiveLogin: false,
  ownerGivesLogin: false,
  canResendInvite: false,
  emailChanged: null,
  canChangeEmail: false,
  canRemove: false,
  ownerKeeps: null,
  otherLeads: [],
  leadsHere: false,
  leadsDomain: null,
  ...changes,
});

const ok = async (): Promise<ActionResult> => ({ ok: true, value: null });
const panelActions = () => ({
  giveLogin: vi.fn(ok),
  resendInvite: vi.fn(ok),
  removeFromTeam: vi.fn(ok),
  setRole: vi.fn(ok),
  changeEmail: vi.fn(async () => ({ ok: true as const, value: { invited: false } })),
  removePerson: vi.fn(async () => ({ ok: true as const, value: { outcome: "removed" as const, loginKept: false } })),
});

const BEN = person("m-ben", "Ben Kho", { hasLogin: true, canResendInvite: true, canChangeEmail: true, canRemove: true });
const CAT = person("m-cat", "Cat Ng", { role: "leader", roleLabel: "Leader", canGiveLogin: true, canRemove: true, otherLeads: ["IP Lab 2"] });
const GUS = person("m-gus", "Gus Tay", { hasLogin: true, ownerKeeps: "grants" });
const ELI = person("m-eli", "Eli Chao", { role: "leader", roleLabel: "Leader", hasLogin: true, ownerKeeps: "organisation" });
const HANA = person("m-hana", "Hana Lim", { role: "hq", roleLabel: "Master Admin", isSelf: true, hasLogin: true });

const heading = () => document.querySelector<HTMLElement>("aside [data-panel-heading]")!;
// One person's <li> (the row whose text starts with their name).
const row = (name: string) => {
  const item = [...document.querySelectorAll("aside li")].find((li) => text(li).startsWith(name));
  if (!item) throw new Error(`no row for ${name}`);
  return item;
};
const buttons = (name: string) => [...row(name).querySelectorAll("button")].map((b) => text(b));

// Waits for focusSoon (an animation frame, then retries).
const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)));

describe("NoTeamPanel", () => {
  it("lists everyone with no team under a heading that counts them, with what an admin may do about each", async () => {
    await render(<NoTeamPanel people={[BEN, CAT, ELI, GUS, HANA]} actions={panelActions()} onClose={() => {}} />);
    expect(text(heading())).toBe("No team (5)");
    expect(text(document.querySelector("aside")!)).toContain(
      "People who don't sit anywhere: not in the organisation or any division, domain or team. To place someone, open a box and use Add people, or show people on the chart and drag them onto a box.",
    );
    expect(buttons("Ben Kho")).toEqual(["Resend invite (Ben Kho)", "Change email (Ben Kho)", "Remove from Module One (Ben Kho)"]);
    expect(buttons("Cat Ng")).toEqual(["Give login (Cat Ng)", "Remove from Module One (Cat Ng)"]);
    expect(buttons("Gus Tay")).toEqual([]);
    expect(text(row("Gus Tay"))).toContain("They hold grants, so only the project owner can change their sign-in email or remove them.");
    expect(buttons("Eli Chao")).toEqual([]);
    expect(text(row("Eli Chao"))).toContain(
      "They lead the organisation, so only the project owner can change their sign-in email or remove them.",
    );
    expect(text(row("Hana Lim"))).toContain("Hana Lim (you)");
    expect(buttons("Hana Lim")).toEqual([]);
  });

  it("never offers a role or team change, even for a row an admin could edit on a team page", async () => {
    await render(<NoTeamPanel people={[{ ...BEN, editable: true }, { ...CAT, editable: true }]} actions={panelActions()} onClose={() => {}} />);
    expect(queryButton(/^(Make leader|Make member|Remove from (team|domain|division))/)).toBeNull();
    expect(buttons("Cat Ng")).toEqual(["Give login (Cat Ng)", "Remove from Module One (Cat Ng)"]);
  });

  it("says when everyone sits somewhere", async () => {
    await render(<NoTeamPanel people={[]} actions={panelActions()} onClose={() => {}} />);
    expect(text(heading())).toBe("No team (0)");
    expect(text(document.querySelector("aside")!)).toContain("Everyone sits somewhere.");
    expect(document.querySelector("aside ul")).toBeNull();
  });

  it("closes on × and on Escape, but leaves an Escape that closes a dialog above it to that dialog", async () => {
    const onClose = vi.fn();
    await render(<NoTeamPanel people={[BEN]} actions={panelActions()} onClose={onClose} />);
    await click(button("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    await click(button("Remove from Module One (Ben Kho)"));
    await press(dialog()!, "Escape");
    expect(dialog()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);

    await press(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("removes someone with no team without saying they leave one, and puts focus on its heading once their row goes", async () => {
    const actions = panelActions();
    const page = await render(<NoTeamPanel people={[BEN, CAT]} actions={actions} onClose={() => {}} />);
    await click(button("Remove from Module One (Cat Ng)"));
    expect(text(document.getElementById(dialog()!.getAttribute("aria-describedby")!)!)).toBe(
      "They stop leading IP Lab 2. Anything they recorded stays, so past weeks on the heat-map don't change. If " +
        "they've never had a login and left nothing behind, they're deleted completely. This can't be undone here.",
    );
    await click(button("Remove from Module One"));
    // The server action re-renders the page without Cat.
    await page.rerender(<NoTeamPanel people={[BEN]} actions={actions} onClose={() => {}} />);
    await frames();
    expect(actions.removePerson).toHaveBeenCalledExactlyOnceWith("m-cat");
    expect(document.activeElement).toBe(heading());
    expect(text(heading())).toBe("No team (1)");
    expect(text(document.querySelector('aside [role="status"]')!)).toBe(
      "Removed Cat Ng from Module One. Anything they recorded stays.",
    );
  });
});
