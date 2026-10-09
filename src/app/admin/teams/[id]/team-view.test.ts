import { describe, expect, it, vi } from "vitest";
import type { TeamRow } from "@/lib/admin/tree";
import {
  buildNoTeamPeople,
  buildTeamView,
  coverage,
  demoteDescription,
  emailChangedText,
  INVITE_LINK_MS,
  type LoginRow,
  type LoginStates,
  type LoginStatus,
  type LoginStatusText,
  loginGivenText,
  loginStatusText,
  type MemberRow,
  matchesSearch,
  nameList,
  type Person,
  promoteDescription,
  removeDescription,
  removePersonDescription,
} from "./team-view";

const node = (id: string, name: string, kind: TeamRow["kind"], parent_id: string | null, extra: Partial<TeamRow> = {}): TeamRow => ({
  id,
  name,
  parent_id,
  kind,
  domain_type: null,
  division_type: null,
  code: null,
  sort_order: 0,
  note: null,
  leader_title: null,
  archived_at: null,
  ...extra,
});

// Gather › IP Lab › IP Lab 1 / IP Lab 2; an unplaced domain "Legacy" with a team; an archived team.
const TEAMS: TeamRow[] = [
  node("div-gather", "Gather", "division", null, { division_type: "strategy" }),
  node("dom-ip", "IP Lab", "domain", "div-gather", { domain_type: "lab", code: "IP.X", note: "The lab." }),
  node("team-ip1", "IP Lab 1", "team", "dom-ip", { code: "IP.1" }),
  node("team-ip2", "IP Lab 2", "team", "dom-ip", { code: "IP.2" }),
  node("dom-legacy", "Legacy", "domain", null),
  node("team-legacy", "Legacy A", "team", "dom-legacy"),
  node("team-old", "Old", "team", "dom-ip", { archived_at: "2026-01-01T00:00:00Z" }),
];

const ADMIN = "m-hana";

const member = (id: string, name: string, role: string, team_id: string | null, extra: Partial<MemberRow> = {}): MemberRow => ({
  id,
  name,
  role,
  team_id,
  auth_user_id: null,
  login_given_by: null,
  login_given_at: null,
  login_email_changed_by: null,
  login_email_changed_at: null,
  removed_at: null,
  ...extra,
});

const MEMBERS: MemberRow[] = [
  member(ADMIN, "Hana Lim", "hq", "team-ip1", { auth_user_id: "u-hana" }),
  member("m-leo", "Leo Tan", "leader", "team-ip1", { auth_user_id: "u-leo" }),
  member("m-mei", "Mei Wong", "member", "team-ip1", {
    auth_user_id: "u-mei",
    login_given_by: ADMIN,
    login_given_at: "2026-10-08T16:30:00Z", // 9 Oct in Singapore
  }),
  member("m-zed", "Zed Ong", "member", "team-ip1"),
  member("m-boss", "Ada Boss", "hq", null),
  member("m-ana", "Ana Lee", "leader", "team-ip2"),
  member("m-ben", "Ben Kho", "member", null),
  member("m-cat", "Cat Ng", "leader", null),
  member("m-dan", "Dan Yeo", "member", "dom-legacy"),
  member("m-eve", "Ève Tan", "leader", "dom-legacy"),
];

const LEADS = [
  { team_id: "team-ip2", member_id: "m-leo" },
  { team_id: "dom-legacy", member_id: "m-leo" },
  { team_id: "team-ip1", member_id: "m-ana" },
];

const view = (teamId: string, members = MEMBERS, leads = LEADS, grants: { member_id: string }[] = [], logins?: LoginStates) =>
  buildTeamView({ teamId, adminMemberId: ADMIN, teams: TEAMS, members, leads, grants, logins });

// The same tree under the organisation node (0006).
const ORG_TEAMS: TeamRow[] = [
  node("org", "The New Normal", "organisation", null),
  ...TEAMS.map((t) => (t.id === "div-gather" ? { ...t, parent_id: "org" } : t)),
];

// Removed from Module One (0009). The database also clears the row's login, team and role; rows
// that keep one here check that the page doesn't rely on it.
const REMOVED = { removed_at: "2026-10-09T03:00:00Z" };

// What admin_login_states (0010) returns for one linked login.
const loginRow = (member_id: string, state: LoginRow["state"], extra: Partial<LoginRow> = {}): LoginRow => ({
  member_id,
  state,
  invited_at: null,
  last_sign_in_at: null,
  ...extra,
});

// An invite sent at 16:30 UTC on 8 Oct, which is 12:30 am on 9 Oct in Singapore.
const SENT = "2026-10-08T16:30:00Z";
const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const MINUTE = 60 * 1000;

// Login states as the server read them, half an hour after SENT unless said otherwise.
const states = (rows: LoginRow[], readAt = later(SENT, 30 * MINUTE)): LoginStates => ({ rows, readAt });

// ICU may put a narrow no-break space before "am"/"pm"; compare with plain spaces.
const plain = (s: string | null) => s?.replace(/\s/g, " ") ?? null;
const plainLogin = (login: LoginStatus): LoginStatus =>
  login.state === "invited" ? { ...login, sentAt: plain(login.sentAt) } : login;

const loginOf = (people: readonly Person[], id: string) => plainLogin(people.find((p) => p.id === id)!.login);

describe("buildTeamView", () => {
  it("gives the node's title for its leaders to the leaders and hq sitting there, not to members", () => {
    const teams = [...TEAMS.map((t) => (t.id === "team-ip1" ? { ...t, leader_title: "Captain" } : t))];
    const v = buildTeamView({ teamId: "team-ip1", adminMemberId: "m-nobody", teams, members: MEMBERS, leads: LEADS, grants: [] })!;
    expect(v.team.leaderTitle).toBe("Captain");
    const titles = Object.fromEntries(v.people.map((p) => [p.name, p.title]));
    expect(titles).toEqual({ "Hana Lim": "Captain", "Leo Tan": "Captain", "Mei Wong": null, "Zed Ong": null });
    // Without a title, nobody gets one.
    expect(view("team-ip1")!.people.every((p) => p.title === null)).toBe(true);
  });

  it("is null for an unknown id", () => {
    expect(view("nope")).toBeNull();
  });

  it("gives a division a page too, with its type and no crumbs (people can sit in one since 0005)", () => {
    const v = view("div-gather")!;
    expect(v.team).toMatchObject({
      kind: "division",
      kindLabel: "Division",
      divisionType: "strategy",
      domainType: null,
      typeLabel: "Strategy division",
    });
    expect(v.crumbs).toEqual([]);
  });

  it("lists who leads a domain or team through the division above it, nearest first", () => {
    // Bo sits in Gather as a leader; Cat has a lead row on Gather; Leo leads IP Lab 2 and Gather.
    const members = [...MEMBERS, member("m-bo", "Bo Teo", "leader", "div-gather")];
    const leads = [...LEADS, { team_id: "div-gather", member_id: "m-cat" }, { team_id: "div-gather", member_id: "m-leo" }];
    const domain = view("dom-ip", members, leads)!;
    expect(domain.inheritedLeads.map((l) => [l.name, l.domainName])).toEqual([
      ["Bo Teo", "Gather"],
      ["Cat Ng", "Gather"],
      ["Leo Tan", "Gather"],
    ]);
    expect(domain.leadOptions.map((l) => l.name)).not.toContain("Cat Ng");
    // On IP Lab 2, Leo's own lead row is listed (removable), saying he'd still lead it through Gather.
    const team = view("team-ip2", members, leads)!;
    expect(team.leads.map((l) => [l.name, l.viaDomain, l.viaOwnTeam])).toEqual([["Leo Tan", "Gather", false]]);
    // Bo sits in Gather; a lead row of his on IP Lab 2 is through the node he sits in.
    const bo = view("team-ip2", members, [...leads, { team_id: "team-ip2", member_id: "m-bo" }])!;
    expect(bo.leads.find((l) => l.name === "Bo Teo")).toMatchObject({ viaDomain: "Gather", viaOwnTeam: true });
    expect(team.inheritedLeads.map((l) => l.name)).toEqual(["Bo Teo", "Cat Ng"]);
    // Leo sits in IP Lab 1, so removing him from it keeps him leading it through Gather.
    expect(view("team-ip1", members, leads)!.people.find((p) => p.id === "m-leo")!.leadsDomain).toBe("Gather");
    // Cat leads both Gather and IP Lab: IP Lab 1 names IP Lab, the nearer.
    const both = [...leads, { team_id: "dom-ip", member_id: "m-cat" }];
    expect(view("team-ip1", members, both)!.inheritedLeads.find((l) => l.name === "Cat Ng")!.domainName).toBe("IP Lab");
    // A division has nothing above it.
    expect(view("div-gather", members, leads)!.inheritedLeads).toEqual([]);
  });

  it("describes the team and its place in the tree", () => {
    const v = view("team-ip1")!;
    expect(v.team).toEqual({
      id: "team-ip1",
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
    });
    expect(v.crumbs).toEqual([
      { key: "div-gather", label: "Gather", href: "/admin/teams/div-gather" },
      { key: "dom-ip", label: "IP Lab", href: "/admin/teams/dom-ip" },
    ]);
  });

  it("gives a domain its type and a division crumb", () => {
    const v = view("dom-ip")!;
    expect(v.team).toMatchObject({ kind: "domain", kindLabel: "Domain", domainType: "lab", typeLabel: "Lab", note: "The lab." });
    expect(v.crumbs).toEqual([{ key: "div-gather", label: "Gather", href: "/admin/teams/div-gather" }]);
  });

  it("says 'Unplaced' above a top-level domain and its teams", () => {
    expect(view("dom-legacy")!.crumbs).toEqual([{ key: "unplaced", label: "Unplaced", href: null }]);
    expect(view("team-legacy")!.crumbs).toEqual([
      { key: "unplaced", label: "Unplaced", href: null },
      { key: "dom-legacy", label: "Legacy", href: "/admin/teams/dom-legacy" },
    ]);
  });

  it("handles the organisation node above every division (since 0006)", () => {
    const teams = [node("org", "The New Normal", "organisation", null), ...TEAMS.map((t) => (t.id === "div-gather" ? { ...t, parent_id: "org" } : t))];
    const members = [
      ...MEMBERS,
      member("m-eli", "Eli Chao", "leader", "org"),
      member("m-vp", "Vee Pang", "leader", "org", { auth_user_id: "u-vp", login_given_by: ADMIN, login_given_at: "2026-10-09T04:00:00Z" }),
      member("m-gina", "Gina Grant", "leader", "org"),
      member("m-chief", "Chief Ong", "hq", "org"),
    ];
    const at = (teamId: string) =>
      buildTeamView({ teamId, adminMemberId: ADMIN, teams, members, leads: LEADS, grants: [{ member_id: "m-gina" }] })!;
    expect(at("org").team).toMatchObject({ kind: "organisation", kindLabel: "Organisation", typeLabel: null });
    expect(at("org").crumbs).toEqual([]);
    expect(at("org").people.map((p) => p.name)).toEqual(["Chief Ong", "Eli Chao", "Gina Grant", "Vee Pang"]);
    // No "Unplaced" above what's in a division under it, and still above an unplaced domain.
    expect(at("dom-ip").crumbs.map((c) => c.label)).toEqual(["The New Normal", "Gather"]);
    expect(at("dom-legacy").crumbs.map((c) => c.label)).toEqual(["Unplaced"]);
    // Whoever sits in it leads everything below.
    expect(at("div-gather").inheritedLeads).toEqual(
      ["m-eli:Eli Chao", "m-gina:Gina Grant", "m-vp:Vee Pang"].map((p) => {
        const [id, name] = p.split(":");
        return { id, name, domainId: "org", domainName: "The New Normal" };
      }),
    );
    // Everyone placed in a division or in it leads it, once there's an organisation (0006); before,
    // a division takes members too.
    expect([at("org"), at("div-gather"), at("dom-ip")].map((v) => v.team.everyoneLeads)).toEqual([true, true, false]);
    expect(view("div-gather")!.team.everyoneLeads).toBe(false);
    // Only the project owner places people there or decides who leads it: nothing to change here,
    // except that admins give them a login (the owner's decision), as anywhere else.
    expect(at("org").people.every((p) => !p.editable)).toBe(true);
    const logins = Object.fromEntries(
      at("org").people.map((p) => [p.name, [p.canGiveLogin, p.ownerGivesLogin, p.canResendInvite]]),
    );
    expect(logins).toEqual({
      "Chief Ong": [false, false, false], // a Master Admin: never from the app
      "Eli Chao": [true, false, false],
      "Gina Grant": [false, true, false], // holds grants: the owner gives it
      "Vee Pang": [false, false, true], // given in Module One: its invite can be re-sent
    });
    expect(at("org").candidates).toEqual([]);
    // Nor are they offered to move into any other team.
    expect(at("team-ip2").candidates.map((c) => c.id)).not.toContain("m-eli");
    expect(at("team-ip2").candidates.length).toBeGreaterThan(0);
    expect(at("org").leadOptions).toEqual([]);
  });

  it("marks an archived team", () => {
    expect(view("team-old")!.team.archived).toBe(true);
  });

  it("lists the people in the team by name, with role labels and logins", () => {
    const people = view("team-ip1")!.people;
    expect(people.map((p) => [p.name, p.roleLabel, p.hasLogin])).toEqual([
      ["Hana Lim", "Master Admin", true],
      ["Leo Tan", "Leader", true],
      ["Mei Wong", "Member", true],
      ["Zed Ong", "Member", false],
    ]);
    expect(people.find((p) => p.name === "Mei Wong")!.loginGiven).toBe("Login given by Hana Lim on 9 Oct 2026");
    expect(people.find((p) => p.name === "Leo Tan")!.loginGiven).toBeNull();
  });

  it("doesn't say who gave a login once it's gone (deleted in the Supabase dashboard)", () => {
    const members = [
      member("m-pri", "Priya Nair", "member", "team-ip1", {
        login_given_by: ADMIN,
        login_given_at: "2026-10-08T16:30:00Z",
      }),
    ];
    const [priya] = view("team-ip1", [...MEMBERS.filter((m) => m.id === ADMIN), ...members])!.people.filter(
      (p) => p.id === "m-pri",
    );
    expect(priya).toMatchObject({ hasLogin: false, loginGiven: null, canGiveLogin: true, canResendInvite: false });
  });

  it("offers Give login to people without one, but not to someone who holds grants", () => {
    const people = view("team-ip1", MEMBERS, LEADS, [{ member_id: "m-zed" }, { member_id: ADMIN }])!.people;
    const flags = Object.fromEntries(people.map((p) => [p.name, [p.canGiveLogin, p.ownerGivesLogin]]));
    expect(flags).toEqual({
      "Hana Lim": [false, false], // the admin: has a login, not editable
      "Leo Tan": [false, false],
      "Mei Wong": [false, false],
      "Zed Ong": [false, true],
    });
    expect(view("team-ip1")!.people.find((p) => p.id === "m-zed")).toMatchObject({ canGiveLogin: true, ownerGivesLogin: false });
  });

  it("offers Resend invite only on editable rows whose login was given here", () => {
    const people = view("team-ip1")!.people;
    expect(people.filter((p) => p.canResendInvite).map((p) => p.name)).toEqual(["Mei Wong"]);
  });

  it("never sends a member's auth user id, only whether they have a login", () => {
    expect(JSON.stringify(view("team-ip1"))).not.toMatch(/u-(hana|leo|mei)/);
  });

  it("offers no edits on Master Admin rows or the admin's own row", () => {
    const people = view("team-ip1")!.people;
    const flags = Object.fromEntries(people.map((p) => [p.name, [p.editable, p.isSelf]]));
    expect(flags).toEqual({
      "Hana Lim": [false, true],
      "Leo Tan": [true, false],
      "Mei Wong": [true, false],
      "Zed Ong": [true, false],
    });
  });

  it("treats an unknown role like a Master Admin: shown, never editable", () => {
    const people = view("team-ip1", [member("m-x", "Xu", "owner", "team-ip1")])!.people;
    expect(people[0]).toMatchObject({ role: "hq", roleLabel: "Master Admin", editable: false });
  });

  it("lists the other teams a person leads, for the demotion warning", () => {
    const leo = view("team-ip1")!.people.find((p) => p.id === "m-leo")!;
    expect(leo.otherLeads).toEqual(["IP Lab 2", "Legacy"]);
  });

  it("offers everyone else as a candidate, unassigned first, never a Master Admin or the admin", () => {
    const candidates = view("team-ip1")!.candidates;
    expect(candidates).toEqual([
      { id: "m-ben", name: "Ben Kho", teamId: null, teamName: null },
      { id: "m-cat", name: "Cat Ng", teamId: null, teamName: null },
      { id: "m-ana", name: "Ana Lee", teamId: "team-ip2", teamName: "IP Lab 2" },
      { id: "m-dan", name: "Dan Yeo", teamId: "dom-legacy", teamName: "Legacy" },
      { id: "m-eve", name: "Ève Tan", teamId: "dom-legacy", teamName: "Legacy" },
    ]);
  });

  it("separates leaders who sit in the team from team_leads rows", () => {
    const v = view("team-ip1")!;
    expect(v.ownLeaders).toEqual([{ id: "m-leo", name: "Leo Tan", domain: null }]);
    expect(v.leads).toEqual([{ id: "m-ana", name: "Ana Lee", teamName: "IP Lab 2", inThisTeam: false, viaDomain: null, viaOwnTeam: false }]);
  });

  it("lists a leader who sits in the team and also leads its domain once, saying both", () => {
    // Leo sits in IP Lab 1 and is added as a lead of IP Lab, which holds it.
    const v = view("team-ip1", MEMBERS, [...LEADS, { team_id: "dom-ip", member_id: "m-leo" }])!;
    expect(v.ownLeaders).toEqual([{ id: "m-leo", name: "Leo Tan", domain: { id: "dom-ip", name: "IP Lab" } }]);
    expect(v.inheritedLeads).toEqual([]);
    expect(v.leads.map((l) => l.id)).toEqual(["m-ana"]);
    const everyone = [...v.ownLeaders, ...v.leads, ...v.inheritedLeads].map((l) => l.id);
    expect(new Set(everyone).size).toBe(everyone.length);
    // Ana sits in IP Lab 2 and leads nothing above it; Leo leads IP Lab 2 through his lead row.
    const ip2 = view("team-ip2", MEMBERS, [...LEADS, { team_id: "dom-ip", member_id: "m-leo" }])!;
    expect(ip2.ownLeaders).toEqual([{ id: "m-ana", name: "Ana Lee", domain: null }]);
    expect(ip2.leads.map((l) => l.id)).toEqual(["m-leo"]);
    // Removing that row wouldn't stop him leading IP Lab 2: he leads IP Lab, which holds it.
    expect(ip2.leads[0].viaDomain).toBe("IP Lab");
    expect(ip2.inheritedLeads).toEqual([]);
  });

  it("knows who sitting in a team also leads the domain holding it", () => {
    const leads = [...LEADS, { team_id: "dom-ip", member_id: "m-leo" }];
    const leo = (teamId: string, l = leads) => view(teamId, MEMBERS, l)!.people.find((p) => p.id === "m-leo")!;
    expect(leo("team-ip1").leadsDomain).toBe("IP Lab");
    expect(leo("team-ip1", LEADS).leadsDomain).toBeNull();
    // A domain has nothing above it that can be led.
    const inDomain = [...MEMBERS.filter((m) => m.id !== "m-leo"), member("m-leo", "Leo Tan", "leader", "dom-legacy")];
    expect(view("dom-legacy", inDomain)!.people.find((p) => p.id === "m-leo")!.leadsDomain).toBeNull();
    // Only leaders lead (a stale row for a member counts for nothing).
    const asMember = MEMBERS.map((m) => (m.id === "m-leo" ? { ...m, role: "member" } : m));
    expect(view("team-ip1", asMember, leads)!.people.find((p) => p.id === "m-leo")!.leadsDomain).toBeNull();
  });

  it("lists a leader who sits in the team and also has a lead row once, with the row", () => {
    const leads = [...LEADS, { team_id: "team-ip1", member_id: "m-leo" }];
    const v = view("team-ip1", MEMBERS, leads)!;
    expect(v.ownLeaders).toEqual([]);
    expect(v.leads).toEqual([
      { id: "m-ana", name: "Ana Lee", teamName: "IP Lab 2", inThisTeam: false, viaDomain: null, viaOwnTeam: false },
      { id: "m-leo", name: "Leo Tan", teamName: "IP Lab 1", inThisTeam: true, viaDomain: null, viaOwnTeam: false },
    ]);
  });

  it("lists who leads a team through its domain, read-only, and doesn't offer them as leads", () => {
    // Legacy A sits in Legacy, where Ève sits as a leader and Leo has a lead row.
    const v = view("team-legacy")!;
    expect(v.inheritedLeads).toEqual([
      { id: "m-eve", name: "Ève Tan", domainId: "dom-legacy", domainName: "Legacy" },
      { id: "m-leo", name: "Leo Tan", domainId: "dom-legacy", domainName: "Legacy" },
    ]);
    expect(v.leadOptions.map((o) => o.name)).toEqual(["Ana Lee", "Cat Ng"]);
    // An unplaced domain inherits nothing: there's nothing above it.
    expect(view("dom-legacy")!.inheritedLeads).toEqual([]);
  });

  it("lists someone with a lead row on the team itself once, as a removable lead", () => {
    const v = view("team-legacy", MEMBERS, [...LEADS, { team_id: "team-legacy", member_id: "m-eve" }])!;
    expect(v.leads.map((l) => l.name)).toEqual(["Ève Tan"]);
    expect(v.inheritedLeads.map((l) => l.name)).toEqual(["Leo Tan"]);
  });

  it("knows who also has a lead row for the team they sit in", () => {
    const v = view("team-ip1", MEMBERS, [...LEADS, { team_id: "team-ip1", member_id: "m-leo" }])!;
    expect(v.people.find((p) => p.id === "m-leo")!.leadsHere).toBe(true);
    expect(view("team-ip1")!.people.find((p) => p.id === "m-leo")!.leadsHere).toBe(false);
  });

  it("offers leaders from any team as leads, but not the admin, current leads, or leaders already in it", () => {
    expect(view("team-ip1")!.leadOptions).toEqual([
      { id: "m-cat", name: "Cat Ng", teamName: null, inThisTeam: false, viaDomain: null, viaOwnTeam: false },
      { id: "m-eve", name: "Ève Tan", teamName: "Legacy", inThisTeam: false, viaDomain: null, viaOwnTeam: false },
    ]);
    expect(view("team-ip2")!.leadOptions.map((o) => o.name)).toEqual(["Cat Ng", "Ève Tan"]);
  });

  it("never offers the admin as a lead, even if they were a leader", () => {
    const members = [member(ADMIN, "Hana Lim", "leader", "team-ip2"), member("m-cat", "Cat Ng", "leader", null)];
    expect(view("team-ip1", members, [])!.leadOptions.map((o) => o.id)).toEqual(["m-cat"]);
  });

  it("leaves people removed from Module One out of every list", () => {
    const removed = [
      member("m-rae", "Rae Koh", "member", null, REMOVED), // as the database leaves them
      member("m-sam", "Sam Lau", "leader", "team-ip1", REMOVED),
      member("m-tia", "Tia Ho", "leader", "div-gather", REMOVED),
      member("m-uma", "Uma Sen", "leader", null, REMOVED),
    ];
    // No page changes: not its people, candidates, leaders, who leads it from above, or lead options.
    for (const teamId of ["team-ip1", "team-ip2", "dom-ip", "div-gather", "dom-legacy", "team-legacy"]) {
      expect(view(teamId, [...MEMBERS, ...removed]), teamId).toEqual(view(teamId));
    }
    // Before they were removed, each was listed somewhere.
    const before = view("team-ip1", [...MEMBERS, ...removed.map((m) => ({ ...m, removed_at: null }))])!;
    expect(before.people.map((p) => p.id)).toContain("m-sam");
    expect(before.ownLeaders.map((l) => l.id)).toContain("m-sam");
    expect(before.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["m-rae", "m-tia", "m-uma"]));
    expect(before.inheritedLeads.map((l) => l.id)).toContain("m-tia");
    expect(before.leadOptions.map((l) => l.id)).toContain("m-uma");
  });

  it("still names who gave a login or changed a sign-in email once they're removed from Module One", () => {
    const members = [
      ...MEMBERS.map((m) =>
        m.id === "m-mei"
          ? { ...m, login_given_by: "m-olu", login_email_changed_by: "m-olu", login_email_changed_at: "2026-10-09T02:00:00Z" }
          : m,
      ),
      member("m-olu", "Olu Ade", "member", null, REMOVED),
    ];
    const v = view("team-ip1", members)!;
    expect(v.people.find((p) => p.id === "m-mei")).toMatchObject({
      loginGiven: "Login given by Olu Ade on 9 Oct 2026",
      emailChanged: "Sign-in email changed by Olu Ade on 9 Oct 2026",
    });
    expect(v.candidates.map((c) => c.id)).not.toContain("m-olu");
  });

  it("offers Remove from Module One on ordinary rows, and Change email only to people with a login", () => {
    const flags = Object.fromEntries(
      view("team-ip1")!.people.map((p) => [p.name, [p.canChangeEmail, p.canRemove, p.ownerKeeps]]),
    );
    expect(flags).toEqual({
      "Hana Lim": [false, false, null], // a Master Admin, and the admin
      "Leo Tan": [true, true, null],
      "Mei Wong": [true, true, null],
      "Zed Ong": [false, true, null], // no login, so no sign-in email to change
    });
  });

  it("offers neither on a Master Admin's row or the admin's own row, and doesn't say the owner keeps them", () => {
    // Leo is the signed-in admin, holding the admin grant as every admin does; Hana holds grants too.
    const v = buildTeamView({
      teamId: "team-ip1",
      adminMemberId: "m-leo",
      teams: TEAMS,
      members: MEMBERS,
      leads: LEADS,
      grants: [{ member_id: "m-leo" }, { member_id: ADMIN }],
    })!;
    const flags = Object.fromEntries(v.people.map((p) => [p.name, [p.canChangeEmail, p.canRemove, p.ownerKeeps]]));
    expect(flags).toEqual({
      "Hana Lim": [false, false, null],
      "Leo Tan": [false, false, null],
      "Mei Wong": [true, true, null],
      "Zed Ong": [false, true, null],
    });
  });

  it("leaves changing a grant holder's email or removing them to the project owner, with a login or without", () => {
    const people = view("team-ip1", MEMBERS, LEADS, [{ member_id: "m-mei" }, { member_id: "m-zed" }])!.people;
    const flags = Object.fromEntries(people.map((p) => [p.name, [p.canChangeEmail, p.canRemove, p.ownerKeeps]]));
    expect(flags).toEqual({
      "Hana Lim": [false, false, null],
      "Leo Tan": [true, true, null],
      "Mei Wong": [false, false, "grants"],
      "Zed Ong": [false, false, "grants"],
    });
    // Their role and team are still the admin's to change.
    expect(people.filter((p) => p.ownerKeeps === "grants").every((p) => p.editable)).toBe(true);
  });

  it("leaves whoever sits in the organisation to the project owner, offering nothing on its page", () => {
    const members = [
      ...MEMBERS,
      member("m-eli", "Eli Chao", "leader", "org"),
      member("m-vp", "Vee Pang", "leader", "org", { auth_user_id: "u-vp", login_given_by: ADMIN, login_given_at: "2026-10-09T04:00:00Z" }),
      member("m-gina", "Gina Grant", "leader", "org", { auth_user_id: "u-gina" }),
      member("m-chief", "Chief Ong", "hq", "org", { auth_user_id: "u-chief" }),
      member("m-bo", "Bo Teo", "leader", "div-gather", { auth_user_id: "u-bo" }),
    ];
    const at = (teamId: string) =>
      buildTeamView({ teamId, adminMemberId: ADMIN, teams: ORG_TEAMS, members, leads: LEADS, grants: [{ member_id: "m-gina" }] })!;
    const flags = Object.fromEntries(at("org").people.map((p) => [p.name, [p.canChangeEmail, p.canRemove, p.ownerKeeps]]));
    expect(flags).toEqual({
      "Chief Ong": [false, false, null], // a Master Admin
      "Eli Chao": [false, false, "organisation"],
      "Gina Grant": [false, false, "grants"], // holds grants too, which the note names first
      "Vee Pang": [false, false, "organisation"],
    });
    // Sitting in a division under it is an ordinary row.
    expect(at("div-gather").people.find((p) => p.id === "m-bo")).toMatchObject({
      canChangeEmail: true,
      canRemove: true,
      ownerKeeps: null,
    });
  });

  it("leaves someone who leads the organisation through a lead row to the project owner, wherever they sit", () => {
    const at = (leads: { team_id: string; member_id: string }[]) =>
      buildTeamView({ teamId: "team-ip1", adminMemberId: ADMIN, teams: ORG_TEAMS, members: MEMBERS, leads, grants: [] })!.people;
    const people = at([...LEADS, { team_id: "org", member_id: "m-leo" }]);
    expect(people.find((p) => p.id === "m-leo")).toMatchObject({ canChangeEmail: false, canRemove: false, ownerKeeps: "organisation" });
    expect(people.find((p) => p.id === "m-mei")).toMatchObject({ canChangeEmail: true, canRemove: true, ownerKeeps: null });
    // A lead row on a node under it is nothing special.
    expect(at([...LEADS, { team_id: "div-gather", member_id: "m-leo" }]).find((p) => p.id === "m-leo")).toMatchObject({
      canChangeEmail: true,
      canRemove: true,
      ownerKeeps: null,
    });
  });

  it("says who changed a sign-in email and when, only while they have a login", () => {
    const changed = { login_email_changed_by: ADMIN, login_email_changed_at: "2026-10-08T16:30:00Z" };
    const members = [
      ...MEMBERS.filter((m) => m.id === ADMIN || m.id === "m-leo"),
      member("m-mei", "Mei Wong", "member", "team-ip1", { auth_user_id: "u-mei", ...changed }),
      // Whoever changed it was deleted in the Supabase dashboard.
      member("m-pri", "Priya Nair", "member", "team-ip1", { auth_user_id: "u-pri", login_email_changed_at: "2026-10-08T16:30:00Z" }),
      // The login since deleted in the Supabase dashboard.
      member("m-zed", "Zed Ong", "member", "team-ip1", changed),
    ];
    const changes = Object.fromEntries(view("team-ip1", members)!.people.map((p) => [p.name, p.emailChanged]));
    expect(changes).toEqual({
      "Hana Lim": null,
      "Leo Tan": null, // never changed
      "Mei Wong": "Sign-in email changed by Hana Lim on 9 Oct 2026",
      "Priya Nair": "Sign-in email changed on 9 Oct 2026",
      "Zed Ong": null,
    });
  });

  it("doesn't say a sign-in email was changed when that was an earlier login's", () => {
    const at = (changed: string, given: string | null) => ({
      auth_user_id: "u-x",
      login_given_by: ADMIN,
      login_given_at: given,
      login_email_changed_by: ADMIN,
      login_email_changed_at: changed,
    });
    const members = [
      ...MEMBERS.filter((m) => m.id === ADMIN),
      // Given a new login after the change (the old one was deleted in the dashboard).
      member("m-old", "Old Change", "member", "team-ip1", at("2026-10-01T02:00:00Z", "2026-10-05T02:00:00Z")),
      // Changed after the login was given, and at the very moment Change email gave it (a swap).
      member("m-new", "New Change", "member", "team-ip1", at("2026-10-05T02:00:00Z", "2026-10-01T02:00:00Z")),
      member("m-same", "Same Moment", "member", "team-ip1", at("2026-10-05T02:00:00Z", "2026-10-05T02:00:00Z")),
    ];
    const changes = Object.fromEntries(view("team-ip1", members)!.people.map((p) => [p.name, p.emailChanged]));
    expect(changes).toMatchObject({
      "Old Change": null,
      "New Change": "Sign-in email changed by Hana Lim on 5 Oct 2026",
      "Same Moment": "Sign-in email changed by Hana Lim on 5 Oct 2026",
    });
  });

  it("doesn't list someone removed as a lead, even from a lead row read before the removal", () => {
    const members = [...MEMBERS, member("m-sam", "Sam Lau", "member", null, REMOVED)];
    const v = view("team-ip1", members, [...LEADS, { team_id: "team-ip1", member_id: "m-sam" }])!;
    expect(v.leads.map((l) => l.id)).not.toContain("m-sam");
  });

  it("says an invite read half an hour after it went out isn't used yet, and when it went out in Singapore time", () => {
    const people = view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-mei", "invited", { invited_at: SENT })]))!.people;
    expect(loginOf(people, "m-mei")).toEqual({ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: false });
    const text = loginStatusText(people.find((p) => p.id === "m-mei")!.login);
    expect({ ...text, detail: plain(text.detail) }).toEqual({
      label: "Invite not used",
      tone: "warning",
      detail: "Invite sent 9 Oct 2026, 12:30 am",
    });
  });

  it("says an invite expired once its link has been out an hour, and not a moment before", () => {
    expect(INVITE_LINK_MS).toBe(60 * MINUTE);
    const at = (readAt: string) =>
      loginOf(
        view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-mei", "invited", { invited_at: SENT })], readAt))!.people,
        "m-mei",
      );
    expect(at(later(SENT, INVITE_LINK_MS - 1))).toEqual({ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: false });
    expect(at(later(SENT, INVITE_LINK_MS))).toEqual({ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: true });
    expect(at(later(SENT, 120 * MINUTE))).toEqual({ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: true });
    expect(loginStatusText(at(later(SENT, 120 * MINUTE))).label).toBe("Invite expired");
  });

  it("works out an invite's age from when the login states were read, not from the clock rendering the page", () => {
    const rows = [loginRow("m-mei", "invited", { invited_at: SENT })];
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      expect(loginOf(view("team-ip1", MEMBERS, LEADS, [], states(rows))!.people, "m-mei")).toMatchObject({ expired: false });
      vi.setSystemTime(new Date(SENT));
      const readLater = states(rows, later(SENT, 120 * MINUTE));
      expect(loginOf(view("team-ip1", MEMBERS, LEADS, [], readLater)!.people, "m-mei")).toMatchObject({ expired: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nobody can sign in yet with a login that was never invited, and never calls it expired", () => {
    const monthLater = later(SENT, 30 * 24 * 60 * MINUTE);
    const people = view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-mei", "invited")], monthLater))!.people;
    expect(loginOf(people, "m-mei")).toEqual({ state: "invited", sentAt: null, expired: false });
    expect(loginStatusText(people.find((p) => p.id === "m-mei")!.login)).toEqual({
      label: "Can't sign in yet",
      tone: "warning",
      detail: "No invite has been sent",
    });
  });

  it("never calls an invite expired when the time it went out, or the time the states were read, is unreadable", () => {
    const at = (invited_at: string, readAt: string) =>
      loginOf(view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-mei", "invited", { invited_at })], readAt))!.people, "m-mei");
    expect(at(SENT, "not a date")).toEqual({ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: false });
    expect(at("not a date", later(SENT, 120 * MINUTE))).toEqual({ state: "invited", sentAt: null, expired: false });
  });

  it("says a login nobody has signed in with is ready, and an active one the day it was last used, in Singapore", () => {
    const rows = [
      loginRow("m-leo", "ready"),
      loginRow("m-mei", "active", { last_sign_in_at: "2026-10-07T16:30:00Z" }), // 12:30 am on 8 Oct in Singapore
    ];
    const people = view("team-ip1", MEMBERS, LEADS, [], states(rows))!.people;
    expect(loginOf(people, "m-leo")).toEqual({ state: "ready" });
    expect(loginOf(people, "m-mei")).toEqual({ state: "active", lastSignedInOn: "8 Oct 2026" });
    expect(loginStatusText(loginOf(people, "m-mei")).detail).toBe("Last signed in with a link on 8 Oct 2026");
    // Without a readable date, it's still active, and says no more.
    for (const last_sign_in_at of [null, "not a date"]) {
      const undated = view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-mei", "active", { last_sign_in_at })]))!.people;
      expect(loginOf(undated, "m-mei")).toEqual({ state: "active", lastSignedInOn: null });
    }
  });

  it("says someone has a login, and no more, when there's no row for it (linked or deleted since)", () => {
    const people = view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-mei", "ready")]))!.people;
    expect(Object.fromEntries(people.map((p) => [p.name, p.login.state]))).toEqual({
      "Hana Lim": "unknown",
      "Leo Tan": "unknown",
      "Mei Wong": "ready",
      "Zed Ong": "none",
    });
    expect(loginStatusText(people.find((p) => p.id === "m-leo")!.login)).toEqual({
      label: "Has a login",
      tone: "neutral",
      detail: null,
    });
  });

  it("says everyone with a login has one, and no more, when the states couldn't be read, and nobody else has", () => {
    const expected = { "Hana Lim": "unknown", "Leo Tan": "unknown", "Mei Wong": "unknown", "Zed Ong": "none" };
    const omitted = buildTeamView({ teamId: "team-ip1", adminMemberId: ADMIN, teams: TEAMS, members: MEMBERS, leads: LEADS })!;
    for (const v of [view("team-ip1", MEMBERS, LEADS, [], null)!, omitted, view("team-ip1", MEMBERS, LEADS, [], states([]))!]) {
      expect(Object.fromEntries(v.people.map((p) => [p.name, p.login.state]))).toEqual(expected);
      for (const p of v.people) expect(p.login.state === "none", p.name).toBe(!p.hasLogin);
    }
  });

  it("ignores a login row for someone with no login linked", () => {
    const people = view("team-ip1", MEMBERS, LEADS, [], states([loginRow("m-zed", "active", { last_sign_in_at: SENT })]))!.people;
    expect(people.find((p) => p.id === "m-zed")).toMatchObject({
      hasLogin: false,
      login: { state: "none" },
      canGiveLogin: true,
      canResendInvite: false,
    });
  });

  it("offers Resend invite while a login given here is unused, even expired, or unread, and not once it's been used", () => {
    const given = (id: string, name: string) =>
      member(id, name, "member", "team-ip1", { auth_user_id: `u-${id.slice(2)}`, login_given_by: ADMIN, login_given_at: SENT });
    const members = [
      ...MEMBERS.filter((m) => m.id === ADMIN),
      given("m-fay", "Fay Fresh"),
      given("m-exa", "Exa Expired"),
      given("m-una", "Una Unread"),
      given("m-rei", "Rei Ready"),
      given("m-act", "Act Active"),
    ];
    // Read three hours after SENT: Fay's invite went out half an hour before, Exa's at SENT.
    const logins = states(
      [
        loginRow("m-fay", "invited", { invited_at: later(SENT, 150 * MINUTE) }),
        loginRow("m-exa", "invited", { invited_at: SENT }),
        loginRow("m-rei", "ready"),
        loginRow("m-act", "active", { last_sign_in_at: later(SENT, 60 * MINUTE) }),
      ],
      later(SENT, 180 * MINUTE),
    );
    const people = view("team-ip1", members, LEADS, [], logins)!.people;
    const flags = Object.fromEntries(
      people.map((p) => [p.name, [loginStatusText(p.login).label, p.canResendInvite, p.canChangeEmail]]),
    );
    expect(flags).toEqual({
      "Act Active": ["Active", false, true],
      "Exa Expired": ["Invite expired", true, true],
      "Fay Fresh": ["Invite not used", true, true],
      "Hana Lim": ["Has a login", false, false], // a Master Admin, and the admin
      "Rei Ready": ["Never signed in", false, true],
      "Una Unread": ["Has a login", true, true],
    });
    // Unread, every login given here is offered: the server checks again.
    const unread = view("team-ip1", members, LEADS, [], null)!.people;
    expect(unread.filter((p) => p.canResendInvite).map((p) => p.name)).toEqual([
      "Act Active",
      "Exa Expired",
      "Fay Fresh",
      "Rei Ready",
      "Una Unread",
    ]);
  });

  it("never offers Resend invite on a Master Admin's row or the admin's own, whatever state their login is in", () => {
    // Leo is the signed-in admin; Hana and Chief are Master Admins; each had a login given here.
    const given = { login_given_by: "m-mei", login_given_at: SENT };
    const members = [
      member(ADMIN, "Hana Lim", "hq", "team-ip1", { auth_user_id: "u-hana", ...given }),
      member("m-chief", "Chief Ong", "hq", "team-ip1", { auth_user_id: "u-chief", ...given }),
      member("m-leo", "Leo Tan", "leader", "team-ip1", { auth_user_id: "u-leo", ...given }),
    ];
    const unused = members.map((m) => loginRow(m.id, "invited", { invited_at: SENT }));
    const at = (logins: LoginStates) =>
      buildTeamView({ teamId: "team-ip1", adminMemberId: "m-leo", teams: TEAMS, members, leads: [], logins })!.people;
    for (const logins of [states(unused), states(unused, later(SENT, 120 * MINUTE)), states([]), null]) {
      expect(at(logins).map((p) => [p.name, p.canResendInvite])).toEqual([
        ["Chief Ong", false],
        ["Hana Lim", false],
        ["Leo Tan", false],
      ]);
    }
    // Their rows still say how their login stands.
    expect(at(states(unused)).map((p) => loginStatusText(p.login).label)).toEqual([
      "Invite not used",
      "Invite not used",
      "Invite not used",
    ]);
  });

  it("never carries an email address or auth user id, even with the login states", () => {
    const rows = [
      // Even if the function ever returned more than it should.
      { ...loginRow("m-mei", "invited", { invited_at: SENT }), email: "mei@example.com", user_id: "u-mei" } as LoginRow,
      loginRow("m-leo", "active", { last_sign_in_at: SENT }),
      loginRow(ADMIN, "ready"),
    ];
    const v = view("team-ip1", MEMBERS, LEADS, [], states(rows))!;
    expect(v.people.map((p) => p.login.state)).toEqual(["ready", "active", "invited", "none"]);
    expect(JSON.stringify(v)).not.toMatch(/u-(hana|leo|mei)|@|example/);
  });

  it("doesn't bring back someone removed from Module One through a login row", () => {
    const removed = [
      member("m-sam", "Sam Lau", "leader", "team-ip1", { ...REMOVED, auth_user_id: "u-sam" }), // a stale link
      member("m-rae", "Rae Koh", "member", null, REMOVED),
    ];
    const logins = states([
      loginRow("m-mei", "active", { last_sign_in_at: SENT }),
      loginRow("m-sam", "active", { last_sign_in_at: SENT }),
      loginRow("m-rae", "invited", { invited_at: SENT }),
    ]);
    for (const teamId of ["team-ip1", "team-ip2", "dom-ip", "div-gather", "dom-legacy"]) {
      expect(view(teamId, [...MEMBERS, ...removed], LEADS, [], logins), teamId).toEqual(view(teamId, MEMBERS, LEADS, [], logins));
    }
  });
});

describe("buildNoTeamPeople", () => {
  const noTeam = (members = MEMBERS, leads = LEADS, grants: { member_id: string }[] = [], teams = TEAMS, logins?: LoginStates) =>
    buildNoTeamPeople({ adminMemberId: ADMIN, teams, members, leads, grants, logins });

  it("lists everyone in no team who wasn't removed from Module One, by name", () => {
    const members = [...MEMBERS, member("m-rae", "Rae Koh", "member", null, REMOVED), member("m-abe", "Abe Chu", "member", null)];
    expect(noTeam(members).map((p) => p.name)).toEqual(["Abe Chu", "Ada Boss", "Ben Kho", "Cat Ng"]);
  });

  it("offers no role or team controls: people are placed by dragging them on the chart", () => {
    const people = noTeam();
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) expect(p).toMatchObject({ editable: false, title: null, leadsHere: false, leadsDomain: null });
  });

  it("offers logins, Change email and Remove from Module One as a team page does", () => {
    const members = MEMBERS.map((m) =>
      m.id === "m-cat" ? { ...m, auth_user_id: "u-cat", login_given_by: ADMIN, login_given_at: "2026-10-08T16:30:00Z" } : m,
    );
    const people = noTeam(members);
    const flags = Object.fromEntries(
      people.map((p) => [p.name, [p.canGiveLogin, p.canResendInvite, p.canChangeEmail, p.canRemove, p.ownerKeeps]]),
    );
    expect(flags).toEqual({
      "Ada Boss": [false, false, false, false, null], // a Master Admin
      "Ben Kho": [true, false, false, true, null],
      "Cat Ng": [false, true, true, true, null],
    });
    expect(people.find((p) => p.id === "m-cat")!.loginGiven).toBe("Login given by Hana Lim on 9 Oct 2026");
  });

  it("names the nodes a leader with no team leads, for the removal warning", () => {
    const leads = [...LEADS, { team_id: "team-ip2", member_id: "m-cat" }, { team_id: "dom-ip", member_id: "m-cat" }];
    expect(noTeam(MEMBERS, leads).find((p) => p.id === "m-cat")!.otherLeads).toEqual(["IP Lab", "IP Lab 2"]);
  });

  it("leaves grant holders and the organisation's leads to the project owner", () => {
    const leads = [...LEADS, { team_id: "org", member_id: "m-cat" }];
    const people = noTeam(MEMBERS, leads, [{ member_id: "m-ben" }], ORG_TEAMS);
    const flags = Object.fromEntries(people.map((p) => [p.name, [p.canChangeEmail, p.canRemove, p.ownerKeeps]]));
    expect(flags).toEqual({
      "Ada Boss": [false, false, null],
      "Ben Kho": [false, false, "grants"],
      "Cat Ng": [false, false, "organisation"],
    });
    expect(people.find((p) => p.id === "m-ben")).toMatchObject({ canGiveLogin: false, ownerGivesLogin: true });
  });

  it("offers nothing on the admin's own row", () => {
    const members = MEMBERS.map((m) => (m.id === "m-ben" ? { ...m, auth_user_id: "u-ben" } : m));
    const [ben] = buildNoTeamPeople({ adminMemberId: "m-ben", teams: TEAMS, members, leads: LEADS, grants: [{ member_id: "m-ben" }] }).filter(
      (p) => p.id === "m-ben",
    );
    expect(ben).toMatchObject({
      isSelf: true,
      canGiveLogin: false,
      canResendInvite: false,
      canChangeEmail: false,
      canRemove: false,
      ownerKeeps: null,
    });
  });

  it("never sends a member's auth user id, only whether they have a login", () => {
    const members = MEMBERS.map((m) => (m.team_id === null ? { ...m, auth_user_id: `u-${m.id.slice(2)}` } : m));
    const people = noTeam(members);
    expect(people.every((p) => p.hasLogin)).toBe(true);
    expect(JSON.stringify(people)).not.toMatch(/u-(boss|ben|cat)/);
  });

  it("says each person's login status as a team page does", () => {
    const given = { login_given_by: ADMIN, login_given_at: SENT };
    const members = MEMBERS.map((m) =>
      m.id === "m-cat" ? { ...m, auth_user_id: "u-cat", ...given } : m.id === "m-ben" ? { ...m, auth_user_id: "u-ben", ...given } : m,
    );
    const rows = [
      { ...loginRow("m-cat", "invited", { invited_at: SENT }), email: "cat@example.com" } as LoginRow,
      loginRow("m-ben", "active", { last_sign_in_at: SENT }),
    ];
    const people = noTeam(members, LEADS, [], TEAMS, states(rows, later(SENT, 120 * MINUTE)));
    expect(loginOf(people, "m-cat")).toEqual({ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: true });
    expect(loginOf(people, "m-ben")).toEqual({ state: "active", lastSignedInOn: "9 Oct 2026" });
    expect(loginOf(people, "m-boss")).toEqual({ state: "none" });
    expect(Object.fromEntries(people.map((p) => [p.name, p.canResendInvite]))).toEqual({
      "Ada Boss": false,
      "Ben Kho": false, // signed in already
      "Cat Ng": true,
    });
    expect(JSON.stringify(people)).not.toMatch(/u-(boss|ben|cat)|@|example/);
    // Unread, both just have a login, and either invite can be re-sent.
    const unread = noTeam(members);
    expect(Object.fromEntries(unread.map((p) => [p.name, [p.login.state, p.canResendInvite]]))).toEqual({
      "Ada Boss": ["none", false],
      "Ben Kho": ["unknown", true],
      "Cat Ng": ["unknown", true],
    });
  });

  it("doesn't bring back someone removed from Module One through a login row", () => {
    const removed = member("m-rae", "Rae Koh", "member", null, { ...REMOVED, auth_user_id: "u-rae" });
    const logins = states([loginRow("m-rae", "invited", { invited_at: SENT })]);
    expect(noTeam([...MEMBERS, removed], LEADS, [], TEAMS, logins)).toEqual(noTeam(MEMBERS, LEADS, [], TEAMS, logins));
  });
});

describe("confirm dialog copy", () => {
  const leo = { name: "Leo Tan", role: "leader" as const, otherLeads: [], leadsHere: false, leadsDomain: null };
  const team = { name: "IP Lab 1", kind: "team" as const };
  const domain = { name: "IP Lab", kind: "domain" as const };

  it("warns that making a leader a member also ends every extra lead", () => {
    expect(demoteDescription(leo, team)).toBe(
      "Members see only their own check-ins, so Leo Tan will stop seeing the check-ins made in IP Lab 1.",
    );
    expect(demoteDescription({ ...leo, otherLeads: ["IP Lab 2", "Legacy"] }, domain)).toBe(
      "Members see only their own check-ins, so Leo Tan will stop seeing the check-ins made in IP Lab and " +
        "its sub-teams, and will no longer lead IP Lab 2 and Legacy.",
    );
  });

  it("says what a new leader will see", () => {
    expect(promoteDescription({ ...leo, role: "member" }, domain)).toBe(
      "Leaders see the check-ins made in their own team, so Leo Tan will see the check-ins made in IP Lab " +
        "and its sub-teams. A leader can also be added as a lead of other teams.",
    );
  });

  it("says what removing someone changes, and that a lead row keeps a leader leading", () => {
    const stays = "stays in Module One without a team, and their past check-ins stay with IP Lab 1.";
    expect(removeDescription({ ...leo, role: "member" }, team)).toBe(`Leo Tan ${stays}`);
    expect(removeDescription(leo, team)).toBe(`Leo Tan ${stays} They'll stop seeing the check-ins made in IP Lab 1.`);
    expect(removeDescription({ ...leo, leadsHere: true }, team)).toBe(
      `Leo Tan ${stays} They still lead IP Lab 1, as an added lead.`,
    );
  });

  it("doesn't say a leader will stop seeing a team's check-ins while they lead the domain holding it", () => {
    const stays = "stays in Module One without a team, and their past check-ins stay with IP Lab 1.";
    const description = removeDescription({ ...leo, leadsDomain: "IP Lab" }, team);
    expect(description).toBe(`Leo Tan ${stays} They still lead IP Lab, which holds this team.`);
    expect(description).not.toContain("stop seeing");
  });

  it("says what removing someone from Module One does, with a login and without", () => {
    const mei = { name: "Mei Wong", hasLogin: true, otherLeads: [] };
    expect(removePersonDescription(mei, team)).toBe(
      "Mei Wong won't be able to sign in any more. They leave IP Lab 1. Anything they recorded stays, so past " +
        "weeks on the heat-map don't change. This can't be undone here.",
    );
    expect(removePersonDescription({ ...mei, hasLogin: false }, team)).toBe(
      "They leave IP Lab 1. Anything they recorded stays, so past weeks on the heat-map don't change. If " +
        "they've never had a login and left nothing behind, they're deleted completely. This can't be undone here.",
    );
  });

  it("names the nodes a leader stops leading, whether or not they sit in one", () => {
    const leader = { ...leo, hasLogin: true, otherLeads: ["IP Lab 2", "Legacy"] };
    expect(removePersonDescription(leader, team)).toBe(
      "Leo Tan won't be able to sign in any more. They leave IP Lab 1 and stop leading IP Lab 2 and Legacy. " +
        "Anything they recorded stays, so past weeks on the heat-map don't change. This can't be undone here.",
    );
    expect(removePersonDescription({ ...leader, otherLeads: ["Atlas", "IP Lab 2", "Legacy"] }, null)).toBe(
      "Leo Tan won't be able to sign in any more. They stop leading Atlas, IP Lab 2 and Legacy. Anything they " +
        "recorded stays, so past weeks on the heat-map don't change. This can't be undone here.",
    );
  });

  it("says nothing about leaving for someone with no team who leads nothing", () => {
    expect(removePersonDescription({ name: "Ben Kho", hasLogin: false, otherLeads: [] }, null)).toBe(
      "Anything they recorded stays, so past weeks on the heat-map don't change. If they've never had a login " +
        "and left nothing behind, they're deleted completely. This can't be undone here.",
    );
  });

  it("always ends by saying removal can't be undone here", () => {
    for (const hasLogin of [true, false]) {
      for (const otherLeads of [[], ["IP Lab 2"]]) {
        for (const where of [team, null]) {
          const description = removePersonDescription({ name: "Leo Tan", hasLogin, otherLeads }, where);
          expect(description.endsWith(" This can't be undone here.")).toBe(true);
          expect(description).not.toMatch(/^\s|\s{2}|\s$/);
        }
      }
    }
  });
});

describe("loginGivenText", () => {
  it.each([
    ["Hana Lim", "2026-10-08T16:30:00Z", "Login given by Hana Lim on 9 Oct 2026"],
    [null, "2026-10-08T16:30:00Z", "Login given on 9 Oct 2026"],
    ["Hana Lim", null, "Login given by Hana Lim"],
    ["Hana Lim", "not a date", "Login given by Hana Lim"],
    [null, "not a date", null],
    [null, null, null],
  ])("%s, %s → %s", (giver, at, expected) => {
    expect(loginGivenText(giver, at)).toBe(expected);
  });
});

describe("emailChangedText", () => {
  it.each([
    ["Hana Lim", "2026-10-08T16:30:00Z", "Sign-in email changed by Hana Lim on 9 Oct 2026"],
    [null, "2026-10-08T16:30:00Z", "Sign-in email changed on 9 Oct 2026"],
    [null, "2026-10-09T16:00:00Z", "Sign-in email changed on 10 Oct 2026"], // midnight in Singapore
    ["Hana Lim", null, "Sign-in email changed by Hana Lim"],
    ["Hana Lim", "not a date", "Sign-in email changed by Hana Lim"],
    [null, "not a date", null],
    [null, null, null],
  ])("%s, %s → %s", (changer, at, expected) => {
    expect(emailChangedText(changer, at)).toBe(expected);
  });
});

describe("loginStatusText", () => {
  it.each<[LoginStatus, string, LoginStatusText["tone"], string | null]>([
    [{ state: "none" }, "No login yet", "neutral", null],
    [{ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: false }, "Invite not used", "warning", "Invite sent 9 Oct 2026, 12:30 am"],
    [{ state: "invited", sentAt: "9 Oct 2026, 12:30 am", expired: true }, "Invite expired", "warning", "Invite sent 9 Oct 2026, 12:30 am"],
    [{ state: "invited", sentAt: null, expired: false }, "Can't sign in yet", "warning", "No invite has been sent"],
    [{ state: "invited", sentAt: null, expired: true }, "Can't sign in yet", "warning", "No invite has been sent"],
    [{ state: "ready" }, "Never signed in", "neutral", "Their login is ready: they sign in at the login page"],
    [{ state: "active", lastSignedInOn: "8 Oct 2026" }, "Active", "success", "Last signed in with a link on 8 Oct 2026"],
    [{ state: "active", lastSignedInOn: null }, "Active", "success", null],
    [{ state: "unknown" }, "Has a login", "neutral", null],
  ])("%j → %s (%s), %j", (status, label, tone, detail) => {
    expect(loginStatusText(status)).toEqual({ label, tone, detail });
  });
});

describe("nameList", () => {
  it.each([
    [["IP Lab 2"], "IP Lab 2"],
    [["IP Lab 2", "Atlas"], "IP Lab 2 and Atlas"],
    [["A", "B", "C"], "A, B and C"],
  ])("%j → %s", (names, expected) => {
    expect(nameList(names)).toBe(expected);
  });
});

describe("matchesSearch", () => {
  it.each([
    ["Mei Wong", "", true],
    ["Mei Wong", "  ", true],
    ["Mei Wong", "wong", true],
    ["Mei Wong", "EI W", true],
    ["Ève Tan", "eve", true],
    ["Eve Tan", "ève", true],
    ["Mei Wong", "leo", false],
  ])("%s / %j → %s", (name, query, expected) => {
    expect(matchesSearch(name, query)).toBe(expected);
  });
});

describe("coverage", () => {
  it("is the team itself, a domain and its sub-teams, or a division and everything in it", () => {
    expect(coverage({ name: "IP Lab 1", kind: "team" })).toBe("IP Lab 1");
    expect(coverage({ name: "IP Lab", kind: "domain" })).toBe("IP Lab and its sub-teams");
    expect(coverage({ name: "Gather", kind: "division" })).toBe("Gather and everything in it");
    expect(coverage({ name: "The New Normal", kind: "organisation" })).toBe("The New Normal and everything in it");
  });
});
