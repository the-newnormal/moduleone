// What the team page shows, worked out from the rows it loads (as the signed-in admin, who sees
// every team, member and lead). Pure, so it's unit-tested; the page and its client components only
// render the result. Nothing here leaves the server that the page doesn't need: in particular a
// member's auth_user_id becomes a yes/no.

import { formatDate } from "@/lib/admin/format";
import { isEditableMember, type Role, roleLabel } from "@/lib/admin/roles";
import { breadcrumb, KIND_LABELS, type TeamRow, typeLabel } from "@/lib/admin/tree";
import type { DivisionType, DomainType, TeamKind } from "@/lib/admin/validate";

// members columns the page reads.
export const MEMBER_COLUMNS = "id, name, role, team_id, auth_user_id, login_given_by, login_given_at";

export type MemberRow = {
  id: string;
  name: string;
  role: string;
  team_id: string | null;
  auth_user_id: string | null;
  login_given_by: string | null;
  login_given_at: string | null;
};

export type LeadRow = { team_id: string; member_id: string };

// member_grants rows (admins read them all); only who holds one matters here.
export type GrantRow = { member_id: string };

export type TeamSummary = {
  id: string;
  name: string;
  kind: TeamKind;
  kindLabel: string; // "Division" | "Domain" | "Team"
  code: string | null;
  domainType: DomainType | null;
  divisionType: DivisionType | null;
  typeLabel: string | null; // "Lab", "IP", "Development domain"
  note: string | null;
  archived: boolean;
};

// The breadcrumb above the name, top first, without the team itself, each linking to its page. A
// domain at the top level shows "Unplaced".
export type Crumb = { key: string; label: string; href: string | null };

export type Person = {
  id: string;
  name: string;
  role: Role;
  roleLabel: string;
  isSelf: boolean; // the signed-in admin
  editable: boolean; // false for Master Admins and the admin's own row (RLS refuses those)
  hasLogin: boolean;
  loginGiven: string | null; // "Login given by Hana Lim on 9 Oct 2026", only while they have a login
  // Give login is offered: editable, no login, and no grants (a new login would get them, so the
  // project owner gives those; giveLogin refuses them too).
  canGiveLogin: boolean;
  ownerGivesLogin: boolean; // editable, no login, holds grants
  canResendInvite: boolean; // editable, with a login given in Module One (it may not be used yet)
  otherLeads: string[]; // names of the teams they also lead (team_leads), lost if made a member
  leadsHere: boolean; // a team_leads row for this team too, so they lead it wherever they sit
  // The name of the nearest node above this one (its domain or division) where they have a lead
  // row. Leads cover everything under the led node, so they'd still lead this one from anywhere.
  leadsDomain: string | null;
};

// Someone who could be added to this team.
export type Candidate = { id: string; name: string; teamId: string | null; teamName: string | null };

// A leader who leads this team through team_leads, or could be made to. inThisTeam: they also sit
// in this team (a lead row added before they moved here), so they'd still lead it without the row.
// viaDomain: the nearest node above this one (its domain or division) that they lead too (they sit
// in it or have a lead row for it), so they'd also still lead this one without the row; viaOwnTeam:
// that node is the one they sit in.
export type LeadPerson = {
  id: string;
  name: string;
  teamName: string | null;
  inThisTeam: boolean;
  viaDomain: string | null;
  viaOwnTeam: boolean;
};

// A leader who leads this node because they lead a node above it, its domain or division (they sit
// in it, or have a lead row for it): leads cover everything under the led node. domainId and
// domainName are the nearest such node; changed on its page.
export type InheritedLead = { id: string; name: string; domainId: string; domainName: string };

// A leader who sits in this node (changed under People). domain: the nearest node above it where
// they also have a lead row (one row says both, so nobody is listed twice).
export type OwnLeader = { id: string; name: string; domain: { id: string; name: string } | null };

export type TeamView = {
  team: TeamSummary;
  crumbs: Crumb[];
  people: Person[];
  candidates: Candidate[]; // not in this team, not a Master Admin, not the admin; unassigned first
  ownLeaders: OwnLeader[]; // leaders whose own team is this one (and no lead row for it)
  leads: LeadPerson[]; // team_leads rows for this team (removable)
  inheritedLeads: InheritedLead[]; // who else leads it through a node above it (not removable here)
  leadOptions: LeadPerson[]; // leaders who could be added as a lead (none who lead it already)
};

const ROLES: readonly Role[] = ["member", "leader", "hq"];
// An unexpected role (the database allows only these three) is treated like a Master Admin: shown,
// never editable.
const asRole = (role: string): Role => (ROLES.includes(role as Role) ? (role as Role) : "hq");

const byName = <T extends { id: string; name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// "Login given by Hana Lim on 9 Oct 2026", or less when the giver's row is gone or the date is
// unreadable; null when nobody recorded giving it (logins made in the Supabase dashboard).
export function loginGivenText(giverName: string | null, givenAt: string | null): string | null {
  const on = formatDate(givenAt);
  if (giverName && on) return `Login given by ${giverName} on ${on}`;
  if (giverName) return `Login given by ${giverName}`;
  if (on) return `Login given on ${on}`;
  return null;
}

// What a leader of this node sees: the node and everything under it.
export function coverage(team: Pick<TeamSummary, "name" | "kind">): string {
  if (team.kind === "organisation" || team.kind === "division") return `${team.name} and everything in it`;
  return team.kind === "domain" ? `${team.name} and its sub-teams` : team.name;
}

// ---------- what the confirm dialogs say ----------

type Who = Pick<Person, "name" | "role" | "otherLeads" | "leadsHere" | "leadsDomain">;
type Where = Pick<TeamSummary, "name" | "kind">;

// "Make member": a leader loses what they saw as a leader, and every lead row they have (the
// database deletes them when the role changes).
export function demoteDescription(person: Who, team: Where): string {
  const leads = person.otherLeads.length > 0 ? `, and will no longer lead ${nameList(person.otherLeads)}` : "";
  return `Members see only their own check-ins, so ${person.name} will stop seeing the check-ins made in ${coverage(team)}${leads}.`;
}

export function promoteDescription(person: Who, team: Where): string {
  return (
    `Leaders see the check-ins made in their own team, so ${person.name} will see the check-ins made in ` +
    `${coverage(team)}. A leader can also be added as a lead of other teams.`
  );
}

// "Remove from team": a leader stops leading it, unless a lead row here, or on a node above it,
// keeps them leading it.
export function removeDescription(person: Who, team: Where): string {
  const stays = `${person.name} stays in Module One without a team, and their past check-ins stay with ${team.name}.`;
  if (person.role !== "leader") return stays;
  if (person.leadsHere) return `${stays} They still lead ${team.name}, as an added lead.`;
  if (person.leadsDomain) return `${stays} They still lead ${person.leadsDomain}, which holds this ${team.kind}.`;
  return `${stays} They'll stop seeing the check-ins made in ${coverage(team)}.`;
}

// "A", "A and B", "A, B and C".
export function nameList(names: readonly string[]): string {
  return new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(names);
}

// Case- and accent-insensitive "contains", for the name searches.
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");
export function matchesSearch(name: string, query: string): boolean {
  const q = fold(query.trim());
  return q === "" || fold(name).includes(q);
}

export function buildTeamView({
  teamId,
  adminMemberId,
  teams,
  members,
  leads,
  grants = [],
}: {
  teamId: string;
  adminMemberId: string;
  teams: readonly TeamRow[];
  members: readonly MemberRow[];
  leads: readonly LeadRow[];
  grants?: readonly GrantRow[];
}): TeamView | null {
  const row = teams.find((t) => t.id === teamId);
  if (!row) return null;

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const memberById = new Map(members.map((m) => [m.id, m]));
  const nameOfTeam = (id: string | null) => (id === null ? null : (teamName.get(id) ?? null));

  const team: TeamSummary = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind],
    code: row.code,
    domainType: row.kind === "domain" ? row.domain_type : null,
    divisionType: row.kind === "division" ? row.division_type : null,
    typeLabel: typeLabel(row),
    note: row.note,
    archived: row.archived_at !== null,
  };

  const above = breadcrumb(teamId, teams).slice(0, -1);
  const crumbs: Crumb[] = above.map((t) => ({ key: t.id, label: t.name, href: `/admin/teams/${t.id}` }));
  // A domain, or a domain's team, outside every division (the organisation node may sit above).
  if ((row.kind === "domain" || row.kind === "team") && !above.some((t) => t.kind === "division")) {
    crumbs.unshift({ key: "unplaced", label: "Unplaced", href: null });
  }

  const leadsOf = new Map<string, string[]>();
  for (const lead of leads) {
    const name = nameOfTeam(lead.team_id);
    if (name === null) continue;
    leadsOf.set(lead.member_id, [...(leadsOf.get(lead.member_id) ?? []), name]);
  }

  const holdsGrants = new Set(grants.map((g) => g.member_id));
  const leadIds = new Set(leads.filter((l) => l.team_id === teamId).map((l) => l.member_id));

  // A node is also led by whoever leads a node above it (its domain, its division): leaders placed
  // there, and its lead rows. Nearest first, so each person is said to lead through the closest.
  const nodesAbove = [...above].reverse();
  const leadRows = new Map<string, Set<string>>();
  for (const l of leads) leadRows.set(l.team_id, (leadRows.get(l.team_id) ?? new Set()).add(l.member_id));
  // The nearest node above where they have a lead row; or, counting where they sit, that they lead.
  const ledAboveByRow = (m: MemberRow) => nodesAbove.find((t) => leadRows.get(t.id)?.has(m.id));
  const ledAbove = (m: MemberRow) =>
    nodesAbove.find((t) => (m.role === "leader" && m.team_id === t.id) || leadRows.get(t.id)?.has(m.id));

  // Only the project owner places people in the organisation node (migration 0006), and whoever
  // sits there sees every check-in: its page shows who's there but offers no changes.
  const ownerOnly = row.kind === "organisation";

  const people: Person[] = members
    .filter((m) => m.team_id === teamId)
    .map((m) => {
      const role = asRole(m.role);
      const editable = !ownerOnly && isEditableMember({ id: m.id, role }, adminMemberId);
      const hasLogin = m.auth_user_id !== null;
      const giver = m.login_given_by ? (memberById.get(m.login_given_by)?.name ?? null) : null;
      return {
        id: m.id,
        name: m.name,
        role,
        roleLabel: roleLabel(role),
        isSelf: m.id === adminMemberId,
        editable,
        hasLogin,
        // A login deleted in the Supabase dashboard leaves login_given_* behind; don't show it.
        loginGiven: hasLogin ? loginGivenText(giver, m.login_given_at) : null,
        canGiveLogin: editable && !hasLogin && !holdsGrants.has(m.id),
        ownerGivesLogin: editable && !hasLogin && holdsGrants.has(m.id),
        canResendInvite: editable && hasLogin && m.login_given_at !== null,
        otherLeads: [...(leadsOf.get(m.id) ?? [])].sort((a, b) => a.localeCompare(b, "en")),
        leadsHere: leadIds.has(m.id),
        leadsDomain: role === "leader" ? (ledAboveByRow(m)?.name ?? null) : null,
      };
    })
    .sort(byName);

  const candidates: Candidate[] = members
    .filter((m) => !ownerOnly && m.team_id !== teamId && isEditableMember({ id: m.id, role: asRole(m.role) }, adminMemberId))
    .map((m) => ({ id: m.id, name: m.name, teamId: m.team_id, teamName: nameOfTeam(m.team_id) }))
    .sort((a, b) => Number(a.teamId !== null) - Number(b.teamId !== null) || byName(a, b));

  const asLead = (m: MemberRow): LeadPerson => {
    const via = m.role === "leader" ? ledAbove(m) : undefined;
    return {
      id: m.id,
      name: m.name,
      teamName: nameOfTeam(m.team_id),
      inThisTeam: m.team_id === teamId,
      viaDomain: via?.name ?? null,
      viaOwnTeam: via !== undefined && via.id === m.team_id,
    };
  };
  const leadPeople: LeadPerson[] = [...leadIds]
    .map((id) => memberById.get(id))
    .filter((m): m is MemberRow => m !== undefined)
    .map(asLead)
    .sort(byName);

  // Each person once: someone with a lead row here is listed with it (so it can be removed);
  // someone who sits here and also leads a node above, as sitting here (with that node said).
  const ownLeaders: OwnLeader[] = members
    .filter((m) => m.team_id === teamId && m.role === "leader" && !leadIds.has(m.id))
    .map((m) => {
      const via = ledAboveByRow(m);
      return { id: m.id, name: m.name, domain: via ? { id: via.id, name: via.name } : null };
    })
    .sort(byName);

  const inheritedLeads: InheritedLead[] = members
    .filter((m) => m.role === "leader" && !leadIds.has(m.id) && m.team_id !== teamId)
    .flatMap((m) => {
      const via = ledAbove(m);
      return via ? [{ id: m.id, name: m.name, domainId: via.id, domainName: via.name }] : [];
    })
    .sort(byName);
  const inherited = new Set(inheritedLeads.map((l) => l.id));

  // Leaders only (the database refuses anyone else), never the admin (RLS refuses that too), and
  // not someone who already leads this node: through team_leads, by sitting in it, or through a
  // node above it.
  const leadOptions: LeadPerson[] = members
    .filter(
      (m) =>
        !ownerOnly &&
        m.role === "leader" &&
        m.id !== adminMemberId &&
        !leadIds.has(m.id) &&
        m.team_id !== teamId &&
        !inherited.has(m.id),
    )
    .map(asLead)
    .sort(byName);

  return { team, crumbs, people, candidates, ownLeaders, leads: leadPeople, inheritedLeads, leadOptions };
}
