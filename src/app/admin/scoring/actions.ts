"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, logError, NO_PERMISSION, toUserMessage } from "@/lib/admin/errors";
import { checkScoringForm, fieldLabel, type ScoringField } from "@/lib/admin/scoring";
import { requireAdmin } from "@/lib/admin/session";

// Save the R/Y/G scoring settings (the one scoring_settings row) as the signed-in admin. RLS lets
// only admins update it, and the database refuses unusable settings with a sentence (23514),
// which is shown as is. The database stamps who changed it and when.
export async function saveScoring(form: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  const check = checkScoringForm(form);
  if (!check.ok) {
    const [field, error] = Object.entries(check.fieldErrors)[0] as [ScoringField, string];
    return { ok: false, error: `${fieldLabel(field)}: ${error}` };
  }
  if (check.problems.length > 0) return { ok: false, error: check.problems.join(" ") };

  const { data, error } = await admin.value.supabase
    .from("scoring_settings")
    .update(check.values)
    .eq("id", 1)
    .select("id");
  if (error) return { ok: false, error: toUserMessage(error, "saveScoring") };
  if (!data || data.length === 0) {
    // RLS hid the row (or it's gone): nothing was saved.
    logError("saveScoring", { code: "no_row" });
    return { ok: false, error: NO_PERMISSION };
  }

  revalidatePath("/admin/scoring");
  // Colours on the heat-map and its drill-in pages follow the settings.
  revalidatePath("/portal/dashboard", "layout");
  return { ok: true, value: null };
}
