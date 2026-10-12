// @vitest-environment happy-dom
// What Set email, Add a list and Send invites do when people use them (migration 0014): an address
// is checked before the server is asked, refusals show where the admin is looking, a dialog can't
// be closed while it's saving or sending, a list fixed when Send invites opens stays fixed, and
// focus has somewhere to go when the button that had it goes away. Nothing logged names anyone.
import { act } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { EMAIL_TAKEN, NOTED_FOR_SOMEONE_ELSE, notedForOthers, TOO_MANY_EMAILS } from "@/app/admin/teams/[id]/messages";
import type { Candidate, Person, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { type ActionResult, EMAIL_NOTED, GENERIC_ERROR } from "@/lib/admin/errors";
import { MAX_PEOPLE } from "@/lib/admin/people-list";
import { parseEmail } from "@/lib/admin/validate";
import { button, click, deferred, dialog, labelled, press, queryButton, render, settle, text, type } from "@/test/dom";
import { AddListDialog, addedListMessage } from "./add-list-dialog";
import { PeopleSection } from "./people-section";
import { type Invitee, SendInvitesDialog } from "./send-invites-dialog";
import type { TeamActions } from "./types";

type GiveLogin = TeamActions["giveLogin"];
type CreateMembers = TeamActions["createMembers"];

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
const DIVISION: TeamSummary = {
  ...TEAM,
  id: "c0000000-0000-4000-8000-000000000003",
  name: "Gather",
  kind: "division",
  kindLabel: "Division",
  code: null,
  divisionType: "strategy",
  typeLabel: "Strategy division",
  everyoneLeads: true,
};

// Someone Give login is offered for, as buildTeamView makes them once the noted addresses are
// read. Not editable, so their row's buttons are only the login ones.
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
  canGiveLogin: true,
  ownerGivesLogin: false,
  pendingEmail: null,
  canSetEmail: true,
  canResendInvite: false,
  ownerResendsInvite: false,
  emailChanged: null,
  canChangeEmail: false,
  canRemove: false,
  ownerKeeps: null,
  otherLeads: [],
  leadsHere: false,
  leadsDomain: null,
  login: changes.hasLogin ? { state: "unknown" } : { state: "none" },
  ...changes,
});
// The same person once they've been given a login: Give login, Set email and the noted address go.
const withLogin = (p: Person): Person => ({
  ...p,
  hasLogin: true,
  canGiveLogin: false,
  canSetEmail: false,
  pendingEmail: null,
  canResendInvite: true,
  login: { state: "invited", sentAt: "12 Oct 2026, 9:15 am", expired: false },
});

const ok = async (): Promise<ActionResult> => ({ ok: true, value: null });
const refuse = (error: string) => async (): Promise<ActionResult> => ({ ok: false, error });
const peopleActions = (changes = {}) => ({
  addMember: vi.fn(ok),
  createMember: vi.fn(ok),
  createMembers: vi.fn(async () => ({ ok: true as const, value: { added: 1 } })),
  giveLogin: vi.fn(ok),
  resendInvite: vi.fn(ok),
  setPendingEmail: vi.fn(ok),
  removeFromTeam: vi.fn(ok),
  setRole: vi.fn(ok),
  changeEmail: vi.fn(async () => ({ ok: true as const, value: { invited: false } })),
  removePerson: vi.fn(async () => ({ ok: true as const, value: { outcome: "removed" as const, loginKept: false } })),
  ...changes,
});

// A server action that throws instead of answering, with names and addresses in its message.
const throwing = (message: string) => async (): Promise<never> => {
  throw Object.assign(new Error(message), { code: "ECONNRESET" });
};
// Everything console.error was given, as one string, to check nothing in it names anyone.
const logged = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls);

// An element's text as it reads, with a space where one element ends and the next begins
// (textContent runs "Not sent" and "Ben Kho" together).
const spaced = (node: Node): string =>
  node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "") : ` ${[...node.childNodes].map(spaced).join("")} `;
const words = (element: Element) => spaced(element).replace(/\s+/g, " ").trim();
// Waits for focusSoon (an animation frame, then retries).
const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)));
// The page's own status line (the Send invites dialog has one too, rendered after it).
const status = () => text(document.querySelector('[role="status"]')!);
// A button in the open dialog's footer (its own close button is also called Close).
const footerButton = (name: string) => button(name, dialog()!.querySelector('[data-slot="dialog-footer"]')!);
// The X in the open dialog's corner (Cancel and Close in the footer close it too).
function cornerClose() {
  const corner = [...dialog()!.querySelectorAll<HTMLButtonElement>('button[data-slot="dialog-close"]')].filter(
    (b) => b.closest('[data-slot="dialog-footer"]') === null,
  );
  if (corner.length !== 1 || text(corner[0]) !== "Close") throw new Error(`expected the dialog's own close button, found ${corner.length}`);
  return corner[0];
}

// Puts console.error back, and settles anything a test left running so a late answer can't reach
// the next test's page.
afterEach(async () => {
  vi.restoreAllMocks();
  await settle();
});

describe("PeopleSection: Set email", () => {
  const ZED = person("m-zed", "Zed Ong");
  const NOTED = person("m-zed", "Zed Ong", { pendingEmail: "zed@example.com" });
  const address = () => labelled<HTMLInputElement>("Email address");

  it.each(["", "   ", "zed@example", "zed ong@example.com", "zed@@example.com", "@example.com"])(
    "says what's wrong with the address (%j) without asking the server",
    async (value) => {
      const actions = peopleActions();
      await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
      await click(button("Set email (Zed Ong)"));
      if (value) await type(address(), value);
      await click(button("Save email"));
      const expected = parseEmail(value);
      if (expected.ok) throw new Error("the test needs an address parseEmail refuses");
      expect(text(dialog()!)).toContain(expected.error);
      expect(address().getAttribute("aria-invalid")).toBe("true");
      expect(text(document.getElementById(address().getAttribute("aria-describedby")!)!)).toBe(expected.error);
      expect(actions.setPendingEmail).not.toHaveBeenCalled();
      expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
      expect(status()).toBe("");
    },
  );

  it("drops the field's error as soon as the address is changed", async () => {
    await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={peopleActions()} />);
    await click(button("Set email (Zed Ong)"));
    await click(button("Save email"));
    expect(text(dialog()!)).toContain("Enter an email address.");
    await type(address(), "z");
    expect(text(dialog()!)).not.toContain("Enter an email address.");
    expect(address().hasAttribute("aria-invalid")).toBe(false);
    expect(address().hasAttribute("aria-describedby")).toBe(false);
  });

  it("starts empty and offers no Forget email when nothing is noted", async () => {
    await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={peopleActions()} />);
    await click(button("Set email (Zed Ong)"));
    expect(address().value).toBe("");
    expect(queryButton("Forget email")).toBeNull();
    const said = (by: "aria-labelledby" | "aria-describedby") => text(document.getElementById(dialog()!.getAttribute(by)!)!);
    expect(said("aria-labelledby")).toBe("Email for Zed Ong's invite");
    expect(said("aria-describedby")).toContain("emails nobody now");
  });

  it("notes the address as it will be saved, says nobody was emailed, and gives focus back to its button", async () => {
    const actions = peopleActions();
    const page = await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
    await click(button("Set email (Zed Ong)"));
    await type(address(), "  Zed.Ong@Example.COM ");
    await click(button("Save email"));
    expect(actions.setPendingEmail).toHaveBeenCalledExactlyOnceWith("m-zed", "zed.ong@example.com");
    expect(dialog()).toBeNull();
    expect(status()).toBe("Noted zed.ong@example.com for Zed Ong's invite. Nobody was emailed.");
    expect(actions.giveLogin).not.toHaveBeenCalled();

    // The server action re-renders the page with the address noted: the button stays, as Edit email.
    await page.rerender(
      <PeopleSection team={TEAM} people={[{ ...ZED, pendingEmail: "zed.ong@example.com" }]} candidates={[]} actions={actions} />,
    );
    await frames();
    expect(text(page.container)).toContain("Email noted for their invite: zed.ong@example.com. Nobody has been emailed yet.");
    expect(document.activeElement).toBe(button("Edit email (Zed Ong)"));
    expect(text(page.container)).toContain("Send invites (1)");
  });

  it("starts with the noted address, and saves it as it is when Save is pressed", async () => {
    const actions = peopleActions();
    await render(<PeopleSection team={TEAM} people={[NOTED]} candidates={[]} actions={actions} />);
    await click(button("Edit email (Zed Ong)"));
    expect(address().value).toBe("zed@example.com");
    await click(button("Save email"));
    expect(actions.setPendingEmail).toHaveBeenCalledExactlyOnceWith("m-zed", "zed@example.com");
    expect(status()).toBe("Noted zed@example.com for Zed Ong's invite. Nobody was emailed.");
  });

  it("forgets the noted address with Forget email, whatever is in the field, and says so", async () => {
    const actions = peopleActions();
    const page = await render(<PeopleSection team={TEAM} people={[NOTED]} candidates={[]} actions={actions} />);
    await click(button("Edit email (Zed Ong)"));
    await type(address(), "not an address");
    await click(button("Forget email"));
    expect(actions.setPendingEmail).toHaveBeenCalledExactlyOnceWith("m-zed", null);
    expect(dialog()).toBeNull();
    expect(status()).toBe("Forgot the email noted for Zed Ong.");

    await page.rerender(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
    await frames();
    expect(text(page.container)).not.toContain("Email noted for their invite");
    expect(queryButton(/^Send invites/)).toBeNull();
    expect(document.activeElement).toBe(button("Set email (Zed Ong)"));
  });

  it("drops a field error when Forget email is pressed, and shows its refusal instead", async () => {
    const actions = peopleActions({ setPendingEmail: vi.fn(refuse("This person doesn't exist any more. Reload the page.")) });
    await render(<PeopleSection team={TEAM} people={[NOTED]} candidates={[]} actions={actions} />);
    await click(button("Edit email (Zed Ong)"));
    await type(address(), "zed@example");
    await click(button("Save email"));
    expect(text(dialog()!)).toContain("Enter an email address like name@example.com.");

    await click(button("Forget email"));
    expect(actions.setPendingEmail).toHaveBeenCalledExactlyOnceWith("m-zed", null);
    expect(text(dialog()!)).not.toContain("Enter an email address like name@example.com.");
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe("This person doesn't exist any more. Reload the page.");
  });

  it.each([
    ["the address is noted for someone else", EMAIL_NOTED],
    ["they were given a login meanwhile", "This person already has a login. To change the address they sign in with, use Change email."],
  ])("shows a refusal in the dialog and keeps what was typed (%s)", async (_label, refusal) => {
    const actions = peopleActions({ setPendingEmail: vi.fn(refuse(refusal)) });
    await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
    await click(button("Set email (Zed Ong)"));
    await type(address(), "zed@example.com");
    await click(button("Save email"));
    expect(dialog()).not.toBeNull();
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(refusal);
    expect(address().value).toBe("zed@example.com");
    expect(button("Save email").disabled).toBe(false);
    expect(status()).toBe("");
  });

  it("drops an earlier refusal when the next address doesn't pass the field check", async () => {
    const actions = peopleActions({ setPendingEmail: vi.fn(refuse(EMAIL_NOTED)) });
    await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
    await click(button("Set email (Zed Ong)"));
    await type(address(), "taken@example.com");
    await click(button("Save email"));
    expect(text(dialog()!)).toContain(EMAIL_NOTED);
    await type(address(), "zed@example");
    await click(button("Save email"));
    expect(text(dialog()!)).toContain("Enter an email address like name@example.com.");
    expect(text(dialog()!)).not.toContain(EMAIL_NOTED);
    expect(actions.setPendingEmail).toHaveBeenCalledOnce();
  });

  it("says Saving… while it saves and can't be closed meanwhile, by Escape, its X or Cancel", async () => {
    const answer = deferred<ActionResult>();
    const actions = peopleActions({ setPendingEmail: vi.fn(() => answer.promise) });
    await render(<PeopleSection team={TEAM} people={[NOTED]} candidates={[]} actions={actions} />);
    await click(button("Edit email (Zed Ong)"));
    await type(address(), "zed.ong@example.com");
    await click(button("Save email"));
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(button("Forget email").disabled).toBe(true);
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();
    await click(cornerClose());
    expect(dialog()).not.toBeNull();
    expect(status()).toBe("");

    await act(async () => answer.resolve({ ok: true, value: null }));
    expect(dialog()).toBeNull();
    expect(status()).toBe("Noted zed.ong@example.com for Zed Ong's invite. Nobody was emailed.");
  });

  it("can be closed again once a refusal is in", async () => {
    const answer = deferred<ActionResult>();
    await render(
      <PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={peopleActions({ setPendingEmail: vi.fn(() => answer.promise) })} />,
    );
    await click(button("Set email (Zed Ong)"));
    await type(address(), "zed@example.com");
    await click(button("Save email"));
    await act(async () => answer.resolve({ ok: false, error: EMAIL_NOTED }));
    expect(button("Cancel").disabled).toBe(false);
    await press(dialog()!, "Escape");
    expect(dialog()).toBeNull();
    expect(status()).toBe("");
  });

  it("starts afresh from the noted address each time it opens", async () => {
    await render(<PeopleSection team={TEAM} people={[NOTED]} candidates={[]} actions={peopleActions()} />);
    await click(button("Edit email (Zed Ong)"));
    await type(address(), "zed@example");
    await click(button("Save email"));
    expect(text(dialog()!)).toContain("Enter an email address like name@example.com.");
    await click(button("Cancel"));
    expect(dialog()).toBeNull();

    await click(button("Edit email (Zed Ong)"));
    expect(address().value).toBe("zed@example.com");
    expect(text(dialog()!)).not.toContain("Enter an email address like name@example.com.");
  });

  it("reads a Set email that throws as something going wrong, and logs no name or address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const actions = peopleActions({ setPendingEmail: vi.fn(throwing("could not note zed@example.com for Zed Ong")) });
    await render(<PeopleSection team={TEAM} people={[ZED]} candidates={[]} actions={actions} />);
    await click(button("Set email (Zed Ong)"));
    await type(address(), "zed@example.com");
    await click(button("Save email"));
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(GENERIC_ERROR);
    expect(spy).toHaveBeenCalledExactlyOnceWith("setPendingEmail failed", { code: "ECONNRESET", status: undefined });
    expect(logged(spy)).not.toMatch(/zed|Zed|example\.com/);
  });
});

describe("PeopleSection: Give login with a noted address", () => {
  it("starts with the address noted for their invite, and sends it as it is", async () => {
    const actions = peopleActions();
    await render(
      <PeopleSection team={TEAM} people={[person("m-zed", "Zed Ong", { pendingEmail: "zed@example.com" })]} candidates={[]} actions={actions} />,
    );
    await click(button("Give login (Zed Ong)"));
    expect(labelled<HTMLInputElement>("Email address").value).toBe("zed@example.com");
    await click(button("Send invite"));
    expect(actions.giveLogin).toHaveBeenCalledExactlyOnceWith("m-zed", "zed@example.com");
    expect(status()).toBe("Invite sent to zed@example.com. Zed Ong can sign in from the link in it.");
  });

  it("lets the admin send it to another address than the noted one", async () => {
    const actions = peopleActions();
    await render(
      <PeopleSection team={TEAM} people={[person("m-zed", "Zed Ong", { pendingEmail: "zed@example.com" })]} candidates={[]} actions={actions} />,
    );
    await click(button("Give login (Zed Ong)"));
    await type(labelled<HTMLInputElement>("Email address"), "Zed.Ong@Example.com");
    await click(button("Send invite"));
    expect(actions.giveLogin).toHaveBeenCalledExactlyOnceWith("m-zed", "zed.ong@example.com");
  });

  it("starts empty when nothing is noted", async () => {
    await render(<PeopleSection team={TEAM} people={[person("m-zed", "Zed Ong")]} candidates={[]} actions={peopleActions()} />);
    await click(button("Give login (Zed Ong)"));
    expect(labelled<HTMLInputElement>("Email address").value).toBe("");
  });

  it("shows giveLogin's refusal when the address is noted for someone else", async () => {
    const actions = peopleActions({ giveLogin: vi.fn(refuse(NOTED_FOR_SOMEONE_ELSE)) });
    await render(<PeopleSection team={TEAM} people={[person("m-zed", "Zed Ong")]} candidates={[]} actions={actions} />);
    await click(button("Give login (Zed Ong)"));
    await type(labelled<HTMLInputElement>("Email address"), "ana@example.com");
    await click(button("Send invite"));
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(NOTED_FOR_SOMEONE_ELSE);
  });
});

// ---------- Send invites ----------

const ANA = person("m-ana", "Ana Lee", { pendingEmail: "ana@example.com" });
const BEN = person("m-ben", "Ben Kho", { pendingEmail: "ben@example.com" });
const CAT = person("m-cat", "Cat Ng", { pendingEmail: "cat@example.com" });
const DAN = person("m-dan", "Dan Lim", { pendingEmail: "dan@example.com" });
const ZED = person("m-zed", "Zed Ong"); // nothing noted

// Who the open dialog lists, as "Name · address".
const listed = () => [...dialog()!.querySelectorAll('ul[aria-label="Who gets an invite"] > li')].map((li) => text(li));
// What the open dialog's own status line says while it sends.
const progress = () => text(dialog()!.querySelector('[role="status"]')!);
// A giveLogin that answers each person as the test says (ok when not said).
const answering = (answers: Record<string, string>) =>
  vi.fn<GiveLogin>(async (memberId) =>
    answers[memberId] === undefined ? { ok: true, value: null } : { ok: false, error: answers[memberId] },
  );
// A giveLogin whose answers the test gives one by one.
function answeredByHand() {
  const answers: ((result: ActionResult) => void)[] = [];
  const giveLogin = vi.fn<GiveLogin>(() => new Promise<ActionResult>((resolve) => answers.push(resolve)));
  const answer = (index: number, result: ActionResult = { ok: true, value: null }) => act(async () => answers[index](result));
  return { giveLogin, answer };
}

describe("PeopleSection: Send invites", () => {
  it("lists who it's for and their addresses, sends each invite in turn, and says how it went", async () => {
    const actions = peopleActions();
    await render(<PeopleSection team={TEAM} people={[ANA, ZED, BEN]} candidates={[]} actions={actions} />);
    await click(button("Send invites (2)"));
    expect(text(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)!)).toBe("Send 2 invites?");
    expect(listed()).toEqual(["Ana Lee · ana@example.com", "Ben Kho · ben@example.com"]);
    expect(actions.giveLogin).not.toHaveBeenCalled();

    await click(button("Send 2 invites"));
    expect(actions.giveLogin.mock.calls).toEqual([
      ["m-ana", "ana@example.com", true],
      ["m-ben", "ben@example.com", true],
    ]);
    expect(text(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)!)).toBe("Invites sent");
    expect(text(document.getElementById(dialog()!.getAttribute("aria-describedby")!)!)).toBe("Sent 2 invites.");
    expect(status()).toBe("Sent 2 invites.");
    expect(actions.setPendingEmail).not.toHaveBeenCalled();
  });

  it("sends one at a time, says which it's on, and can't be closed while it sends", async () => {
    const { giveLogin, answer } = answeredByHand();
    await render(<PeopleSection team={TEAM} people={[ANA, BEN, CAT]} candidates={[]} actions={peopleActions({ giveLogin })} />);
    await click(button("Send invites (3)"));
    await click(button("Send 3 invites"));
    expect(giveLogin).toHaveBeenCalledOnce();
    expect(progress()).toBe("Sending 1 of 3…");
    expect(button("Sending…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();
    await click(cornerClose());
    expect(dialog()).not.toBeNull();

    await answer(0);
    expect(giveLogin).toHaveBeenCalledTimes(2);
    expect(progress()).toBe("Sending 2 of 3…");
    await answer(1, { ok: false, error: EMAIL_TAKEN });
    expect(giveLogin).toHaveBeenCalledTimes(3);
    expect(progress()).toBe("Sending 3 of 3…");
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();
    expect(status()).toBe("");

    await answer(2);
    expect(progress()).toBe("");
    expect(text(dialog()!)).toContain("Invites sent");
    expect(status()).toBe("Sent 2 invites. 1 person still needs one: see their rows.");
    expect(giveLogin.mock.calls.map(([id]) => id)).toEqual(["m-ana", "m-ben", "m-cat"]);
  });

  it("keeps the list it opened with, even when who has an address noted changes before and while it sends", async () => {
    const { giveLogin, answer } = answeredByHand();
    const actions = peopleActions({ giveLogin });
    const page = await render(<PeopleSection team={TEAM} people={[ANA, BEN]} candidates={[]} actions={actions} />);
    await click(button("Send invites (2)"));
    // Someone else notes Cat's address while the dialog is open.
    await page.rerender(<PeopleSection team={TEAM} people={[ANA, BEN, CAT]} candidates={[]} actions={actions} />);
    expect(listed()).toEqual(["Ana Lee · ana@example.com", "Ben Kho · ben@example.com"]);
    expect(button("Send 2 invites")).toBeDefined();

    await click(button("Send 2 invites"));
    await answer(0);
    // Ana's login shows up as the page refreshes, mid-run; Ben's noted address changes too.
    await page.rerender(
      <PeopleSection
        team={TEAM}
        people={[withLogin(ANA), { ...BEN, pendingEmail: "ben.kho@example.com" }, CAT]}
        candidates={[]}
        actions={actions}
      />,
    );
    await answer(1);
    expect(giveLogin.mock.calls).toEqual([
      ["m-ana", "ana@example.com", true],
      ["m-ben", "ben@example.com", true],
    ]);
    expect(text(dialog()!)).toContain("Sent 2 invites.");
    // The button behind the dialog offers whoever is left now.
    expect(queryButton("Send invites (2)")).not.toBeNull();
  });

  it("says who wasn't sent an invite and why, going on past a refusal about one person and stopping at one about everyone", async () => {
    const giveLogin = answering({ "m-ben": EMAIL_TAKEN, "m-cat": TOO_MANY_EMAILS });
    await render(<PeopleSection team={TEAM} people={[ANA, BEN, CAT, DAN]} candidates={[]} actions={peopleActions({ giveLogin })} />);
    await click(button("Send invites (4)"));
    await click(button("Send 4 invites"));
    expect(giveLogin.mock.calls.map(([id]) => id)).toEqual(["m-ana", "m-ben", "m-cat"]);
    expect(words(dialog()!)).toContain(`Not sent Ben Kho (ben@example.com): ${EMAIL_TAKEN}`);
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(
      `Sending stopped: ${TOO_MANY_EMAILS} Not sent yet: Cat Ng, Dan Lim.`,
    );
    expect(status()).toBe("Sent 1 invite. 3 people still need one: see their rows.");
    // There's nothing more to press but Close.
    expect(queryButton(/^Send \d/)).toBeNull();
    expect(queryButton("Cancel")).toBeNull();
  });

  it("stops at a giveLogin that throws, reads it as something going wrong, and logs no name or address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const giveLogin = vi.fn(throwing("invite for ana@example.com (Ana Lee) failed"));
    await render(<PeopleSection team={TEAM} people={[ANA, BEN]} candidates={[]} actions={peopleActions({ giveLogin })} />);
    await click(button("Send invites (2)"));
    await click(button("Send 2 invites"));
    expect(giveLogin).toHaveBeenCalledOnce();
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(`Sending stopped: ${GENERIC_ERROR} Not sent yet: Ana Lee, Ben Kho.`);
    expect(status()).toBe("No invites were sent. 2 people still need one: see their rows.");
    expect(spy).toHaveBeenCalledExactlyOnceWith("giveLogin failed", { code: "ECONNRESET", status: undefined });
    expect(logged(spy)).not.toMatch(/ana|Ana|ben|Ben|example\.com/);
  });

  it("drops its button once the last invite has gone, but keeps the dialog open with what happened", async () => {
    const actions = peopleActions();
    const page = await render(<PeopleSection team={TEAM} people={[ANA, BEN]} candidates={[]} actions={actions} />);
    await click(button("Send invites (2)"));
    await click(button("Send 2 invites"));
    // The server actions re-render the page: both have a login now.
    await page.rerender(<PeopleSection team={TEAM} people={[withLogin(ANA), withLogin(BEN)]} candidates={[]} actions={actions} />);
    expect(queryButton(/^Send invites/)).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(words(dialog()!)).toContain("Invites sent Sent 2 invites.");

    // Closing it puts focus on the People heading, since its button has gone.
    await click(footerButton("Close"));
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement?.tagName).toBe("H2");
    expect(text(document.activeElement!)).toBe("People (2)");
    expect(status()).toBe("Sent 2 invites.");
  });

  it("puts focus on the People heading after sending even when its button stays, offering fewer people", async () => {
    const actions = peopleActions({ giveLogin: answering({ "m-ben": EMAIL_TAKEN }) });
    const page = await render(<PeopleSection team={TEAM} people={[ANA, BEN]} candidates={[]} actions={actions} />);
    await click(button("Send invites (2)"));
    await click(button("Send 2 invites"));
    await page.rerender(<PeopleSection team={TEAM} people={[withLogin(ANA), BEN]} candidates={[]} actions={actions} />);
    expect(queryButton("Send invites (1)")).not.toBeNull();
    await press(dialog()!, "Escape");
    await frames();
    expect(dialog()).toBeNull();
    expect(text(document.activeElement!)).toBe("People (2)");
  });

  it("sends nothing on Cancel, and gives focus back to its button", async () => {
    const actions = peopleActions();
    await render(<PeopleSection team={TEAM} people={[ANA, BEN]} candidates={[]} actions={actions} />);
    await click(button("Send invites (2)"));
    await click(button("Cancel"));
    await frames();
    expect(dialog()).toBeNull();
    expect(actions.giveLogin).not.toHaveBeenCalled();
    expect(status()).toBe("");
    expect(document.activeElement).toBe(button("Send invites (2)"));
  });

  it("starts afresh with whoever is listed then when it opens again", async () => {
    const actions = peopleActions({ giveLogin: answering({ "m-ben": EMAIL_TAKEN }) });
    const page = await render(<PeopleSection team={TEAM} people={[ANA, BEN]} candidates={[]} actions={actions} />);
    await click(button("Send invites (2)"));
    await click(button("Send 2 invites"));
    await click(footerButton("Close"));
    await page.rerender(
      <PeopleSection team={TEAM} people={[withLogin(ANA), { ...BEN, pendingEmail: "ben.kho@example.com" }, CAT]} candidates={[]} actions={actions} />,
    );

    await click(button("Send invites (2)"));
    expect(text(dialog()!)).toMatch(/^Send 2 invites\?/);
    expect(listed()).toEqual(["Ben Kho · ben.kho@example.com", "Cat Ng · cat@example.com"]);
    expect(text(dialog()!)).not.toContain("Not sent");
    expect(progress()).toBe("");
    expect(button("Send 2 invites").disabled).toBe(false);
  });
});

describe("SendInvitesDialog", () => {
  const invitee = (p: Person): Invitee => ({ id: p.id, name: p.name, email: p.pendingEmail! });
  const renderDialog = (invitees: Invitee[], giveLogin = answering({}), onDone = vi.fn()) =>
    render(
      <>
        <h2 id="heading" tabIndex={-1}>
          People
        </h2>
        <SendInvitesDialog invitees={invitees} giveLogin={giveLogin} onDone={onDone} focusAfter="#heading" />
      </>,
    );

  it("hands onDone what the page's status line should say, once, when it's over", async () => {
    const onDone = vi.fn();
    const { giveLogin, answer } = answeredByHand();
    await renderDialog([invitee(ANA), invitee(BEN)], giveLogin, onDone);
    await click(button("Send invites (2)"));
    await click(button("Send 2 invites"));
    await answer(0);
    expect(onDone).not.toHaveBeenCalled();
    await answer(1, { ok: false, error: NOTED_FOR_SOMEONE_ELSE });
    expect(onDone).toHaveBeenCalledExactlyOnceWith("Sent 1 invite. 1 person still needs one: see their rows.");
    expect(words(dialog()!)).toContain(`Not sent Ben Kho (ben@example.com): ${NOTED_FOR_SOMEONE_ELSE}`);
  });

  it("keeps showing what happened when its invitees go while it's open, then renders nothing once closed", async () => {
    const giveLogin = answering({});
    const page = await renderDialog([invitee(ANA)], giveLogin);
    await click(button("Send invites (1)"));
    await click(button("Send 1 invite"));
    await page.rerender(
      <>
        <h2 id="heading" tabIndex={-1}>
          People
        </h2>
        <SendInvitesDialog invitees={[]} giveLogin={giveLogin} onDone={() => {}} focusAfter="#heading" />
      </>,
    );
    expect(queryButton(/^Send invites/)).toBeNull();
    expect(words(dialog()!)).toContain("Invites sent Sent 1 invite.");
    await click(cornerClose());
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe("heading");
    expect(text(page.container)).toBe("People");
  });
});

describe("SendInvitesDialog: closing", () => {
  const invitee = (p: Person): Invitee => ({ id: p.id, name: p.name, email: p.pendingEmail! });
  const page = (invitees: Invitee[]) => (
    <>
      <h2 id="heading" tabIndex={-1}>
        People
      </h2>
      <SendInvitesDialog invitees={invitees} giveLogin={answering({})} onDone={() => {}} focusAfter="#heading" />
    </>
  );

  it("keeps its list while it animates closed after Cancel, and gives focus back to its button", async () => {
    await render(page([invitee(ANA), invitee(BEN)]));
    await click(button("Send invites (2)"));
    await click(button("Cancel"));
    // Still drawn as it closes: never an empty box.
    if (dialog()) expect(words(dialog()!)).toContain("Send 2 invites?");
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button("Send invites (2)"));
  });

  it("focuses the heading when it's cancelled after its button went (other admins sent the invites meanwhile)", async () => {
    const view = await render(page([invitee(ANA)]));
    await click(button("Send invites (1)"));
    await view.rerender(page([]));
    expect(queryButton(/^Send invites/)).toBeNull();
    expect(words(dialog()!)).toContain("Send 1 invite?");
    await click(button("Cancel"));
    await frames();
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe("heading");
  });
});

// ---------- Add a list ----------

describe("AddListDialog", () => {
  const people = () => labelled<HTMLTextAreaElement>("People");
  // The preview, one entry per listed line.
  const preview = () => [...dialog()!.querySelectorAll('ul[aria-label="The list, line by line"] > li')];
  const previewText = () => preview().map(words);
  const previewHeading = () => text(document.getElementById(dialog()!.querySelector("section")!.getAttribute("aria-labelledby")!)!);
  const radio = (value: string) => dialog()!.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  const created = (added: number) => vi.fn<CreateMembers>(async () => ({ ok: true, value: { added } }));

  const renderList = (
    changes: Partial<{ team: TeamSummary; here: string[]; elsewhere: string[]; createMembers: Mock<CreateMembers>; onDone: () => void }> = {},
  ) => {
    const props = { team: TEAM, here: [], elsewhere: [], createMembers: created(1), onDone: vi.fn(), ...changes };
    return render(<AddListDialog {...props} />).then(async (page) => {
      await click(button("Add a list"));
      return { page, ...props };
    });
  };

  it("previews the list line by line as it's typed, counting blank lines but not listing them", async () => {
    await renderList();
    expect(dialog()!.querySelector("section")).toBeNull();
    expect(button("Add people")).toBeDefined();

    await type(people(), "Mei Wong, Mei@Example.com\n\nLeo Tan <leo@example.com>, Leader\nZed Ong");
    expect(previewHeading()).toBe("3 people to add");
    expect(previewText()).toEqual([
      "Line 1: Mei Wong · mei@example.com · Member",
      "Line 3: Leo Tan · leo@example.com · Leader",
      "Line 4: Zed Ong · no email · Member",
    ]);
    expect(button("Add 3 people")).toBeDefined();

    await type(people(), "Mei Wong");
    expect(previewHeading()).toBe("1 person to add");
    expect(button("Add 1 person")).toBeDefined();

    await type(people(), "");
    expect(dialog()!.querySelector("section")).toBeNull();
  });

  it("reads a list pasted from a spreadsheet, skipping its column headings", async () => {
    await renderList();
    await type(people(), "Name\tEmail\tRole\nMei Wong, Lab lead\tmei@example.com\tLeader\nZed Ong\t\t");
    expect(previewText()).toEqual(["Line 2: Mei Wong, Lab lead · mei@example.com · Leader", "Line 3: Zed Ong · no email · Member"]);
  });

  it("marks the lines to fix, with what's wrong and what was typed", async () => {
    await renderList();
    await type(
      people(),
      ["Mei Wong, mei@example", "Leo Tan, leo@example.com", ", zed@example.com", "Ana Lee, ana@example.com, Master Admin", "Ben Kho, leo@example.com"].join(
        "\n",
      ),
    );
    expect(previewHeading()).toBe("1 person to add, and 4 lines to fix");
    expect(previewText()).toEqual([
      "Line 1: Enter an email address like name@example.com. Mei Wong, mei@example",
      "Line 2: Leo Tan · leo@example.com · Member",
      "Line 3: Enter a name. , zed@example.com",
      "Line 4: Only the project owner makes someone a Master Admin. Ana Lee, ana@example.com, Master Admin",
      "Line 5: That email is on line 2 too. Ben Kho, leo@example.com",
    ]);
    expect(preview().map((li) => li.classList.contains("text-destructive"))).toEqual([true, false, true, true, true]);
    expect(button("Add 1 person")).toBeDefined();
  });

  it("gives each line without a role the list's role, and keeps a line's own", async () => {
    const { createMembers } = await renderList({ createMembers: created(3) });
    await type(people(), "Mei Wong\nLeo Tan, Member\nAna Lee, leader");
    expect(radio("member").checked).toBe(true);
    expect(previewText()).toEqual(["Line 1: Mei Wong · no email · Member", "Line 2: Leo Tan · no email · Member", "Line 3: Ana Lee · no email · Leader"]);

    await click(radio("leader"));
    expect(radio("leader").checked).toBe(true);
    expect(previewText()).toEqual(["Line 1: Mei Wong · no email · Leader", "Line 2: Leo Tan · no email · Member", "Line 3: Ana Lee · no email · Leader"]);

    await click(button("Add 3 people"));
    expect(createMembers).toHaveBeenCalledExactlyOnceWith(TEAM.id, [
      { name: "Mei Wong", email: null, role: "leader" },
      { name: "Leo Tan", email: null, role: "member" },
      { name: "Ana Lee", email: null, role: "leader" },
    ]);
  });

  it("makes everyone a leader where everyone leads, whatever a line says, and offers no role to choose", async () => {
    const { createMembers, onDone } = await renderList({ team: DIVISION, createMembers: created(2) });
    expect(dialog()!.querySelector('input[type="radio"]')).toBeNull();
    expect(text(dialog()!)).toContain("Everyone placed in a division leads it, so they'll all be leaders.");
    await type(people(), "Mei Wong, Member, mei@example.com\nZed Ong");
    expect(previewText()).toEqual(["Line 1: Mei Wong · mei@example.com · Leader", "Line 2: Zed Ong · no email · Leader"]);
    await click(button("Add 2 people"));
    expect(createMembers).toHaveBeenCalledExactlyOnceWith(DIVISION.id, [
      { name: "Mei Wong", email: "mei@example.com", role: "leader" },
      { name: "Zed Ong", email: null, role: "leader" },
    ]);
    expect(onDone).toHaveBeenCalledExactlyOnceWith(addedListMessage(DIVISION, 2, 1));
  });

  it.each([
    ["one line", "Mei Wong\nZed Ong, zed@example", "Fix line 2 first. Nobody has been added yet."],
    ["several lines", "Mei Wong, Master Admin\nZed Ong\n\n, a@example.com", "Fix lines 1, 4 first. Nobody has been added yet."],
  ])("won't add a list with %s to fix, says which, and calls nothing", async (_label, list, refusal) => {
    const { createMembers, onDone } = await renderList();
    await type(people(), list);
    await click(button(/^Add \d/));
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(refusal);
    expect(createMembers).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    // Changing the list drops the refusal.
    await type(people(), "Mei Wong");
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
  });

  it(`won't add more than ${MAX_PEOPLE} people in one list, and says to add the rest in another`, async () => {
    const { createMembers } = await renderList();
    const list = Array.from({ length: MAX_PEOPLE + 2 }, (_, i) => `Person ${i + 1}`).join("\n");
    await type(people(), list);
    expect(previewHeading()).toBe(`${MAX_PEOPLE} people to add, and 2 lines to fix`);
    const over = `A list can add at most ${MAX_PEOPLE} people. Add the rest in another list.`;
    expect(previewText().slice(-3)).toEqual([
      `Line ${MAX_PEOPLE}: Person ${MAX_PEOPLE} · no email · Member`,
      `Line ${MAX_PEOPLE + 1}: ${over} Person ${MAX_PEOPLE + 1}`,
      `Line ${MAX_PEOPLE + 2}: ${over} Person ${MAX_PEOPLE + 2}`,
    ]);
    await click(button(`Add ${MAX_PEOPLE} people`));
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(
      `Fix lines ${MAX_PEOPLE + 1}, ${MAX_PEOPLE + 2} first. Nobody has been added yet.`,
    );
    expect(createMembers).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", ""],
    ["blank lines", "\n   \n"],
    ["only column headings", "Name\tEmail"],
  ])("asks for someone when the list holds %s", async (_label, list) => {
    const { createMembers } = await renderList();
    if (list) await type(people(), list);
    await click(button("Add people"));
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe("Type or paste at least one person, one per line.");
    expect(createMembers).not.toHaveBeenCalled();
  });

  it("adds a good list in one go, each with their email as it will be saved, and says what it did", async () => {
    const { createMembers, onDone } = await renderList({ createMembers: created(3) });
    await type(people(), "Mei Wong, Mei.Wong@Example.COM\nZed Ong\nLeo Tan; leo@example.com; Leader");
    await click(button("Add 3 people"));
    expect(createMembers).toHaveBeenCalledExactlyOnceWith(TEAM.id, [
      { name: "Mei Wong", email: "mei.wong@example.com", role: "member" },
      { name: "Zed Ong", email: null, role: "member" },
      { name: "Leo Tan", email: "leo@example.com", role: "leader" },
    ]);
    expect(dialog()).toBeNull();
    expect(onDone).toHaveBeenCalledExactlyOnceWith(
      "Added 3 people to IP Lab 1. 2 emails are noted for their invites, and nobody was emailed: give them a login when you're ready.",
    );
  });

  it("shows a refusal in the dialog and keeps the list as it was", async () => {
    const list = "Mei Wong, mei@example.com\nZed Ong";
    const refusal = notedForOthers(["mei@example.com"]);
    const { createMembers, onDone } = await renderList({
      createMembers: vi.fn<CreateMembers>(async () => ({ ok: false, error: refusal })),
    });
    await type(people(), list);
    await click(button("Add 2 people"));
    expect(createMembers).toHaveBeenCalledOnce();
    expect(dialog()).not.toBeNull();
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(refusal);
    expect(people().value).toBe(list);
    expect(button("Add 2 people").disabled).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says Adding… while it adds and can't be closed meanwhile", async () => {
    const answer = deferred<ActionResult<{ added: number }>>();
    const createMembers = vi.fn(() => answer.promise);
    const onDone = vi.fn();
    await render(<AddListDialog team={TEAM} here={[]} elsewhere={[]} createMembers={createMembers} onDone={onDone} />);
    await click(button("Add a list"));
    await type(people(), "Mei Wong\nZed Ong");
    await click(button("Add 2 people"));
    expect(button("Adding…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await press(dialog()!, "Escape");
    expect(dialog()).not.toBeNull();
    await click(cornerClose());
    expect(dialog()).not.toBeNull();
    // Pressing it again does nothing while the first is in flight.
    await click(button("Adding…"));
    expect(createMembers).toHaveBeenCalledOnce();

    await act(async () => answer.resolve({ ok: true, value: { added: 2 } }));
    expect(dialog()).toBeNull();
    expect(onDone).toHaveBeenCalledExactlyOnceWith("Added 2 people to IP Lab 1. They have no login until you give them one.");
  });

  it("flags names already in this node or elsewhere in Module One, and still adds them if asked", async () => {
    const { createMembers } = await renderList({ here: ["Mei Wong"], elsewhere: ["Ben Kho", "Mei Wong"], createMembers: created(3) });
    await type(people(), "mei  WONG\nBen Kho, ben@example.com\nZed Ong");
    expect(previewText()).toEqual([
      "Line 1: mei WONG · no email · Member Someone called mei WONG is already in IP Lab 1.",
      "Line 2: Ben Kho · ben@example.com · Member Someone called Ben Kho is already in Module One. To move them here, use Add people instead.",
      "Line 3: Zed Ong · no email · Member",
    ]);
    await click(button("Add 3 people"));
    expect(createMembers).toHaveBeenCalledOnce();
  });

  it("reads an Add a list that throws as something going wrong, and logs no name or address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderList({ createMembers: vi.fn<CreateMembers>(throwing("Mei Wong <mei@example.com> failed")) });
    await type(people(), "Mei Wong, mei@example.com");
    await click(button("Add 1 person"));
    expect(text(dialog()!.querySelector('[role="alert"]')!)).toBe(GENERIC_ERROR);
    expect(spy).toHaveBeenCalledExactlyOnceWith("createMembers failed", { code: "ECONNRESET", status: undefined });
    expect(logged(spy)).not.toMatch(/mei|Mei|Wong|example\.com/);
  });

  it("starts afresh each time it opens", async () => {
    await renderList();
    await type(people(), "Mei Wong, mei@example");
    await click(button("Add people"));
    await click(radio("leader"));
    await click(button("Cancel"));
    expect(dialog()).toBeNull();

    await click(button("Add a list"));
    expect(people().value).toBe("");
    expect(radio("member").checked).toBe(true);
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    expect(dialog()!.querySelector("section")).toBeNull();
  });
});

describe("PeopleSection: Add a list", () => {
  const CANDIDATES: Candidate[] = [{ id: "m-ben", name: "Ben Kho", teamId: "t-2", teamName: "IP Lab 2" }];

  it("checks names against the people here and those who could be added, adds to this node, and says what it did", async () => {
    const actions = peopleActions({ createMembers: vi.fn(async () => ({ ok: true as const, value: { added: 2 } })) });
    await render(<PeopleSection team={TEAM} people={[ZED]} candidates={CANDIDATES} actions={actions} />);
    await click(button("Add a list"));
    await type(labelled<HTMLTextAreaElement>("People"), "Zed Ong\nBen Kho, ben@example.com");
    expect(text(dialog()!)).toContain("Someone called Zed Ong is already in IP Lab 1.");
    expect(text(dialog()!)).toContain("Someone called Ben Kho is already in Module One. To move them here, use Add people instead.");
    await click(button("Add 2 people"));
    expect(actions.createMembers).toHaveBeenCalledExactlyOnceWith(TEAM.id, [
      { name: "Zed Ong", email: null, role: "member" },
      { name: "Ben Kho", email: "ben@example.com", role: "member" },
    ]);
    expect(dialog()).toBeNull();
    expect(status()).toBe(
      "Added 2 people to IP Lab 1. 1 email is noted for their invites, and nobody was emailed: give them a login when you're ready.",
    );
  });
});
