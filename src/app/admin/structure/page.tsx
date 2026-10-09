import type { Metadata } from "next";
import { withCounts } from "@/components/admin/structure/counts";
import { StructureEditor } from "@/components/admin/structure/structure-editor";
import { logError } from "@/lib/admin/errors";
import { readAll } from "@/lib/admin/read-all";
import { requireAdminPage } from "@/lib/admin/session";
import { TEAM_COLUMNS, type TeamRow } from "@/lib/admin/tree";
import { archiveNode, createNode, moveNode, restoreNode, updateNode } from "./actions";

export const metadata: Metadata = { title: "Structure · Admin · Module One" };

// Every division, domain and team (admins see all of them, archived ones too), with how many
// people sit in each and who leads it, read as the signed-in admin. The editor does the rest.
export default async function StructurePage() {
  const { supabase } = await requireAdminPage("/admin/structure");

  // Read in full, past PostgREST's per-request row limit (readAll).
  const [teams, members, leads] = await Promise.all([
    readAll((from, to) => supabase.from("teams").select(TEAM_COLUMNS).order("id").range(from, to)),
    readAll((from, to) =>
      supabase.from("members").select("id, team_id, role").not("team_id", "is", null).order("id").range(from, to),
    ),
    readAll((from, to) =>
      supabase.from("team_leads").select("team_id, member_id").order("team_id").order("member_id").range(from, to),
    ),
  ]);
  const failed = teams.error ?? members.error ?? leads.error;
  if (failed || !teams.data || !members.data || !leads.data) {
    logError("load structure", failed);
    throw new Error("Couldn't load the team structure.");
  }
  const rows = withCounts(
    teams.data as unknown as TeamRow[],
    members.data as { id: string; team_id: string | null; role: string }[],
    leads.data as { team_id: string; member_id: string }[],
  );

  return (
    <>
      <header className="grid gap-2">
        <h1 id="structure-heading" tabIndex={-1} className="text-4xl outline-none">
          Structure
        </h1>
        <p className="max-w-3xl text-muted-foreground">
          Divisions hold domains, and domains hold teams. Drag a row by its handle to move it, or use
          Move to…. Open a division, domain or team to see and change who&apos;s in it.
        </p>
      </header>
      <StructureEditor rows={rows} actions={{ moveNode, createNode, updateNode, archiveNode, restoreNode }} />
    </>
  );
}
