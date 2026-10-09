import type { Metadata } from "next";
import {
  addLead,
  addMember,
  changeEmail,
  createMember,
  giveLogin,
  removeFromTeam,
  removeLead,
  removePerson,
  resendInvite,
  setRole,
} from "@/app/admin/teams/[id]/actions";
import { type GrantRow, type LeadRow, MEMBER_COLUMNS, type MemberRow } from "@/app/admin/teams/[id]/team-view";
import { withCounts } from "@/components/admin/structure/counts";
import { StructureCanvas } from "@/components/admin/structure/structure-canvas";
import { logError } from "@/lib/admin/errors";
import { readAll } from "@/lib/admin/read-all";
import { requireAdminPage } from "@/lib/admin/session";
import { TEAM_COLUMNS, type TeamRow } from "@/lib/admin/tree";
import { archiveNode, createNode, moveNode, restoreNode, updateNode } from "./actions";

export const metadata: Metadata = { title: "Structure · Admin · Module One" };

// Every division, domain and team (admins see all of them, archived ones too), everyone in them,
// who leads what and who holds a grant, read as the signed-in admin. The canvas does the rest: the
// chart, its drags and dialogs, and the side panel with a node's people and leads.
export default async function StructurePage() {
  const { supabase, memberId } = await requireAdminPage("/admin/structure");

  // Read in full, past PostgREST's per-request row limit (readAll).
  const [teams, members, leads, grants] = await Promise.all([
    readAll((from, to) => supabase.from("teams").select(TEAM_COLUMNS).order("id").range(from, to)),
    readAll((from, to) => supabase.from("members").select(MEMBER_COLUMNS).order("id").range(from, to)),
    readAll((from, to) =>
      supabase.from("team_leads").select("team_id, member_id").order("team_id").order("member_id").range(from, to),
    ),
    readAll((from, to) =>
      supabase.from("member_grants").select("member_id").order("member_id").order("grant_name").range(from, to),
    ),
  ]);
  const failed = teams.error ?? members.error ?? leads.error ?? grants.error;
  if (failed || !teams.data || !members.data || !leads.data || !grants.data) {
    logError("load structure", failed);
    throw new Error("Couldn't load the team structure.");
  }
  const people = members.data as unknown as MemberRow[];
  const leadRows = leads.data as unknown as LeadRow[];
  const rows = withCounts(teams.data as unknown as TeamRow[], people, leadRows);

  return (
    <>
      <header className="grid gap-2">
        <h1 id="structure-heading" tabIndex={-1} className="text-4xl outline-none">
          Structure
        </h1>
        <p className="max-w-3xl text-muted-foreground">
          The organisation as a chart: divisions hold domains, and domains hold teams. Drag a box onto another to
          restructure, or use its ⋯ menu. Click a box to see and change who&apos;s in it and who leads it.
        </p>
      </header>
      <StructureCanvas
        rows={rows}
        members={people}
        leads={leadRows}
        grants={grants.data as unknown as GrantRow[]}
        adminMemberId={memberId}
        actions={{ moveNode, createNode, updateNode, archiveNode, restoreNode }}
        teamActions={{
          addMember,
          createMember,
          giveLogin,
          resendInvite,
          removeFromTeam,
          setRole,
          addLead,
          removeLead,
          changeEmail,
          removePerson,
        }}
      />
    </>
  );
}
