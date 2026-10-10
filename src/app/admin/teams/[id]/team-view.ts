// What the team page shows, worked out from the rows it loads (as the signed-in admin, who sees
// every team, member and lead). Pure, so it's unit-tested; the page and its client components only
// render the result. Nothing here leaves the server that the page doesn't need: in particular a
// member's auth_user_id becomes a yes/no.

import { formatDate, formatDateTime } from "@/lib/admin/format";
import { asRole, isEditableMember, type Role, roleLabel } from "@/lib/admin/roles";
import { breadcrumb, KIND_LABELS, type TeamRow, typeLabel } from "@/lib/admin/tree";
import type { DivisionType, DomainType, TeamKind } from "@/lib/admin/validate";

// members columns the page reads.
export const MEMBER_COLUMNS =
  "id, name, role, team_id, auth_user_id, login_given_by, login_given_at, login_email_changed_by, login_email_changed_at, removed_at";

export type MemberRow = {
  id: string;
  name: string;
  role: string;
  team_id: string | null;
  auth_user_id: string | null;
  login_given_by: string | null;
  login_given_at: string | null;
  login_email_changed_by: string | null;
  login_email_changed_at: string | null;
  removed_at: string | null; // removed from Module One (0009): shown nowhere, offered for nothing
};

export type LeadRow = { team_id: string; member_id: string };

// member_grants rows (admins read them all); only who holds one matters here.
export type GrantRow = { member_id: string };

// What admin_login_states (0010) says about each linked login; never an email address. invited_at
// only while the login is unused (Supabase restamps it with every invite it sends).
export type LoginRow = {
  member_id: string;
  state: "invited" | "ready" | "active";
  invited_at: string | null;
  last_sign_in_at: string | null;
};

// Those rows, and when the server read them (so an invite's age doesn't depend on whose clock
// renders the page). Null when they couldn't be read.
export type LoginStates = { rows: readonly LoginRow[]; readAt: string } | null;

// How long an invite link works: Supabase's email OTP expiry (Authentication → Emails), an hour by
// default, as the README and the login page say.
export const INVITE_LINK_MS = 60 * 60 * 1000;

// Whether someone can sign in, and whether they have, with dates already formatted.
// "invited": a login nobody has used; expired when its last invite's link no longer works.
// "ready": a login set up ready to use that nobody has signed in with (they sign in at the login
// page). "unknown": they have a login, but the page couldn't read its state.
export type LoginStatus =
  | { state: "none" }
  | { state: "invited"; sentAt: string | null; expired: boolean } // sentAt: "3 Oct 2026, 3:04 pm"
  | { state: "ready" }
  | { state: "active"; lastSignedInOn: string | null } // "3 Oct 2026"
  | { state: "unknown" };

export type TeamSummary = {
  id: string;
  name: string;
  kind: TeamKind;
  kindLabel: string; // "Division" | "Domain" | "Team"
  code: string | null;
  domainType: DomainType | null;
  divisionType: DivisionType | null;
  typeLabel: string | null; // "Lab", "IP", "Development domain"
  leaderTitle: string | null; // what the leaders who sit here are called, like President (0006)
  note: string | null;
  archived: boolean;
  // Everyone placed here leads it, so it has no members: a division or the organisation once
  // migration 0006 is live (it adds the organisation node and that rule together). People added as
  // members arrive as leaders, and a leader here can't be made a member.
  everyoneLeads: boolean;
};

// The breadcrumb above the name, top first, without the team itself, each linking to its page. A
// domain at the top level shows "Unplaced".
export type Crumb = { key: string; label: string; href: string | null };

export type Person = {
  id: string;
  name: string;
  role: Role;
  roleLabel: string;
  title: string | null; // the node's title for its leaders ("President"), for a leader or hq sitting here
  isSelf: boolean; // the signed-in admin
  // Role and removal controls: false for Master Admins and the admin's own row (RLS refuses those),
  // and for everyone on the organisation's page (only the project owner changes who sits there).
  editable: boolean;
  hasLogin: boolean;
  login: LoginStatus; // "none" exactly when hasLogin is false
  loginGiven: string | null; // "Login given by Hana Lim on 9 Oct 2026", only while they have a login
  // Give login is offered: not a Master Admin or the admin themselves, no login, and no grants (a
  // new login would get them, so the project owner gives those; giveLogin refuses them too). Also
  // on the organisation's page: admins give whoever the owner placed there a login (owner's call).
  canGiveLogin: boolean;
  ownerGivesLogin: boolean; // as canGiveLogin, but holds grants
  // Not a Master Admin or the admin, with a login given in Module One that hasn't been used (or
  // whose state couldn't be read: the server checks again either way).
  canResendInvite: boolean;
  // As canResendInvite, but the unused login wasn't given in Module One (it was made in the
  // Supabase dashboard), so only the project owner can send its invite again.
  ownerResendsInvite: boolean;
  emailChanged: string | null; // "Sign-in email changed by Hana Lim on 9 Oct 2026", while they have a login
  // Change email and Remove from Module One: not a Master Admin or the admin, and not someone the
  // project owner keeps (below). Change email needs a login.
  canChangeEmail: boolean;
  canRemove: boolean;
  // Why neither is offered, when that's the project owner's call: they hold grants, or they sit in
  // or lead the organisation (both servers refuse these too).
  ownerKeeps: "grants" | "organisation" | null;
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

const byName = <T extends { id: string; name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// "Login given by Hana Lim on 9 Oct 2026", or less when the giver's row is gone or the date is
// unreadable; null when nobody recorded giving it (logins made in the Supabase dashboard).
export function loginGivenText(giverName: string | null, givenAt: string | null): string | null {
  return byWhom("Login given", giverName, givenAt);
}

// What a person's row says about their login: a tag of a few words, the tag's tone, and more
// detail when there is some.
export type LoginStatusText = {
  label: string;
  tone: "neutral" | "warning" | "success";
  detail: string | null;
};

export function loginStatusText(status: LoginStatus): LoginStatusText {
  switch (status.state) {
    case "none":
      return { label: "No login yet", tone: "neutral", detail: null };
    case "invited":
      // No invite time: a login the project owner made in the dashboard without inviting or
      // confirming it. Nobody can sign in with it until an invite goes out.
      if (status.sentAt === null) return { label: "Can't sign in yet", tone: "warning", detail: "No invite has been sent" };
      return {
        label: status.expired ? "Invite expired" : "Invite not used",
        tone: "warning",
        detail: `Invite sent ${status.sentAt}`,
      };
    case "ready":
      return { label: "Never signed in", tone: "neutral", detail: "Their login is ready: they sign in at the login page" };
    case "active":
      return {
        label: "Active",
        tone: "success",
        // Staying signed in doesn't update it, only opening a sign-in link does.
        detail: status.lastSignedInOn && `Last signed in with a link on ${status.lastSignedInOn}`,
      };
    case "unknown":
      return { label: "Has a login", tone: "neutral", detail: null };
  }
}

type LoginsRead = { byMember: Map<string, LoginRow>; readAt: number } | null;

// One member's login status. A linked login with no row (deleted meanwhile), or when the rows
// couldn't be read, reads as unknown.
function loginStatusOf(m: MemberRow, logins: LoginsRead): LoginStatus {
  if (m.auth_user_id === null) return { state: "none" };
  const row = logins?.byMember.get(m.id);
  if (!logins || !row) return { state: "unknown" };
  switch (row.state) {
    case "invited": {
      const sent = row.invited_at === null ? NaN : Date.parse(row.invited_at);
      const expired = Number.isFinite(sent) && Number.isFinite(logins.readAt) && logins.readAt - sent >= INVITE_LINK_MS;
      return { state: "invited", sentAt: formatDateTime(row.invited_at), expired };
    }
    case "ready":
      return { state: "ready" };
    case "active":
      return { state: "active", lastSignedInOn: formatDate(row.last_sign_in_at) };
    default:
      return { state: "unknown" };
  }
}

// "Sign-in email changed by Hana Lim on 9 Oct 2026", the same way.
export function emailChangedText(changerName: string | null, changedAt: string | null): string | null {
  return changedAt === null && changerName === null ? null : byWhom("Sign-in email changed", changerName, changedAt);
}

function byWhom(what: string, name: string | null, at: string | null): string | null {
  const on = formatDate(at);
  if (name && on) return `${what} by ${name} on ${on}`;
  if (name) return `${what} by ${name}`;
  if (on) return `${what} on ${on}`;
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

// "Remove from Module One". team: where they sit, null for someone with no team.
export function removePersonDescription(
  person: Pick<Person, "name" | "hasLogin" | "otherLeads">,
  team: Pick<TeamSummary, "name"> | null,
): string {
  const leads = person.otherLeads.length > 0 ? nameList(person.otherLeads) : null;
  const leaving = team
    ? `They leave ${team.name}${leads ? ` and stop leading ${leads}` : ""}.`
    : leads
      ? `They stop leading ${leads}.`
      : "";
  return [
    person.hasLogin ? `${person.name} won't be able to sign in any more.` : "",
    leaving,
    "Anything they recorded stays, so past weeks on the heat-map don't change.",
    person.hasLogin ? "" : "If they've never had a login and left nothing behind, they're deleted completely.",
    "This can't be undone here.",
  ]
    .filter(Boolean)
    .join(" ");
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
  logins = null,
}: {
  teamId: string;
  adminMemberId: string;
  teams: readonly TeamRow[];
  members: readonly MemberRow[];
  leads: readonly LeadRow[];
  grants?: readonly GrantRow[];
  logins?: LoginStates; // admin_login_states; null when it couldn't be read
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
    leaderTitle: row.leader_title,
    note: row.note,
    archived: row.archived_at !== null,
    everyoneLeads:
      (row.kind === "division" || row.kind === "organisation") && teams.some((t) => t.kind === "organisation"),
  };

  const above = breadcrumb(teamId, teams).slice(0, -1);
  const crumbs: Crumb[] = above.map((t) => ({ key: t.id, label: t.name, href: `/admin/teams/${t.id}` }));
  // A domain, or a domain's team, outside every division (the organisation node may sit above).
  if ((row.kind === "domain" || row.kind === "team") && !above.some((t) => t.kind === "division")) {
    crumbs.unshift({ key: "unplaced", label: "Unplaced", href: null });
  }

  const everyone = peopleContext({ adminMemberId, teams, members, leads, grants, logins });
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
  // sits there sees every check-in: its page shows who's there and offers no changes, except
  // giving them a login (admins may, by the owner's decision).
  const ownerOnly = row.kind === "organisation";

  const people: Person[] = everyone.current
    .filter((m) => m.team_id === teamId)
    .map((m) =>
      personOf(m, everyone, {
        ownerOnly,
        leaderTitle: row.leader_title,
        leadsHere: leadIds.has(m.id),
        leadsDomain: asRole(m.role) === "leader" ? (ledAboveByRow(m)?.name ?? null) : null,
      }),
    )
    .sort(byName);

  // Not whoever sits in the organisation either: only the project owner moves them. Nor anyone
  // removed from Module One (from here on, every list leaves them out).
  const { organisationId } = everyone;
  const candidates: Candidate[] = everyone.current
    .filter(
      (m) =>
        !ownerOnly &&
        m.team_id !== teamId &&
        (organisationId === undefined || m.team_id !== organisationId) &&
        isEditableMember({ id: m.id, role: asRole(m.role) }, adminMemberId),
    )
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
    .filter((m): m is MemberRow => m !== undefined && m.removed_at === null)
    .map(asLead)
    .sort(byName);

  // Each person once: someone with a lead row here is listed with it (so it can be removed);
  // someone who sits here and also leads a node above, as sitting here (with that node said).
  const ownLeaders: OwnLeader[] = everyone.current
    .filter((m) => m.team_id === teamId && m.role === "leader" && !leadIds.has(m.id))
    .map((m) => {
      const via = ledAboveByRow(m);
      return { id: m.id, name: m.name, domain: via ? { id: via.id, name: via.name } : null };
    })
    .sort(byName);

  const inheritedLeads: InheritedLead[] = everyone.current
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
  const leadOptions: LeadPerson[] = everyone.current
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

// ---------- people, wherever they're listed ----------

type PeopleContext = {
  adminMemberId: string;
  current: MemberRow[]; // everyone not removed from Module One
  memberById: Map<string, MemberRow>; // everyone, removed too (to name who gave a login)
  holdsGrants: Set<string>;
  leadsOf: Map<string, string[]>; // the names of the nodes each person has a lead row for
  organisationId: string | undefined;
  leadsOrganisation: Set<string>; // lead rows on the organisation node
  logins: LoginsRead; // each linked login's state by member; null if unread
};

function peopleContext({
  adminMemberId,
  teams,
  members,
  leads,
  grants,
  logins,
}: {
  adminMemberId: string;
  teams: readonly TeamRow[];
  members: readonly MemberRow[];
  leads: readonly LeadRow[];
  grants: readonly GrantRow[];
  logins: LoginStates;
}): PeopleContext {
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const leadsOf = new Map<string, string[]>();
  for (const lead of leads) {
    const name = teamName.get(lead.team_id);
    if (name === undefined) continue;
    leadsOf.set(lead.member_id, [...(leadsOf.get(lead.member_id) ?? []), name]);
  }
  const organisationId = teams.find((t) => t.kind === "organisation")?.id;
  return {
    adminMemberId,
    current: members.filter((m) => m.removed_at === null),
    memberById: new Map(members.map((m) => [m.id, m])),
    holdsGrants: new Set(grants.map((g) => g.member_id)),
    leadsOf,
    organisationId,
    leadsOrganisation: new Set(leads.filter((l) => l.team_id === organisationId).map((l) => l.member_id)),
    logins:
      logins === null
        ? null
        : { byMember: new Map(logins.rows.map((l) => [l.member_id, l])), readAt: Date.parse(logins.readAt) },
  };
}

// One person's row. `here`: what depends on the node they're listed under (none for No team).
function personOf(
  m: MemberRow,
  context: PeopleContext,
  here: { ownerOnly: boolean; leaderTitle: string | null; leadsHere: boolean; leadsDomain: string | null },
): Person {
  const { adminMemberId, memberById, holdsGrants, leadsOf, organisationId, leadsOrganisation, logins } = context;
  const role = asRole(m.role);
  const loginsHere = isEditableMember({ id: m.id, role }, adminMemberId);
  const hasLogin = m.auth_user_id !== null;
  const login = loginStatusOf(m, logins);
  const nameOf = (id: string | null) => (id ? (memberById.get(id)?.name ?? null) : null);
  const ownerKeeps = !loginsHere
    ? null
    : holdsGrants.has(m.id)
      ? "grants"
      : (organisationId !== undefined && m.team_id === organisationId) || leadsOrganisation.has(m.id)
        ? "organisation"
        : null;
  const canRemove = loginsHere && !here.ownerOnly && ownerKeeps === null;
  return {
    id: m.id,
    name: m.name,
    role,
    roleLabel: roleLabel(role),
    title: role === "member" ? null : here.leaderTitle,
    isSelf: m.id === adminMemberId,
    editable: !here.ownerOnly && loginsHere,
    hasLogin,
    login,
    // A login deleted in the Supabase dashboard leaves login_given_* behind; don't show it.
    loginGiven: hasLogin ? loginGivenText(nameOf(m.login_given_by), m.login_given_at) : null,
    canGiveLogin: loginsHere && !hasLogin && !holdsGrants.has(m.id),
    ownerGivesLogin: loginsHere && !hasLogin && holdsGrants.has(m.id),
    // Once a login is used, resendInvite refuses it (it signs in at the login page instead).
    canResendInvite:
      loginsHere && hasLogin && m.login_given_at !== null && (login.state === "invited" || login.state === "unknown"),
    ownerResendsInvite: loginsHere && login.state === "invited" && m.login_given_at === null,
    emailChanged:
      hasLogin && changedSinceGiven(m)
        ? emailChangedText(nameOf(m.login_email_changed_by), m.login_email_changed_at)
        : null,
    canChangeEmail: canRemove && hasLogin,
    canRemove,
    ownerKeeps,
    otherLeads: [...(leadsOf.get(m.id) ?? [])].sort((a, b) => a.localeCompare(b, "en")),
    leadsHere: here.leadsHere,
    leadsDomain: here.leadsDomain,
  };
}

// Whether the recorded email change is about the login they have now: a login given after it (once
// the earlier one was deleted in the dashboard) has had no change yet. The record stays either way.
function changedSinceGiven(m: Pick<MemberRow, "login_given_at" | "login_email_changed_at">): boolean {
  if (m.login_email_changed_at === null) return false;
  if (m.login_given_at === null) return true;
  const changed = Date.parse(m.login_email_changed_at);
  const given = Date.parse(m.login_given_at);
  return !Number.isFinite(changed) || !Number.isFinite(given) || changed >= given;
}

// Everyone who sits in no node (and wasn't removed), for the Structure page's No team panel: their
// logins, Change email and Remove from Module One. Placing them is done by dragging, so no role or
// team controls (editable is false).
export function buildNoTeamPeople({
  adminMemberId,
  teams,
  members,
  leads,
  grants = [],
  logins = null,
}: {
  adminMemberId: string;
  teams: readonly TeamRow[];
  members: readonly MemberRow[];
  leads: readonly LeadRow[];
  grants?: readonly GrantRow[];
  logins?: LoginStates;
}): Person[] {
  const context = peopleContext({ adminMemberId, teams, members, leads, grants, logins });
  return context.current
    .filter((m) => m.team_id === null)
    .map((m) => ({
      ...personOf(m, context, { ownerOnly: false, leaderTitle: null, leadsHere: false, leadsDomain: null }),
      editable: false,
    }))
    .sort(byName);
}
