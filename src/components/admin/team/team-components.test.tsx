import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Candidate, InheritedLead, LeadPerson, OwnLeader, Person, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { Dialog } from "@/components/ui/dialog";
import { AddPeoplePanel } from "./add-people-dialog";
import { EditTeamForm, savedForm } from "./edit-team-dialog";
import { GiveLoginForm } from "./give-login-dialog";
import { AddLeadPanel, LeadsSection } from "./leads-section";
import { PeopleSection } from "./people-section";
import { TeamHeader } from "./team-header";

const ok = async () => ({ ok: true as const, value: null });
const actions = {
  addMember: vi.fn(ok),
  createMember: vi.fn(ok),
  giveLogin: vi.fn(ok),
  resendInvite: vi.fn(ok),
  removeFromTeam: vi.fn(ok),
  setRole: vi.fn(ok),
  addLead: vi.fn(ok),
  removeLead: vi.fn(ok),
  updateNode: vi.fn(ok),
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
  note: null,
  archived: false,
};
const DOMAIN: TeamSummary = {
  ...TEAM,
  id: "c0000000-0000-4000-8000-000000000002",
  name: "IP Lab",
  kind: "domain",
  kindLabel: "Domain",
  code: "IP.X",
  domainType: "lab",
  typeLabel: "Lab",
  note: "First line\nSecond line",
};

// Since 0005 someone can sit in a division, so it has a page too.
const DIVISION: TeamSummary = {
  ...TEAM,
  id: "c0000000-0000-4000-8000-000000000003",
  name: "Gather",
  kind: "division",
  kindLabel: "Division",
  code: null,
  divisionType: "strategy",
  typeLabel: "Strategy division",
};

const person = (id: string, name: string, changes: Partial<Person> = {}): Person => ({
  id,
  name,
  role: "member",
  roleLabel: "Member",
  isSelf: false,
  editable: true,
  hasLogin: false,
  loginGiven: null,
  canGiveLogin: false,
  ownerGivesLogin: false,
  canResendInvite: false,
  otherLeads: [],
  leadsHere: false,
  leadsDomain: null,
  ...changes,
});

const PEOPLE: Person[] = [
  person("m-hana", "Hana Lim", { role: "hq", roleLabel: "Master Admin", isSelf: true, editable: false, hasLogin: true }),
  person("m-boss", "Ada Boss", { role: "hq", roleLabel: "Master Admin", editable: false, hasLogin: false }),
  person("m-leo", "Leo Tan", { role: "leader", roleLabel: "Leader", hasLogin: true, otherLeads: ["IP Lab 2"] }),
  person("m-mei", "Mei Wong", {
    hasLogin: true,
    loginGiven: "Login given by Hana Lim on 9 Oct 2026",
    canResendInvite: true,
  }),
  person("m-zed", "Zed Ong", { canGiveLogin: true }),
];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

// The text of one person's <li> (the row whose first line is their name).
function row(html: string, name: string) {
  const item = (html.match(/<li[\s\S]*?<\/li>/g) ?? []).map(text).find((li) => li.startsWith(name));
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

// Dialog parts need a Dialog around them (closed dialogs render nothing, so tests render the
// content on its own).
const inDialog = (content: React.ReactNode) => renderToStaticMarkup(<Dialog>{content}</Dialog>);

describe("PeopleSection", () => {
  const render = (team = TEAM, people = PEOPLE) =>
    renderToStaticMarkup(<PeopleSection team={team} people={people} candidates={[]} actions={actions} />);

  it("shows each person's role label and whether they can sign in", () => {
    const html = render();
    expect(row(html, "Hana Lim")).toContain("Master Admin Can sign in");
    expect(row(html, "Ada Boss")).toContain("Master Admin No login yet");
    expect(row(html, "Leo Tan")).toContain("Leader Can sign in");
    expect(row(html, "Zed Ong")).toContain("Member No login yet");
    expect(text(html)).toContain("People (5)");
    expect(text(html)).not.toMatch(/\bhq\b/);
  });

  it("says who gave a login and when", () => {
    expect(row(render(), "Mei Wong")).toContain("Login given by Hana Lim on 9 Oct 2026");
  });

  it("marks the admin's own row and offers nothing on it or on other Master Admin rows", () => {
    const html = render();
    expect(row(html, "Hana Lim")).toBe("Hana Lim (you) Master Admin Can sign in");
    expect(row(html, "Ada Boss")).toBe("Ada Boss Master Admin No login yet");
  });

  it("offers Make leader / Make member, Remove, Give login and Resend invite where they apply", () => {
    const html = render();
    expect(row(html, "Leo Tan")).toContain("Make member (Leo Tan)");
    expect(row(html, "Leo Tan")).not.toContain("Give login");
    expect(row(html, "Leo Tan")).not.toContain("Resend invite");
    expect(row(html, "Mei Wong")).toContain("Make leader (Mei Wong)");
    expect(row(html, "Mei Wong")).not.toContain("Give login");
    expect(row(html, "Mei Wong")).toContain("Resend invite (Mei Wong)");
    expect(row(html, "Zed Ong")).toContain("Give login (Zed Ong)");
    expect(row(html, "Zed Ong")).toContain("Remove from team (Zed Ong)");
    expect(count(html, />Remove from team<span class="sr-only">/g)).toBe(3);
    expect(count(html, />Give login</g)).toBe(1);
  });

  it("leaves Give login to the project owner for someone who holds grants", () => {
    const html = render(TEAM, [person("m-gus", "Gus Tay", { ownerGivesLogin: true })]);
    expect(row(html, "Gus Tay")).toContain("They hold grants, so the project owner gives them a login.");
    expect(row(html, "Gus Tay")).not.toContain("Give login (");
  });

  it("says 'domain' on a domain's page", () => {
    expect(row(render(DOMAIN), "Zed Ong")).toContain("Remove from domain (Zed Ong)");
  });

  it("offers Add people, except on an archived team", () => {
    expect(text(render())).toContain("Add people");
    const archived = text(render({ ...TEAM, archived: true }));
    expect(archived).not.toContain("Add people");
    expect(archived).toContain("This team is archived, so nobody can be added to it.");
  });

  it("says when nobody is in the team", () => {
    expect(text(render(TEAM, []))).toContain("Nobody is in this team yet.");
  });
});

describe("AddPeoplePanel", () => {
  const CANDIDATES: Candidate[] = [
    { id: "m-ben", name: "Ben Kho", teamId: null, teamName: null },
    { id: "m-ana", name: "Ana Lee", teamId: "t-2", teamName: "IP Lab 2" },
  ];
  const render = (candidates = CANDIDATES) =>
    renderToStaticMarkup(<AddPeoplePanel team={TEAM} candidates={candidates} actions={actions} onDone={() => {}} />);

  it("lists people without a team as they are and others with the team they'd move from", () => {
    const html = render();
    expect(row(html, "Ben Kho")).toBe("Ben Kho No team Add (Ben Kho)");
    expect(row(html, "Ana Lee")).toBe("Ana Lee moves from IP Lab 2 Move here (Ana Lee)");
    expect(html.indexOf("Ben Kho")).toBeLessThan(html.indexOf("Ana Lee"));
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Search by name<\/label><input[^>]*id="\1"/);
  });

  it("says when there's nobody to add", () => {
    expect(text(render([]))).toContain("Everyone you can add is already here.");
  });

  it("has a New person form with a name and the two roles an admin can give", () => {
    const html = render();
    expect(text(html)).toContain("New person");
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Name<\/label><input[^>]*id="\1"/);
    expect(count(html, /type="radio"/g)).toBe(2);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="member"/);
    expect(text(html)).toContain("Member Leader");
    expect(text(html)).not.toContain("Master Admin");
    expect(text(html)).toContain("New people have no login until you give them one.");
  });
});

describe("GiveLoginForm", () => {
  it("asks for an email address and says what the link does", () => {
    const html = inDialog(
      <GiveLoginForm person={{ id: "m-zed", name: "Zed Ong" }} giveLogin={actions.giveLogin} onDone={() => {}} />,
    );
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Email address<\/label><input[^>]*type="email"[^>]*id="\1"/);
    expect(text(html)).toContain("Give Zed Ong a login");
    expect(text(html)).toContain("a link that signs in as Zed Ong. Use an address only they read.");
    expect(text(html)).toContain("Send invite");
  });
});

describe("EditTeamForm", () => {
  it("edits a team's name, code and note, without a type, in the Structure page's form", () => {
    const html = inDialog(<EditTeamForm team={TEAM} updateNode={actions.updateNode} onSaved={() => {}} />);
    expect(html).toMatch(/value="IP Lab 1"/);
    expect(html).toMatch(/value="IP.1"/);
    expect(count(html, /<label/g)).toBe(3);
    expect(text(html)).not.toContain("Type");
    expect(text(html)).toContain("Edit IP Lab 1 It stays a team. To move it, use the Structure page.");
    expect(text(html)).toContain("1–8 letters or digits, optionally a dot and 1–8 more");
  });

  it("also edits a domain's type", () => {
    const html = inDialog(<EditTeamForm team={DOMAIN} updateNode={actions.updateNode} onSaved={() => {}} />);
    expect(count(html, /<label/g)).toBe(4);
    expect(text(html)).toContain("Type");
    expect(text(html)).toContain("It stays a domain.");
    expect(html).toContain("First line\nSecond line");
  });

  it("keeps a division's type, so saving it doesn't clear the type", () => {
    const html = inDialog(<EditTeamForm team={DIVISION} updateNode={actions.updateNode} onSaved={() => {}} />);
    expect(text(html)).toContain("It stays a division.");
    expect(savedForm(DIVISION)).toMatchObject({ name: "Gather", type: "strategy" });
    expect(savedForm(DOMAIN)).toMatchObject({ name: "IP Lab", type: "lab" });
  });

  it("keeps Save off until something changes", () => {
    const html = inDialog(<EditTeamForm team={TEAM} updateNode={actions.updateNode} onSaved={() => {}} />);
    expect(html).toMatch(/<button [^>]*type="submit" disabled="">Save<\/button>/);
  });
});

describe("LeadsSection", () => {
  const LEADS: LeadPerson[] = [
    { id: "m-ana", name: "Ana Lee", teamName: "IP Lab 2", inThisTeam: false, viaDomain: null, viaOwnTeam: false },
    { id: "m-ian", name: "Ian Goh", teamName: "IP Lab 1", inThisTeam: true, viaDomain: null, viaOwnTeam: false },
  ];
  const render = (
    team = TEAM,
    ownLeaders: OwnLeader[] = [{ id: "m-leo", name: "Leo Tan", domain: null }],
    leads = LEADS,
    inheritedLeads: InheritedLead[] = [],
  ) =>
    renderToStaticMarkup(
      <LeadsSection
        team={team}
        ownLeaders={ownLeaders}
        leads={leads}
        inheritedLeads={inheritedLeads}
        leadOptions={[]}
        actions={actions}
      />,
    );

  it("explains in one line what leads see, for a team and for a domain", () => {
    expect(text(render())).toContain("Leads see the check-ins made in this team.");
    expect(text(render(DOMAIN))).toContain("Leads see the check-ins made in this domain and in its sub-teams.");
    expect(text(render(DIVISION))).toContain("Leads see the check-ins made in this division and in everything in it.");
  });

  it("speaks of a division as a division", () => {
    expect(text(render(DIVISION, [], []))).toContain("Nobody leads this division yet.");
    const html = render(DOMAIN, [], [], [{ id: "m-nora", name: "Nora Lee", domainId: "div-gather", domainName: "Gather" }]);
    expect(row(html, "Nora Lee")).toBe("Nora Lee Leads Gather , which holds this domain");
    expect(html).toMatch(/<a [^>]*href="\/admin\/teams\/div-gather"[^>]*>Gather<\/a>/);
  });

  it("says a lead row's owner sits in the node holding it, not that they 'also lead' where they sit", () => {
    const nora: LeadPerson = { id: "m-nora", name: "Nora Lee", teamName: "Gather", inThisTeam: false, viaDomain: "Gather", viaOwnTeam: true };
    expect(row(render(DOMAIN, [], [nora]), "Nora Lee")).toBe(
      "Nora Lee Leader in Gather, which holds this domain Remove as lead (Nora Lee)",
    );
  });

  it("shows leaders in the team without a remove button, and team_leads rows with one", () => {
    const html = render();
    expect(row(html, "Leo Tan")).toBe("Leo Tan Leader in this team (change it under People)");
    expect(row(html, "Ana Lee")).toBe("Ana Lee Leader in IP Lab 2 Remove as lead (Ana Lee)");
    expect(row(html, "Ian Goh")).toBe("Ian Goh Leader in this team, also added as a lead Remove as lead (Ian Goh)");
    expect(text(html)).toContain("Add lead");
  });

  it("shows who leads it through its domain, linked to the domain, without a remove button", () => {
    const html = render(TEAM, [], [], [{ id: "m-ana", name: "Ana Lee", domainId: "dom-ip", domainName: "IP Lab" }]);
    expect(row(html, "Ana Lee")).toBe("Ana Lee Leads IP Lab , which holds this team");
    expect(html).toMatch(/<a [^>]*href="\/admin\/teams\/dom-ip"[^>]*>IP Lab<\/a>/);
    expect(text(html)).not.toContain("Nobody leads this team yet.");
  });

  it("shows a leader in the team who also leads its domain on one row, with the domain linked", () => {
    const html = render(TEAM, [{ id: "m-leo", name: "Leo Tan", domain: { id: "dom-ip", name: "IP Lab" } }], []);
    expect(row(html, "Leo Tan")).toBe(
      "Leo Tan Leader in this team (change it under People). Also leads IP Lab , which holds this team",
    );
    expect(text(html).match(/Leo Tan/g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*href="\/admin\/teams\/dom-ip"[^>]*>IP Lab<\/a>/);
  });

  it("says when nobody leads it, and offers no Add lead on an archived team", () => {
    expect(text(render(TEAM, [], []))).toContain("Nobody leads this team yet.");
    expect(text(render({ ...TEAM, archived: true }))).not.toContain("Add lead");
  });
});

describe("AddLeadPanel", () => {
  it("lists leaders with their own team", () => {
    const options: LeadPerson[] = [
      { id: "m-cat", name: "Cat Ng", teamName: null, inThisTeam: false, viaDomain: null, viaOwnTeam: false },
      { id: "m-eve", name: "Eve Tan", teamName: "Legacy", inThisTeam: false, viaDomain: null, viaOwnTeam: false },
    ];
    const html = renderToStaticMarkup(
      <AddLeadPanel team={TEAM} leadOptions={options} addLead={actions.addLead} onDone={() => {}} />,
    );
    expect(row(html, "Cat Ng")).toBe("Cat Ng Leader with no team Add as lead (Cat Ng)");
    expect(row(html, "Eve Tan")).toBe("Eve Tan Leader in Legacy Add as lead (Eve Tan)");
  });

  it("says when there's no leader to add", () => {
    const html = renderToStaticMarkup(
      <AddLeadPanel team={TEAM} leadOptions={[]} addLead={actions.addLead} onDone={() => {}} />,
    );
    expect(text(html)).toContain("There are no other leaders to add.");
  });
});

describe("TeamHeader", () => {
  it("shows the breadcrumb, the name with Edit, the badges and the note", () => {
    const html = renderToStaticMarkup(
      <TeamHeader
        team={DOMAIN}
        crumbs={[{ key: "div", label: "Gather", href: null }]}
        updateNode={actions.updateNode}
      />,
    );
    expect(html).toMatch(/<nav aria-label="Breadcrumb">/);
    expect(html).toContain('href="/admin/structure"');
    expect(text(html)).toMatch(/^Structure › Gather › IP Lab IP Lab Edit \(IP Lab\) Domain Lab Code IP.X First line/);
    expect(html).toMatch(/<span aria-current="page"[^>]*>IP Lab<\/span>/);
    expect(html).toMatch(/<h1[^>]*>IP Lab<\/h1>/);
    expect(text(html)).not.toContain("Archived");
  });

  it("links domains in the breadcrumb and marks an archived team", () => {
    const html = renderToStaticMarkup(
      <TeamHeader
        team={{ ...TEAM, archived: true }}
        crumbs={[
          { key: "div", label: "Gather", href: null },
          { key: "dom", label: "IP Lab", href: "/admin/teams/dom" },
        ]}
        updateNode={actions.updateNode}
      />,
    );
    expect(html).toMatch(/<a [^>]*href="\/admin\/teams\/dom"[^>]*>IP Lab<\/a>/);
    expect(text(html)).toContain("Archived");
  });
});
