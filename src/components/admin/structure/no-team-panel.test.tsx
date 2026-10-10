// @vitest-environment happy-dom
// The Structure page's No team panel: everyone who sits nowhere, with their logins, Change email
// and Remove from Module One as on a team page, but nothing that places them (that's done by
// dragging them on the chart).
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildNoTeamPeople, type MemberRow, type Person } from "@/app/admin/teams/[id]/team-view";
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
  ownerResendsInvite: false,
  emailChanged: null,
  canChangeEmail: false,
  canRemove: false,
  ownerKeeps: null,
  otherLeads: [],
  leadsHere: false,
  leadsDomain: null,
  // Has a login whose state the page couldn't read, unless a test says which.
  login: changes.hasLogin ? { state: "unknown" } : { state: "none" },
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

// A members row with no team, as the Structure page reads it.
const member = (id: string, name: string, changes: Partial<MemberRow> = {}): MemberRow => ({
  id,
  name,
  role: "member",
  team_id: null,
  auth_user_id: null,
  login_given_by: null,
  login_given_at: null,
  login_email_changed_by: null,
  login_email_changed_at: null,
  removed_at: null,
  ...changes,
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

// The line under one person's name, part by part: their role badge, login tag and its detail.
const statusLine = (name: string) => {
  const line = row(name).querySelector('[data-slot="badge"]')?.parentElement;
  if (!line) throw new Error(`no role badge for ${name}`);
  return [...line.children].map((part) => text(part));
};
// Normal's Tag tones, by the classes that make each one (src/components/normal/tag.tsx).
const TAG_TONES = {
  outline: ["border-line-strong", "bg-transparent"],
  neutral: ["border-border", "bg-card"],
  warning: ["bg-sun-soft", "text-warning-ink"],
  success: ["bg-success-soft", "text-success"],
} as const;
// The login tag in one person's row (the element right after their role badge): its words, and
// which of Normal's Tag tones its classes make (exactly one, when it's right).
const loginTag = (name: string) => {
  const tag = row(name).querySelector('[data-slot="badge"]')?.nextElementSibling;
  if (!tag) throw new Error(`no login tag after the role badge for ${name}`);
  const tones = Object.entries(TAG_TONES)
    .filter(([, needs]) => needs.every((c) => tag.classList.contains(c)))
    .map(([tone]) => tone);
  return { label: text(tag), tones };
};

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

  it("shows each person's sign-in status after their role, coloured as on a team page", async () => {
    await render(
      <NoTeamPanel
        people={[
          person("m-ana", "Ana Lee"),
          person("m-ivy", "Ivy Ho", { hasLogin: true, login: { state: "invited", sentAt: "8 Oct 2026, 3:04 pm", expired: false } }),
          person("m-ben", "Ben Kho", {
            hasLogin: true,
            login: { state: "invited", sentAt: "1 Oct 2026, 9:15 am", expired: true },
            canResendInvite: true,
          }),
          person("m-cat", "Cat Ng", { hasLogin: true, login: { state: "ready" } }),
          person("m-dan", "Dan Lim", { hasLogin: true, login: { state: "active", lastSignedInOn: "8 Oct 2026" } }),
          person("m-eve", "Eve Tan", { hasLogin: true }),
        ]}
        actions={panelActions()}
        onClose={() => {}}
      />,
    );
    expect(statusLine("Ana Lee")).toEqual(["Member", "No login yet"]);
    expect(statusLine("Ivy Ho")).toEqual(["Member", "Invite not used", "Invite sent 8 Oct 2026, 3:04 pm"]);
    expect(statusLine("Ben Kho")).toEqual(["Member", "Invite expired", "Invite sent 1 Oct 2026, 9:15 am"]);
    expect(statusLine("Cat Ng")).toEqual(["Member", "Never signed in", "Their login is ready: they sign in at the login page"]);
    expect(statusLine("Dan Lim")).toEqual(["Member", "Active", "Last signed in with a link on 8 Oct 2026"]);
    expect(statusLine("Eve Tan")).toEqual(["Member", "Has a login"]);

    expect(loginTag("Ana Lee")).toEqual({ label: "No login yet", tones: ["neutral"] });
    expect(loginTag("Ivy Ho")).toEqual({ label: "Invite not used", tones: ["warning"] });
    expect(loginTag("Ben Kho")).toEqual({ label: "Invite expired", tones: ["warning"] });
    expect(loginTag("Cat Ng")).toEqual({ label: "Never signed in", tones: ["neutral"] });
    expect(loginTag("Dan Lim")).toEqual({ label: "Active", tones: ["success"] });
    expect(loginTag("Eve Tan")).toEqual({ label: "Has a login", tones: ["neutral"] });
    expect(buttons("Ben Kho")).toEqual(["Resend invite (Ben Kho)"]);
  });

  it("shows what admin_login_states says about each login, in Singapore time, as buildNoTeamPeople reads it", async () => {
    const given = { login_given_by: "m-hana", login_given_at: "2026-10-01T01:00:00Z" };
    const people = buildNoTeamPeople({
      adminMemberId: "m-hana",
      teams: [],
      members: [
        member("m-hana", "Hana Lim", { role: "hq", auth_user_id: "u-hana" }),
        member("m-ana", "Ana Lee"),
        member("m-ivy", "Ivy Ho", { auth_user_id: "u-ivy", ...given }),
        member("m-ben", "Ben Kho", { auth_user_id: "u-ben", ...given }),
        member("m-cat", "Cat Ng", { auth_user_id: "u-cat", ...given }),
        member("m-dan", "Dan Lim", { auth_user_id: "u-dan", ...given }),
        member("m-eve", "Eve Tan", { auth_user_id: "u-eve" }), // its login was deleted meanwhile: no row
      ],
      leads: [],
      logins: {
        readAt: "2026-10-09T02:30:00Z", // 10:30 am in Singapore
        rows: [
          { member_id: "m-hana", state: "active", invited_at: null, last_sign_in_at: "2026-10-09T01:00:00Z" },
          // Sent half an hour before the page read it: the link still works.
          { member_id: "m-ivy", state: "invited", invited_at: "2026-10-09T02:00:00Z", last_sign_in_at: null },
          // Sent an hour and a half before: it no longer does.
          { member_id: "m-ben", state: "invited", invited_at: "2026-10-09T01:00:00Z", last_sign_in_at: null },
          { member_id: "m-cat", state: "ready", invited_at: null, last_sign_in_at: null },
          // 16:30 UTC on 7 Oct is 12:30 am on 8 Oct in Singapore.
          { member_id: "m-dan", state: "active", invited_at: null, last_sign_in_at: "2026-10-07T16:30:00Z" },
        ],
      },
    });
    await render(<NoTeamPanel people={people} actions={panelActions()} onClose={() => {}} />);

    expect(statusLine("Ana Lee")).toEqual(["Member", "No login yet"]);
    expect(statusLine("Ivy Ho")).toEqual(["Member", "Invite not used", "Invite sent 9 Oct 2026, 10:00 am"]);
    expect(statusLine("Ben Kho")).toEqual(["Member", "Invite expired", "Invite sent 9 Oct 2026, 9:00 am"]);
    expect(statusLine("Cat Ng")).toEqual(["Member", "Never signed in", "Their login is ready: they sign in at the login page"]);
    expect(statusLine("Dan Lim")).toEqual(["Member", "Active", "Last signed in with a link on 8 Oct 2026"]);
    expect(statusLine("Eve Tan")).toEqual(["Member", "Has a login"]);
    expect(statusLine("Hana Lim")).toEqual(["Master Admin", "Active", "Last signed in with a link on 9 Oct 2026"]);
    for (const name of ["Ivy Ho", "Ben Kho", "Cat Ng", "Dan Lim"]) {
      expect(text(row(name))).toContain("Login given by Hana Lim on 1 Oct 2026");
    }
    expect(loginTag("Ivy Ho").tones).toEqual(["warning"]);
    expect(loginTag("Ben Kho").tones).toEqual(["warning"]);
    expect(loginTag("Dan Lim").tones).toEqual(["success"]);

    // Resend invite only while the invite is unused, expired or not; never once they've used it.
    expect(buttons("Ivy Ho")).toEqual(["Resend invite (Ivy Ho)", "Change email (Ivy Ho)", "Remove from Module One (Ivy Ho)"]);
    expect(buttons("Ben Kho")).toEqual(["Resend invite (Ben Kho)", "Change email (Ben Kho)", "Remove from Module One (Ben Kho)"]);
    expect(buttons("Cat Ng")).toEqual(["Change email (Cat Ng)", "Remove from Module One (Cat Ng)"]);
    expect(buttons("Dan Lim")).toEqual(["Change email (Dan Lim)", "Remove from Module One (Dan Lim)"]);
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
