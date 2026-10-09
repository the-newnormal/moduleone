import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/admin/errors";
import { type Glance, glance, weekTally } from "@/lib/dashboard/glance";
import { loadHeatmapData } from "@/lib/dashboard/load";
import { buildOrg, coverage } from "@/lib/dashboard/org";
import { shiftWeek } from "@/lib/dashboard/weeks";
import type { HealthConfig } from "@/lib/health/health";

type Tally = ReturnType<typeof weekTally>;

export type TeamHealthGlance =
  | {
      status: "ok";
      role: "leader" | "hq";
      config: HealthConfig;
      weeks: [lastWeek: string, thisWeek: string];
      glance: Glance;
      tally: { lastWeek: Tally; thisWeek: Tally };
    }
  | { status: "failed" }
  | { status: "hidden" };

// Last week and this week so far for the portal's Team health tile: two weeks rather than the org
// chart's eight, since the tile shows no history (and this week alone looks empty on a Monday).
// Only call it once the viewer is known to be a leader or hq; it checks the role again, because for
// a member RLS returns their own graded check-ins. Reads with the viewer's client, so RLS decides
// the rows; colours come from scoring_settings, as on the org chart. Never throws.
export async function loadTeamHealthGlance(supabase: SupabaseClient, thisWeek: string): Promise<TeamHealthGlance> {
  try {
    const weeks: [string, string] = [shiftWeek(thisWeek, -1), thisWeek];
    const { teams, checkins, config, role, ledTeams } = await loadHeatmapData(supabase, weeks);
    if (role !== "leader" && role !== "hq") return { status: "hidden" };
    const covers = coverage(role, ledTeams);
    const org = buildOrg({ teams, checkins, weeks, config, covers });
    return {
      status: "ok",
      role,
      config,
      weeks,
      glance: glance(org),
      tally: {
        lastWeek: weekTally(checkins, weeks[0], role, covers),
        thisWeek: weekTally(checkins, weeks[1], role, covers),
      },
    };
  } catch (error) {
    logError("portal team health", error);
    return { status: "failed" };
  }
}
