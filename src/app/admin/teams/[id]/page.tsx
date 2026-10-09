import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeadsSection } from "@/components/admin/team/leads-section";
import { PeopleSection } from "@/components/admin/team/people-section";
import { TeamHeader } from "@/components/admin/team/team-header";
import { logError } from "@/lib/admin/errors";
import { adminForMetadata, requireAdminPage } from "@/lib/admin/session";
import { TEAM_COLUMNS, type TeamRow } from "@/lib/admin/tree";
import { isUuid } from "@/lib/admin/validate";
import { updateNode } from "@/app/admin/structure/actions";
import {
  addLead,
  addMember,
  createMember,
  giveLogin,
  removeFromTeam,
  removeLead,
  resendInvite,
  setRole,
} from "./actions";
import { buildTeamView, type GrantRow, type LeadRow, MEMBER_COLUMNS, type MemberRow } from "./team-view";

const title = (name: string) => `${name} · Admin · Module One`;

// Each team's page is titled with its name, so screen readers announce it when moving between
// team pages (Next's route announcer reads the title, and only when it changes). Anyone but an
// admin gets the plain title; the page itself then sends them away.
export async function generateMetadata({ params }: PageProps<"/admin/teams/[id]">): Promise<Metadata> {
  const { id } = await params;
  const admin = await adminForMetadata();
  if (!admin || !isUuid(id)) return { title: title("Team") };
  const { data, error } = await admin.supabase.from("teams").select("name, kind").eq("id", id).maybeSingle();
  if (error) logError("team page title", error);
  const team = data as { name: string; kind: string } | null;
  return { title: title(team && team.kind !== "division" ? team.name : "Team") };
}

// A domain's or team's page ("clicking into the team name"): who is in it, who leads it, and
// giving people logins. Read as the signed-in admin, who sees every team, member and lead (RLS).
export default async function TeamPage({ params }: PageProps<"/admin/teams/[id]">) {
  const { id } = await params;
  const { supabase, memberId } = await requireAdminPage(`/admin/teams/${encodeURIComponent(id)}`);
  if (!isUuid(id)) notFound();

  // Every team (for the breadcrumb and the team names shown next to people), every member (people
  // to add and leaders to pick come from anywhere), every lead (a demotion removes all of a
  // leader's leads, and the warning lists them), and who holds a grant (they get their login from
  // the project owner). The organisation is small.
  const [teams, members, leads, grants] = await Promise.all([
    supabase.from("teams").select(TEAM_COLUMNS),
    supabase.from("members").select(MEMBER_COLUMNS),
    supabase.from("team_leads").select("team_id, member_id"),
    supabase.from("member_grants").select("member_id"),
  ]);
  const failed = teams.error ?? members.error ?? leads.error ?? grants.error;
  if (failed) {
    logError("load team page", failed);
    throw new Error("Couldn't load this team.");
  }

  const view = buildTeamView({
    teamId: id,
    adminMemberId: memberId,
    teams: (teams.data ?? []) as unknown as TeamRow[],
    members: (members.data ?? []) as unknown as MemberRow[],
    leads: (leads.data ?? []) as unknown as LeadRow[],
    grants: (grants.data ?? []) as unknown as GrantRow[],
  });
  if (!view) notFound();

  return (
    <>
      <TeamHeader team={view.team} crumbs={view.crumbs} updateNode={updateNode} />
      <PeopleSection
        team={view.team}
        people={view.people}
        candidates={view.candidates}
        actions={{ addMember, createMember, giveLogin, resendInvite, removeFromTeam, setRole }}
      />
      <LeadsSection
        team={view.team}
        ownLeaders={view.ownLeaders}
        leads={view.leads}
        inheritedLeads={view.inheritedLeads}
        leadOptions={view.leadOptions}
        actions={{ addLead, removeLead }}
      />
    </>
  );
}
