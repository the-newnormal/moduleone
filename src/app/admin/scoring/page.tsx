import type { Metadata } from "next";
import { ScoringForm } from "@/components/admin/scoring/scoring-form";
import { logError } from "@/lib/admin/errors";
import { formatDateTime } from "@/lib/admin/format";
import { formFromRow, SCORING_COLUMNS, type ScoringField } from "@/lib/admin/scoring";
import { requireAdminPage } from "@/lib/admin/session";
import { saveScoring } from "./actions";

export const metadata: Metadata = { title: "Scoring · Admin · Module One" };

type SettingsRow = Record<ScoringField, number | string> & {
  updated_at: string | null;
  updated_by: string | null;
};

export default async function ScoringPage() {
  const { supabase } = await requireAdminPage("/admin/scoring");

  const { data, error } = await supabase
    .from("scoring_settings")
    .select(`${SCORING_COLUMNS}, updated_at, updated_by`)
    .eq("id", 1)
    .single();
  if (error || !data) {
    logError("load scoring settings", error);
    throw new Error("Couldn't load the scoring settings.");
  }
  const row = data as unknown as SettingsRow;

  // updated_by is null for the settings the migration made, or once that person's row is gone.
  let changedBy: string | null = null;
  if (row.updated_by) {
    const member = await supabase.from("members").select("name").eq("id", row.updated_by).maybeSingle();
    if (member.error) logError("load scoring settings changer", member.error);
    changedBy = (member.data as { name: string } | null)?.name ?? null;
  }
  const changedOn = formatDateTime(row.updated_at);

  return (
    <>
      <header className="grid gap-2">
        <h1 className="text-4xl">Scoring</h1>
        <p className="max-w-3xl text-muted-foreground">
          How check-ins are coloured red, yellow or green on the heat-map. Colours are worked out
          when a page loads, so a change here recolours past weeks too.
        </p>
        {changedOn && (
          <p className="text-sm text-muted-foreground">
            Last changed {changedBy && <>by <span className="text-foreground">{changedBy}</span> </>}on{" "}
            {changedOn}.
          </p>
        )}
      </header>
      <ScoringForm saved={formFromRow(row)} save={saveScoring} />
    </>
  );
}
