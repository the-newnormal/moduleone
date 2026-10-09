// @vitest-environment happy-dom
// What the team page's dialogs do when people use them: refusals show where the admin is looking,
// a dialog can't be closed while its change is saving, and focus has somewhere to go when the
// button that had it goes away.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Candidate, LeadPerson, Person, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import type { ActionResult } from "@/lib/admin/errors";
import { button, click, deferred, dialog, press, queryButton, render, settle, text } from "@/test/dom";
import { AddPeopleDialog } from "./add-people-dialog";
import { ConfirmButton } from "./confirm-button";
import { EditTeamDialog } from "./edit-team-dialog";
import { LeadsSection } from "./leads-section";
import { PeopleSection } from "./people-section";

const TEAM: TeamSummary = {
  id: "c0000000-0000-4000-8000-000000000001",
  name: "IP Lab 1",
  kind: "team",
  kindLabel: "Team",
  code: "IP.1",
  domainType: null,
  divisionType: null,
  typeLabel: null,
  leaderTitle: null,
  note: null,
  archived: false,
  everyoneLeads: false,
};

const person = (id: string, name: string, changes: Partial<Person> = {}): Person => ({
  id,
  name,
  role: "member",
  roleLabel: "Member",
  title: null,
  isSelf: false,
  editable: true,
  hasLogin: false,
  loginGiven: null,
  canGiveLogin: true,
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
const refuse = (error: string) => async (): Promise<ActionResult> => ({ ok: false, error });
const peopleActions = (changes = {}) => ({
  addMember: vi.fn(ok),
  createMember: vi.fn(ok),
  giveLogin: vi.fn(ok),
  resendInvite: vi.fn(ok),
  removeFromTeam: vi.fn(ok),
  setRole: vi.fn(ok),
  changeEmail: vi.fn(async () => ({ ok: true as const, value: { invited: false } })),
  removePerson: vi.fn(async () => ({ ok: true as const, value: { outcome: "removed" as const, loginKept: false } })),
  ...changes,
});

// Waits for focusSoon (an animation frame, then retries).
const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)));

describe("ConfirmButton", () => {
  const renderButton = (run: () => Promise<ActionResult>, extra: { focusAfter?: string; onDone?: () => void } = {}) =>
    render(
      <>
        <h2 id="heading" tabIndex={-1}>
          People
        </h2>
        <ConfirmButton label="Remove" title="Remove Zed?" description="Sure?" confirmLabel="Yes, remove" run={run} context="test" {...extra} />
      </>,
    );

  it("shows the refusal in the dialog and stays open", async () => {
    await renderButton(refuse("This person isn't in this team any more. Reload the page."));
    await click(button("Remove"));
    await click(button("Yes, remove"));
    expect(dialog()).not.toBeNull();
    expect(text(dialog()!)).toContain("This person isn't in this team any more. Reload the page.");
  });

  it("can't be closed while the action runs, so its answer has somewhere to show", async () => {
    const answer = deferred<ActionResult>();
    await renderButton(() => answer.promise);
    await click(button("Remove"));
    await click(button("Yes, remove"));
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();

    await act(async () => answer.resolve({ ok: false, error: "No." }));
    expect(text(dialog()!)).toContain("No.");
    await press(dialog()!, "Escape");
    expect(dialog()).toBeNull();
  });

  it("closes on success and puts focus on focusAfter when given", async () => {
    const onDone = vi.fn();
    await renderButton(ok, { focusAfter: "#heading", onDone });
    await click(button("Remove"));
    await click(button("Yes, remove"));
    await frames();
    expect(dialog()).toBeNull();
    expect(onDone).toHaveBeenCalledOnce();
    expect(document.activeElement?.id).toBe("heading");
  });
});

describe("PeopleSection", () => {
  const ZED = person("m-zed", "Zed Ong");
  const MEI = person("m-mei", "Mei Wong", { hasLogin: true, canGiveLogin: false });

  it("puts focus on the People heading when a removed person's row goes away", async () => {
    const actions = peopleActions();
    const page = await render(<PeopleSection team={TEAM} people={[MEI, ZED]} candidates={[]} actions={actions} />);
    await click(button("Remove from team (Zed Ong)"));
    await click(button("Remove"));
    // The server action re-renders the page without Zed.
    await page.rerender(<PeopleSection team={TEAM} people={[MEI]} candidates={[]} actions={actions} />);
    await frames();
    expect(actions.removeFromTeam).toHaveBeenCalledWith(TEAM.id, "m-zed");
    expect(document.activeElement?.tagName).toBe("H2");
    expect(text(document.activeElement!)).toBe("People (1)");
    expect(text()).toContain("Removed Zed Ong from IP Lab 1.");
  });

  it("puts focus on the People heading once a login is given (Give login goes away)", async () => {
    const actions = peopleActions();
    const page = await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
    await click(button("Give login (Zed Ong)"));
    const input = dialog()!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "zed@example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Send invite"));
    await page.rerender(
      <PeopleSection team={TEAM} people={[{ ...ZED, hasLogin: true, canGiveLogin: false }]} candidates={[]} actions={actions} />,
    );
    await frames();
    expect(actions.giveLogin).toHaveBeenCalledWith("m-zed", "zed@example.com");
    expect(queryButton(/^Give login/)).toBeNull();
    expect(text(document.activeElement!)).toBe("People (1)");
  });

  it("asks before resending an invite and says it was sent", async () => {
    const actions = peopleActions();
    await render(
      <PeopleSection
        team={TEAM}
        people={[{ ...MEI, canResendInvite: true, loginGiven: "Login given by Hana Lim on 9 Oct 2026" }]}
        candidates={[]}
        actions={actions}
      />,
    );
    await click(button("Resend invite (Mei Wong)"));
    expect(text(dialog()!)).toContain("the old link stops working");
    await click(button("Send new invite"));
    expect(actions.resendInvite).toHaveBeenCalledWith("m-mei");
    expect(text()).toContain("Sent Mei Wong a new invite.");
  });

  it("warns, when making a leader a member, which extra leads they lose", async () => {
    const leo = person("m-leo", "Leo Tan", { role: "leader", roleLabel: "Leader", otherLeads: ["IP Lab 2"] });
    await render(<PeopleSection team={TEAM} people={[leo]} candidates={[]} actions={peopleActions()} />);
    await click(button("Make member (Leo Tan)"));
    expect(text(dialog()!)).toContain("and will no longer lead IP Lab 2.");
  });
});

describe("AddPeopleDialog", () => {
  const CANDIDATES: Candidate[] = [{ id: "m-ben", name: "Ben Kho", teamId: null, teamName: null }];

  it("can't be closed while adding, and shows the refusal when it comes", async () => {
    const answer = deferred<ActionResult>();
    const actions = { addMember: vi.fn(() => answer.promise), createMember: vi.fn(ok) };
    await render(<AddPeopleDialog team={TEAM} candidates={CANDIDATES} actions={actions} onDone={() => {}} />);
    await click(button("Add people"));
    await click(button("Add (Ben Kho)"));
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();

    await act(async () => answer.resolve({ ok: false, error: "That team is archived. Restore it first, or pick another." }));
    expect(text(dialog()!)).toContain("That team is archived. Restore it first, or pick another.");
    await press(dialog()!, "Escape");
    expect(dialog()).toBeNull();
  });
});

describe("LeadsSection", () => {
  const OPTIONS: LeadPerson[] = [{ id: "m-cat", name: "Cat Ng", teamName: null, inThisTeam: false, viaDomain: null, viaOwnTeam: false }];
  const LEADS: LeadPerson[] = [{ id: "m-ana", name: "Ana Lee", teamName: "IP Lab 2", inThisTeam: false, viaDomain: null, viaOwnTeam: false }];

  it("can't close Add lead while adding, and shows the refusal when it comes", async () => {
    const answer = deferred<ActionResult>();
    const actions = { addLead: vi.fn(() => answer.promise), removeLead: vi.fn(ok) };
    await render(
      <LeadsSection team={TEAM} ownLeaders={[]} leads={[]} inheritedLeads={[]} leadOptions={OPTIONS} actions={actions} />,
    );
    await click(button("Add lead"));
    await click(button("Add as lead (Cat Ng)"));
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();
    await act(async () => answer.resolve({ ok: false, error: "Only a leader can lead a team." }));
    expect(text(dialog()!)).toContain("Only a leader can lead a team.");
  });

  it("puts focus on the Leads heading when a removed lead's row goes away", async () => {
    const actions = { addLead: vi.fn(ok), removeLead: vi.fn(ok) };
    const props = { team: TEAM, ownLeaders: [], inheritedLeads: [], leadOptions: [], actions };
    const page = await render(<LeadsSection {...props} leads={LEADS} />);
    await click(button("Remove as lead (Ana Lee)"));
    await click(button("Remove lead"));
    await page.rerender(<LeadsSection {...props} leads={[]} />);
    await frames();
    expect(actions.removeLead).toHaveBeenCalledWith(TEAM.id, "m-ana");
    expect(text(document.activeElement!)).toBe("Leads");
  });

  it.each([
    ["sits in it", { inThisTeam: true, viaDomain: null, viaOwnTeam: false }, "because they sit in this"],
    ["leads the domain holding it", { inThisTeam: false, viaDomain: "IP Lab", viaOwnTeam: false }, "because they also lead IP Lab, which holds it"],
  ])("doesn't say a removed lead stops leading the team while they still lead it (%s)", async (_label, where, reason) => {
    const leo: LeadPerson = { id: "m-leo", name: "Leo Tan", teamName: "IP Lab 1", ...where };
    const actions = { addLead: vi.fn(ok), removeLead: vi.fn(ok) };
    await render(
      <LeadsSection team={TEAM} ownLeaders={[]} leads={[leo]} inheritedLeads={[]} leadOptions={[]} actions={actions} />,
    );
    await click(button("Remove as lead (Leo Tan)"));
    expect(text(dialog()!)).toContain("This only removes the extra lead.");
    expect(text(dialog()!)).toContain(reason);
    expect(text(dialog()!)).not.toContain("no longer see");
    await click(button("Remove lead"));
    await settle();
    expect(actions.removeLead).toHaveBeenCalledWith(TEAM.id, "m-leo");
    expect(text()).toContain(`Removed the extra lead. Leo Tan still leads ${TEAM.name}, ${reason}`);
    expect(text()).not.toContain("no longer leads");
  });
});

describe("EditTeamDialog", () => {
  it("keeps Save off until something changes", async () => {
    await render(<EditTeamDialog team={TEAM} updateNode={vi.fn(ok)} />);
    await click(button("Edit (IP Lab 1)"));
    expect(button("Save").disabled).toBe(true);
  });

  it("turns Save on for saved values it refuses, and pressing it says which field and why", async () => {
    // A title set outside the app (the owner, in the dashboard) that the form doesn't accept.
    const updateNode = vi.fn(ok);
    await render(<EditTeamDialog team={{ ...TEAM, leaderTitle: "Head\tCoach" }} updateNode={updateNode} />);
    await click(button("Edit (IP Lab 1)"));
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    expect(text(dialog()!)).toContain("Titles can't contain line breaks or hidden characters.");
    expect(updateNode).not.toHaveBeenCalled();
  });
});
