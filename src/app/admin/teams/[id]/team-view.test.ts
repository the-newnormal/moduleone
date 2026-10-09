import { describe, expect, it } from "vitest";
import type { TeamRow } from "@/lib/admin/tree";
import {
  buildTeamView,
  coverage,
  demoteDescription,
  loginGivenText,
  type MemberRow,
  matchesSearch,
  nameList,
  promoteDescription,
  removeDescription,
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

const view = (teamId: string, members = MEMBERS, leads = LEADS, grants: { member_id: string }[] = []) =>
  buildTeamView({ teamId, adminMemberId: ADMIN, teams: TEAMS, members, leads, grants });

describe("buildTeamView", () => {
  it("is null for an unknown id or a division", () => {
    expect(view("nope")).toBeNull();
    expect(view("div-gather")).toBeNull();
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
      typeLabel: null,
      note: null,
      archived: false,
    });
    expect(v.crumbs).toEqual([
      { key: "div-gather", label: "Gather", href: null },
      { key: "dom-ip", label: "IP Lab", href: "/admin/teams/dom-ip" },
    ]);
  });

  it("gives a domain its type and a division crumb", () => {
    const v = view("dom-ip")!;
    expect(v.team).toMatchObject({ kind: "domain", kindLabel: "Domain", domainType: "lab", typeLabel: "Lab", note: "The lab." });
    expect(v.crumbs).toEqual([{ key: "div-gather", label: "Gather", href: null }]);
  });

  it("says 'Unplaced' above a top-level domain and its teams", () => {
    expect(view("dom-legacy")!.crumbs).toEqual([{ key: "unplaced", label: "Unplaced", href: null }]);
    expect(view("team-legacy")!.crumbs).toEqual([
      { key: "unplaced", label: "Unplaced", href: null },
      { key: "dom-legacy", label: "Legacy", href: "/admin/teams/dom-legacy" },
    ]);
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
    expect(v.leads).toEqual([{ id: "m-ana", name: "Ana Lee", teamName: "IP Lab 2", inThisTeam: false }]);
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
      { id: "m-ana", name: "Ana Lee", teamName: "IP Lab 2", inThisTeam: false },
      { id: "m-leo", name: "Leo Tan", teamName: "IP Lab 1", inThisTeam: true },
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
    // A domain inherits nothing (divisions have no leads).
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
      { id: "m-cat", name: "Cat Ng", teamName: null, inThisTeam: false },
      { id: "m-eve", name: "Ève Tan", teamName: "Legacy", inThisTeam: false },
    ]);
    expect(view("team-ip2")!.leadOptions.map((o) => o.name)).toEqual(["Cat Ng", "Ève Tan"]);
  });

  it("never offers the admin as a lead, even if they were a leader", () => {
    const members = [member(ADMIN, "Hana Lim", "leader", "team-ip2"), member("m-cat", "Cat Ng", "leader", null)];
    expect(view("team-ip1", members, [])!.leadOptions.map((o) => o.id)).toEqual(["m-cat"]);
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
});

describe("loginGivenText", () => {
  it.each([
    ["Hana Lim", "2026-10-08T16:30:00Z", "Login given by Hana Lim on 9 Oct 2026"],
    [null, "2026-10-08T16:30:00Z", "Login given on 9 Oct 2026"],
    ["Hana Lim", null, "Login given by Hana Lim"],
    ["Hana Lim", "not a date", "Login given by Hana Lim"],
    [null, null, null],
  ])("%s, %s → %s", (giver, at, expected) => {
    expect(loginGivenText(giver, at)).toBe(expected);
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
  it("is the team itself, or a domain and its sub-teams", () => {
    expect(coverage({ name: "IP Lab 1", kind: "team" })).toBe("IP Lab 1");
    expect(coverage({ name: "IP Lab", kind: "domain" })).toBe("IP Lab and its sub-teams");
  });
});
