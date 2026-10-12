// How the pieces for noted invite emails (migration 0014) render: Set email, Add a list, Send
// invites, Give login starting from the noted address, and where People offers each of them. Also
// sendInvites and the sentences the page shows once a list is added or invites have gone.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALREADY_HAS_LOGIN,
  BAD_REQUEST,
  EARLIER_LOGIN,
  EMAIL_FORMAT,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  MASTER_ADMIN_LOGIN,
  MISSING_SITE_URL,
  NO_EMAIL_SENDER,
  NOT_YOURSELF,
  NOTE_CHANGED,
  NOTED_FOR_SOMEONE_ELSE,
  PERSON_CHANGED,
  PERSON_GONE,
  PERSON_REMOVED,
  TOO_MANY_EMAILS,
} from "@/app/admin/teams/[id]/messages";
import type { Person, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { Dialog } from "@/components/ui/dialog";
import { type ActionResult, GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { MAX_PEOPLE } from "@/lib/admin/people-list";
import { AddListForm, addedListMessage } from "./add-list-dialog";
import { GiveLoginForm } from "./give-login-dialog";
import { PeopleSection, PersonRow } from "./people-section";
import { type Invitee, type InviteRun, invitesMessage, SendInvitesDialog, SendInvitesPanel, sendInvites } from "./send-invites-dialog";
import { SetEmailDialog, SetEmailForm } from "./set-email-dialog";
import type { TeamActions } from "./types";

const ok = async () => ({ ok: true as const, value: null });
const actions = {
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
};

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
const DOMAIN: TeamSummary = { ...TEAM, id: "c0000000-0000-4000-8000-000000000002", name: "IP Lab", kind: "domain", kindLabel: "Domain" };
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
const ORGANISATION: TeamSummary = { ...DIVISION, id: "c0000000-0000-4000-8000-000000000004", name: "The New Normal", kind: "organisation", kindLabel: "Organisation" };

// Not editable unless a test says so, so a row's buttons are only the login ones.
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
  pendingEmail: null,
  canSetEmail: false,
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

// As buildTeamView makes them: Give login is offered, the noted addresses were read, and one is
// noted (or not).
const noted = (id: string, name: string, email: string | null, changes: Partial<Person> = {}) =>
  person(id, name, { canGiveLogin: true, canSetEmail: true, pendingEmail: email, ...changes });

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
// Each radio button's value and whether it's chosen, in order.
const radios = (html: string) =>
  (html.match(/<input [^>]*type="radio"[^>]*>/g) ?? []).map((input) => ({
    value: /value="([^"]*)"/.exec(input)?.[1],
    checked: / checked=""/.test(input),
  }));

// The text of one person's <li> (the row whose first line is their name).
function row(html: string, name: string) {
  const item = (html.match(/<li[\s\S]*?<\/li>/g) ?? []).map(text).find((li) => li.startsWith(name));
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

// Dialog parts need a Dialog around them (closed dialogs render nothing, so tests render the
// content on its own).
const inDialog = (content: React.ReactNode) => renderToStaticMarkup(<Dialog>{content}</Dialog>);

const LINE = "Email noted for their invite";

describe("SetEmailForm", () => {
  const render = (pendingEmail: string | null) =>
    inDialog(
      <SetEmailForm person={{ id: "m-zed", name: "Zed Ong", pendingEmail }} setPendingEmail={actions.setPendingEmail} onDone={() => {}} />,
    );

  it("asks for the address their invite will go to, and says nobody is emailed now and who can sign in with it", () => {
    const html = render(null);
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Email address<\/label><input[^>]*type="email"[^>]*id="\1"/);
    expect(count(html, /<input/g)).toBe(1);
    expect(text(html)).toContain("Email for Zed Ong's invite");
    expect(text(html)).toContain(
      "Module One keeps this address for when you give Zed Ong a login, and emails nobody now. Only admins see it. " +
        "Use an address only they read: whoever reads the invite can sign in as Zed Ong.",
    );
  });

  it("starts empty and offers no Forget email when nothing is noted", () => {
    const html = render(null);
    expect(html).toMatch(/<input[^>]*type="email"[^>]*value=""/);
    expect(text(html)).not.toContain("Forget email");
    expect(text(html)).toMatch(/Cancel Save email$/);
  });

  it("starts with the noted address and offers Forget email", () => {
    const html = render("zed@example.com");
    expect(html).toMatch(/<input[^>]*type="email"[^>]*value="zed@example.com"/);
    expect(text(html)).toMatch(/Cancel Forget email Save email$/);
    // Forget email isn't a submit button: pressing Enter in the field saves, it never forgets.
    expect(html).toMatch(/<button [^>]*type="button"[^>]*>Forget email<\/button>/);
    expect(count(html, /type="submit"/g)).toBe(1);
    expect(html).toMatch(/<button [^>]*type="submit"[^>]*>Save email<\/button>/);
  });

  it("shows no error before anything is saved", () => {
    const html = render("zed@example.com");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(' aria-invalid="');
  });
});

describe("SetEmailDialog", () => {
  const render = (pendingEmail: string | null) =>
    renderToStaticMarkup(
      <SetEmailDialog person={{ id: "m-zed", name: "Zed Ong", pendingEmail }} setPendingEmail={actions.setPendingEmail} onDone={() => {}} />,
    );

  it("says Set email, with whose it is for screen readers, when nothing is noted", () => {
    const html = render(null);
    expect(html).toMatch(/<button [^>]*type="button"[^>]*>Set email<span class="sr-only"> \(Zed Ong\)<\/span><\/button>/);
    expect(text(html)).not.toContain("Edit email");
  });

  it("says Edit email, with whose it is for screen readers, once an address is noted", () => {
    const html = render("zed@example.com");
    expect(html).toMatch(/<button [^>]*type="button"[^>]*>Edit email<span class="sr-only"> \(Zed Ong\)<\/span><\/button>/);
    expect(text(html)).not.toContain("Set email");
  });

  it("renders only its button while closed, so the noted address isn't on the page twice", () => {
    expect(render("zed@example.com")).not.toContain("zed@example.com");
  });
});

describe("GiveLoginForm", () => {
  const render = (pendingEmail?: string | null) =>
    inDialog(<GiveLoginForm person={{ id: "m-zed", name: "Zed Ong", pendingEmail }} giveLogin={actions.giveLogin} onDone={() => {}} />);

  it("starts with the address noted for their invite", () => {
    expect(render("zed@example.com")).toMatch(/<input[^>]*type="email"[^>]*value="zed@example.com"/);
  });

  it.each([
    ["nothing is noted", null],
    ["the noted addresses couldn't be read", undefined],
  ])("starts empty when %s", (_label, pendingEmail) => {
    expect(render(pendingEmail)).toMatch(/<input[^>]*type="email"[^>]*value=""/);
  });
});

describe("PeopleSection: noted invite emails", () => {
  const render = (people: Person[], team = TEAM) =>
    renderToStaticMarkup(<PeopleSection team={team} people={people} candidates={[]} actions={actions} />);

  it("shows the noted address on the row, says nobody was emailed, and offers Edit email next to Give login", () => {
    const html = render([noted("m-zed", "Zed Ong", "zed@example.com")]);
    expect(row(html, "Zed Ong")).toBe(
      "Zed Ong Member No login yet Email noted for their invite: zed@example.com. Nobody has been emailed yet. " +
        "Give login (Zed Ong) Edit email (Zed Ong)",
    );
  });

  it("offers Set email, and no noted line, when Give login is offered and nothing is noted", () => {
    const html = render([noted("m-zed", "Zed Ong", null)]);
    expect(row(html, "Zed Ong")).toBe("Zed Ong Member No login yet Give login (Zed Ong) Set email (Zed Ong)");
  });

  it("offers no Set email when the noted addresses couldn't be read, and Give login asks as before", () => {
    const html = render([person("m-zed", "Zed Ong", { canGiveLogin: true })]);
    expect(row(html, "Zed Ong")).toBe("Zed Ong Member No login yet Give login (Zed Ong)");
    expect(text(html)).not.toMatch(/Set email|Edit email|Send invites/);
  });

  it("offers no Set email, and shows no noted line, on rows that can't be given a login", () => {
    const html = render([
      person("m-mei", "Mei Wong", { hasLogin: true, canResendInvite: true, canChangeEmail: true }),
      person("m-gus", "Gus Tay", { ownerGivesLogin: true, ownerKeeps: "grants" }),
      person("m-ada", "Ada Boss", { role: "hq", roleLabel: "Master Admin" }),
      person("m-hana", "Hana Lim", { isSelf: true }),
    ]);
    for (const name of ["Mei Wong", "Gus Tay", "Ada Boss", "Hana Lim"]) {
      expect(row(html, name)).not.toMatch(/Set email|Edit email|Email noted/);
    }
    expect(count(html, /Set email|Edit email/g)).toBe(0);
    expect(text(html)).not.toContain(LINE);
  });

  it("counts in Send invites only the people Give login is offered for who have an address noted", () => {
    const html = render([
      noted("m-ana", "Ana Lee", "ana@example.com"),
      noted("m-ben", "Ben Kho", null),
      noted("m-cat", "Cat Ng", "cat@example.com", { editable: true }),
      person("m-mei", "Mei Wong", { hasLogin: true, canResendInvite: true }),
      person("m-zed", "Zed Ong", { canGiveLogin: true }),
    ]);
    expect(html).toMatch(/<button [^>]*type="button"[^>]*>Send invites \(2\)<\/button>/);
    expect(count(html, /Send invites/g)).toBe(1);
    // The dialog is closed: nobody's address is listed twice.
    expect(count(html, /ana@example\.com/g)).toBe(1);
  });

  it("offers no Send invites when nobody here has an address noted", () => {
    const html = render([noted("m-ben", "Ben Kho", null), person("m-mei", "Mei Wong", { hasLogin: true })]);
    expect(text(html)).not.toContain("Send invites");
  });

  it("offers no Send invites when nobody is here", () => {
    expect(text(render([]))).not.toContain("Send invites");
  });

  it("puts Send invites before Add a list and Add people in the heading's buttons", () => {
    const html = text(render([noted("m-ana", "Ana Lee", "ana@example.com")]));
    expect(html).toMatch(/^People \(1\) Send invites \(1\) Add a list Add people /);
  });

  it.each([
    ["a team", TEAM],
    ["a domain", DOMAIN],
    ["a division", DIVISION],
  ])("offers Add a list wherever it offers Add people: %s", (_label, team) => {
    const html = text(render([], team));
    expect(html).toContain("Add a list");
    expect(html).toContain("Add people");
  });

  it("offers neither Add a list nor Add people on an archived node or the organisation", () => {
    for (const team of [{ ...TEAM, archived: true }, { ...DOMAIN, archived: true }, ORGANISATION]) {
      const html = text(render([], team));
      expect(html).not.toContain("Add a list");
      expect(html).not.toContain("Add people");
    }
  });

  it("still offers Send invites on an archived node and the organisation, where Give login is still offered", () => {
    for (const team of [{ ...TEAM, archived: true }, ORGANISATION]) {
      const html = render([noted("m-eli", "Eli Chao", "eli@example.com", { role: "leader", roleLabel: "Leader" })], team);
      expect(text(html)).toContain("Send invites (1)");
      expect(row(html, "Eli Chao")).toContain("Give login (Eli Chao) Edit email (Eli Chao)");
    }
  });
});

describe("PersonRow", () => {
  it("offers Set email in the No team panel too, where rows aren't otherwise editable", () => {
    const html = renderToStaticMarkup(
      <ul>
        <PersonRow team={null} person={noted("m-zed", "Zed Ong", "zed@example.com", { editable: true })} actions={actions} onDone={() => {}} heading="#h" />
      </ul>,
    );
    expect(row(html, "Zed Ong")).toBe(
      "Zed Ong Member No login yet Email noted for their invite: zed@example.com. Nobody has been emailed yet. " +
        "Give login (Zed Ong) Edit email (Zed Ong)",
    );
  });
});

describe("AddListForm", () => {
  const render = (team = TEAM) =>
    inDialog(<AddListForm team={team} here={[]} elsewhere={[]} createMembers={actions.createMembers} onDone={() => {}} />);

  it("asks for one person per line, with the email their invite will go to, and says nobody is emailed now", () => {
    const html = render();
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>People<\/label><textarea[^>]*id="\1"/);
    expect(text(html)).toContain("Add a list of people to IP Lab 1");
    expect(text(html)).toContain(
      "One person per line: their name, then the email their invite will go to, if you have it. Paste from a " +
        `spreadsheet, or separate them with commas. Up to ${MAX_PEOPLE} people at a time. Nobody is emailed now: ` +
        "give them a login when you're ready.",
    );
  });

  it("offers the two roles an admin can give for the whole list, Member first and chosen, and says a line can say otherwise", () => {
    const html = render();
    expect(text(html)).toContain("Everyone else is a Member Leader");
    expect(count(html, /type="radio"/g)).toBe(2);
    expect(radios(html)).toEqual([
      { value: "member", checked: true },
      { value: "leader", checked: false },
    ]);
    expect(text(html)).not.toContain("Master Admin");
    expect(text(html)).toContain("Add Leader or Member to a line to give that person another role than the one below.");
  });

  it("offers no role where everyone leads, and says they'll all be leaders", () => {
    const html = render(DIVISION);
    expect(count(html, /type="radio"/g)).toBe(0);
    expect(text(html)).not.toContain("Everyone else is a");
    expect(text(html)).toContain("Everyone placed in a division leads it, so they'll all be leaders.");
  });

  it("previews nothing and offers Add people until something is typed", () => {
    const html = render();
    expect(html).not.toContain("The list, line by line");
    expect(text(html)).toMatch(/Cancel Add people$/);
    expect(html).not.toContain('role="alert"');
  });
});

describe("addedListMessage", () => {
  it("says nobody has a login yet when no emails came with the list", () => {
    expect(addedListMessage(TEAM, 1, 0)).toBe("Added 1 person to IP Lab 1. They have no login until you give them one.");
    expect(addedListMessage(TEAM, 3, 0)).toBe("Added 3 people to IP Lab 1. They have no login until you give them one.");
  });

  it("says how many emails are noted when only some came with the list, and that nobody was emailed", () => {
    expect(addedListMessage(TEAM, 3, 1)).toBe(
      "Added 3 people to IP Lab 1. 1 email is noted for their invites, and nobody was emailed: give them a login when you're ready.",
    );
    expect(addedListMessage(TEAM, 3, 2)).toBe(
      "Added 3 people to IP Lab 1. 2 emails are noted for their invites, and nobody was emailed: give them a login when you're ready.",
    );
  });

  it("says everyone's emails are noted when they all came with the list, and that nobody was emailed", () => {
    expect(addedListMessage(TEAM, 3, 3)).toBe(
      "Added 3 people to IP Lab 1. Their emails are noted for their invites, and nobody was emailed: give them a login when you're ready.",
    );
  });

  it("speaks of one email and one invite when one person is added with their email", () => {
    const message = addedListMessage(TEAM, 1, 1);
    expect(message).toMatch(/^Added 1 person to IP Lab 1\. /);
    expect(message).toContain("nobody was emailed: give them a login when you're ready.");
    // One person has one address and one invite.
    expect(message).not.toMatch(/\bemails\b|\binvites\b/);
  });

  it("names the node it was added to", () => {
    expect(addedListMessage({ name: "Gather" }, 2, 0)).toBe("Added 2 people to Gather. They have no login until you give them one.");
  });
});

// ---------- Send invites ----------

const ANA: Invitee = { id: "m-ana", name: "Ana Lee", email: "ana@example.com" };
const BEN: Invitee = { id: "m-ben", name: "Ben Kho", email: "ben@example.com" };
const CAT: Invitee = { id: "m-cat", name: "Cat Ng", email: "cat@example.com" };
const DAN: Invitee = { id: "m-dan", name: "Dan Lim", email: "dan@example.com" };

// A giveLogin that answers each person as the test says (ok when not said).
const answering = (answers: Record<string, string | Error>) =>
  vi.fn<TeamActions["giveLogin"]>(async (memberId) => {
    const answer = answers[memberId];
    if (answer instanceof Error) throw answer;
    return answer === undefined ? { ok: true, value: null } : { ok: false, error: answer };
  });

// Refusals about the one person; the rest still get their invites.
const ABOUT_ONE_PERSON = [
  ALREADY_HAS_LOGIN,
  EARLIER_LOGIN,
  EMAIL_FORMAT,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  MASTER_ADMIN_LOGIN,
  NOT_YOURSELF,
  NOTED_FOR_SOMEONE_ELSE,
  PERSON_CHANGED,
  PERSON_GONE,
  PERSON_REMOVED,
];

// Refusals that would refuse everyone after them too.
const ABOUT_EVERYONE = [TOO_MANY_EMAILS, NO_EMAIL_SENDER, MISSING_SITE_URL, NO_PERMISSION, GENERIC_ERROR, BAD_REQUEST];

describe("sendInvites", () => {
  afterEach(() => vi.restoreAllMocks());

  // asNoted (the third argument): giveLogin refuses an address that's no longer the one noted.
  it("gives each person a login at their noted address, in the order listed, as still noted", async () => {
    const giveLogin = answering({});
    const run = await sendInvites([ANA, BEN, CAT], giveLogin);
    expect(giveLogin.mock.calls).toEqual([
      ["m-ana", "ana@example.com", true],
      ["m-ben", "ben@example.com", true],
      ["m-cat", "cat@example.com", true],
    ]);
    expect(run).toEqual({ sent: [ANA, BEN, CAT], refused: [], stopped: null });
  });

  it("goes on past someone whose noted address changed meanwhile: that's about them alone", async () => {
    const giveLogin = vi.fn(async (id: string) =>
      id === "m-ben" ? { ok: false as const, error: NOTE_CHANGED } : { ok: true as const, value: null },
    );
    const run = await sendInvites([ANA, BEN, CAT], giveLogin);
    expect(run).toEqual({ sent: [ANA, CAT], refused: [{ person: BEN, error: NOTE_CHANGED }], stopped: null });
  });

  it("waits for each invite before sending the next", async () => {
    const answers: ((result: ActionResult) => void)[] = [];
    const giveLogin = vi.fn(() => new Promise<ActionResult>((resolve) => answers.push(resolve)));
    const sending = sendInvites([ANA, BEN], giveLogin);
    await Promise.resolve();
    expect(giveLogin).toHaveBeenCalledTimes(1);
    answers[0]({ ok: true, value: null });
    await vi.waitFor(() => expect(giveLogin).toHaveBeenCalledTimes(2));
    answers[1]({ ok: true, value: null });
    expect((await sending).sent).toEqual([ANA, BEN]);
  });

  it("sends nothing to nobody", async () => {
    const giveLogin = answering({});
    const onProgress = vi.fn();
    expect(await sendInvites([], giveLogin, onProgress)).toEqual({ sent: [], refused: [], stopped: null });
    expect(giveLogin).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("says how many have been tried after each one", async () => {
    const onProgress = vi.fn();
    await sendInvites([ANA, BEN, CAT], answering({ "m-ben": EMAIL_TAKEN }), onProgress);
    expect(onProgress.mock.calls).toEqual([[1], [2], [3]]);
  });

  it.each(ABOUT_ONE_PERSON)("goes on past a refusal about one person: %s", async (error) => {
    const giveLogin = answering({ "m-ben": error });
    const run = await sendInvites([ANA, BEN, CAT], giveLogin);
    expect(giveLogin).toHaveBeenCalledTimes(3);
    expect(run).toEqual({ sent: [ANA, CAT], refused: [{ person: BEN, error }], stopped: null });
  });

  it.each(ABOUT_EVERYONE)("stops at a refusal that would refuse everyone after it, and says who was left: %s", async (error) => {
    const giveLogin = answering({ "m-ben": error });
    const onProgress = vi.fn();
    const run = await sendInvites([ANA, BEN, CAT, DAN], giveLogin, onProgress);
    expect(giveLogin.mock.calls.map(([id]) => id)).toEqual(["m-ana", "m-ben"]);
    // Whoever it stopped at is still to send, with everyone after them.
    expect(run).toEqual({ sent: [ANA], refused: [], stopped: { error, left: [BEN, CAT, DAN] } });
    expect(onProgress.mock.calls).toEqual([[1], [2]]);
  });

  it("keeps the refusals it went on past when it stops later", async () => {
    const run = await sendInvites([ANA, BEN, CAT, DAN], answering({ "m-ana": EMAIL_TAKEN, "m-cat": TOO_MANY_EMAILS }));
    expect(run).toEqual({
      sent: [BEN],
      refused: [{ person: ANA, error: EMAIL_TAKEN }],
      stopped: { error: TOO_MANY_EMAILS, left: [CAT, DAN] },
    });
  });

  it("treats a giveLogin that throws as something going wrong, stops, and logs no name or address", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("invite to ben@example.com for Ben Kho failed"), { code: "ECONNRESET" });
    const run = await sendInvites([ANA, BEN, CAT], answering({ "m-ben": failure }));
    expect(run).toEqual({ sent: [ANA], refused: [], stopped: { error: GENERIC_ERROR, left: [BEN, CAT] } });
    expect(logged).toHaveBeenCalledExactlyOnceWith("giveLogin failed", { code: "ECONNRESET", status: undefined });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/example\.com|Ben|Kho/);
  });

  it("leaves the list it was given as it was", async () => {
    const list = [ANA, BEN];
    await sendInvites(list, answering({ "m-ana": TOO_MANY_EMAILS }));
    expect(list).toEqual([ANA, BEN]);
  });
});

describe("invitesMessage", () => {
  const run = (changes: Partial<InviteRun>): InviteRun => ({ sent: [], refused: [], stopped: null, ...changes });

  it("says how many were sent when they all went", () => {
    expect(invitesMessage(run({ sent: [ANA] }))).toBe("Sent 1 invite.");
    expect(invitesMessage(run({ sent: [ANA, BEN, CAT] }))).toBe("Sent 3 invites.");
  });

  it("says none were sent, and how many still need one, when nobody got one", () => {
    expect(invitesMessage(run({ refused: [{ person: ANA, error: EMAIL_TAKEN }] }))).toBe(
      "No invites were sent. 1 person still needs one: see their rows.",
    );
    expect(invitesMessage(run({ stopped: { error: TOO_MANY_EMAILS, left: [ANA, BEN] } }))).toBe(
      "No invites were sent. 2 people still need one: see their rows.",
    );
  });

  it("counts those refused and those it didn't get to together", () => {
    expect(
      invitesMessage(
        run({ sent: [ANA, BEN], refused: [{ person: CAT, error: EMAIL_TAKEN }], stopped: { error: TOO_MANY_EMAILS, left: [DAN] } }),
      ),
    ).toBe("Sent 2 invites. 2 people still need one: see their rows.");
  });

  it("says no invites were sent when there was nobody to send to", () => {
    expect(invitesMessage(run({}))).toBe("No invites were sent.");
  });

  it("names nobody and no address, since the page's status line is read out to whoever is near", () => {
    const message = invitesMessage(run({ sent: [ANA], refused: [{ person: BEN, error: EMAIL_TAKEN }] }));
    expect(message).not.toMatch(/Ana|Ben|example\.com/);
  });
});

describe("SendInvitesPanel", () => {
  const render = (props: Partial<React.ComponentProps<typeof SendInvitesPanel>> = {}) =>
    inDialog(<SendInvitesPanel batch={[ANA, BEN]} busy={false} tried={0} run={null} onSend={() => {}} {...props} />);

  it("lists who gets an invite, at which address, and asks before sending", () => {
    const html = render();
    expect(text(html)).toMatch(/^Send 2 invites\? /);
    expect(text(html)).toContain(
      "Module One emails each of them a link that signs them in, at the address noted for them, as Give login does. " +
        "Check the addresses first: whoever reads an invite can sign in as that person.",
    );
    expect(html).toContain('aria-label="Who gets an invite"');
    expect(row(html, "Ana Lee")).toBe("Ana Lee · ana@example.com");
    expect(row(html, "Ben Kho")).toBe("Ben Kho · ben@example.com");
    expect(text(html)).toMatch(/Cancel Send 2 invites$/);
  });

  it("speaks of one invite for one person", () => {
    const html = render({ batch: [ANA] });
    expect(text(html)).toMatch(/^Send 1 invite\? /);
    expect(text(html)).toMatch(/Cancel Send 1 invite$/);
  });

  it("says nothing in its status line until it sends", () => {
    expect(render()).toMatch(/<p role="status"[^>]*><\/p>/);
  });

  it.each([
    [0, "Sending 1 of 2…"],
    [1, "Sending 2 of 2…"],
    // Every invite tried, the last answer not in yet.
    [2, "Sending 2 of 2…"],
  ])("says which invite it's on while sending (%i tried)", (tried, progress) => {
    const html = render({ busy: true, tried });
    expect(html).toMatch(new RegExp(`<p role="status"[^>]*>${progress}</p>`));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sending…<\/button>/);
  });

  it("says how it went once sent, with only Close to press", () => {
    const html = render({ run: { sent: [ANA, BEN], refused: [], stopped: null } });
    expect(text(html)).toMatch(/^Invites sent Sent 2 invites\. /);
    expect(html).not.toContain("Who gets an invite");
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toContain("Not sent");
    expect(text(html)).toMatch(/ Close$/);
    expect(text(html)).not.toMatch(/Cancel|Send \d/);
  });

  it.each([
    ["every invite was refused", { sent: [], refused: [{ person: ANA, error: EMAIL_TAKEN }, { person: BEN, error: EMAIL_TAKEN }], stopped: null }],
    ["sending stopped at the first", { sent: [], refused: [], stopped: { error: TOO_MANY_EMAILS, left: [ANA, BEN] } }],
  ])("says no invites were sent when %s, never 'Invites sent'", (_label, run) => {
    const html = render({ run });
    expect(text(html)).toMatch(/^No invites sent No invites were sent\. 2 people still need one: see their rows\. /);
    expect(text(html)).not.toContain("Invites sent");
  });

  it("says who wasn't sent an invite and why", () => {
    const html = render({
      batch: [ANA, BEN, CAT],
      run: { sent: [ANA], refused: [{ person: BEN, error: EMAIL_TAKEN }, { person: CAT, error: NOTED_FOR_SOMEONE_ELSE }], stopped: null },
    });
    expect(text(html)).toContain("Sent 1 invite. 2 people still need one: see their rows.");
    expect(text(html)).toContain(
      `Not sent Ben Kho (ben@example.com): ${EMAIL_TAKEN} Cat Ng (cat@example.com): ${NOTED_FOR_SOMEONE_ELSE}`,
    );
    expect(html).not.toContain('role="alert"');
  });

  it("says why sending stopped and who it didn't get to, as an alert", () => {
    const html = render({
      batch: [ANA, BEN, CAT],
      run: { sent: [ANA], refused: [], stopped: { error: TOO_MANY_EMAILS, left: [BEN, CAT] } },
    });
    expect(html).toMatch(
      new RegExp(`<p role="alert"[^>]*>Sending stopped: ${TOO_MANY_EMAILS.replace(/\./g, "\\.")} Not sent yet: Ben Kho, Cat Ng\\.</p>`),
    );
    expect(text(html)).not.toContain("Not sent Ben");
  });
});

describe("SendInvitesDialog", () => {
  const render = (invitees: Invitee[]) =>
    renderToStaticMarkup(<SendInvitesDialog invitees={invitees} giveLogin={actions.giveLogin} onDone={() => {}} focusAfter="#h" />);

  it("offers Send invites with how many it's for", () => {
    const html = render([ANA, BEN]);
    expect(html).toMatch(/^<button [^>]*type="button"[^>]*>Send invites \(2\)<\/button>$/);
  });

  it("renders nothing when nobody has an address noted", () => {
    expect(render([])).toBe("");
  });
});
