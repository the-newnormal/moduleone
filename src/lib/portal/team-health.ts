import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/admin/errors";
import { type CheckedInRow, checkedInCounts } from "@/lib/dashboard/checked-in";
import { type Glance, glance, weekTally } from "@/lib/dashboard/glance";
import { loadHeatmapData } from "@/lib/dashboard/load";
import { type RedSpot, redSpots, seesNeedsALook } from "@/lib/dashboard/needs-a-look";
import { buildOrg, coverage, type OrgNode } from "@/lib/dashboard/org";
import { PAGE_SIZE, selectAll } from "@/lib/dashboard/select-all";
import type { TeamNode } from "@/lib/dashboard/tree";
import { weeksEndingAt } from "@/lib/dashboard/weeks";
import type { HealthConfig } from "@/lib/health/health";

// How many weeks of bars the portal's Team health tile shows, ending with this week. Fewer than the
// org chart's eight, to keep the portal quick for hq.
export const HOME_WEEKS = 6;

type Tally = ReturnType<typeof weekTally>;

export type TeamHealthGlance =
  | {
      status: "ok";
      role: "leader" | "hq";
      config: HealthConfig;
      weeks: string[]; // oldest first, ending with this week
      glance: Glance;
      tally: { lastWeek: Tally; thisWeek: Tally };
      // null when the viewer isn't someone the tile is for (see needs-a-look.ts).
      needsALook: { thisWeek: RedSpot[]; lastWeek: RedSpot[] } | null;
      checkedIn: CheckedInRow[] | "failed";
    }
  | { status: "failed" }
  | { status: "hidden" };

// The portal's team-health tiles: the last few weeks for the Team health table and the counts above
// it, the red spots for Needs a look, and who's checked in. Only call it once the viewer is known to
// be a leader or hq; it checks the role again, because for a member RLS returns their own graded
// check-ins. Reads with the viewer's client, so RLS decides the rows; colours come from
// scoring_settings, as on the org chart. Never throws.
export async function loadTeamHealthGlance(supabase: SupabaseClient, thisWeek: string): Promise<TeamHealthGlance> {
  try {
    const weeks = weeksEndingAt(thisWeek, HOME_WEEKS);
    const lastWeek = weeks[weeks.length - 2];
    const { teams, checkins, config, role, ledTeams } = await loadHeatmapData(supabase, weeks);
    if (role !== "leader" && role !== "hq") return { status: "hidden" };
    const covers = coverage(role, ledTeams);
    const org = buildOrg({ teams, checkins, weeks, config, covers });
    const shown = glance(org);
    const nodes = [...(shown.summary ? [shown.summary] : []), ...shown.rows, ...shown.other];
    return {
      status: "ok",
      role,
      config,
      weeks,
      glance: shown,
      tally: {
        lastWeek: weekTally(checkins, lastWeek, role, covers),
        thisWeek: weekTally(checkins, thisWeek, role, covers),
      },
      needsALook: seesNeedsALook(role, teams, ledTeams)
        ? { thisWeek: redSpots(org.roots, thisWeek), lastWeek: redSpots(org.roots, lastWeek) }
        : null,
      checkedIn: await loadCheckedIn(supabase, { role, ledTeams, teams, nodes, week: thisWeek }),
    };
  } catch (error) {
    logError("portal team health", error);
    return { status: "failed" };
  }
}

// Team ids per request: well inside what PostgREST's gateway accepts in a URL (as loadTeamWeek).
const TEAM_BATCH = 100;

// Who's checked in this week, as counts per box. People are read by team on the server (RLS would
// also hand an admin every member), and check-ins by week, ids only: no grade columns. A failure
// here leaves the rest of team health standing.
async function loadCheckedIn(
  supabase: SupabaseClient,
  {
    role,
    ledTeams,
    teams,
    nodes,
    week,
  }: { role: "leader" | "hq"; ledTeams: string[]; teams: TeamNode[]; nodes: OrgNode[]; week: string },
): Promise<CheckedInRow[] | "failed"> {
  try {
    type Member = { id: string; team_id: string | null };
    const batches: (string[] | null)[] = [];
    if (role === "hq") batches.push(null);
    else for (let i = 0; i < ledTeams.length; i += TEAM_BATCH) batches.push(ledTeams.slice(i, i + TEAM_BATCH));

    const [people, checkins] = await Promise.all([
      Promise.all(
        batches.map((ids) =>
          selectAll<Member>((after) => {
            let query = supabase.from("members").select("id, team_id");
            query = ids ? query.in("team_id", ids) : query.not("team_id", "is", null);
            if (after) query = query.gt("id", after);
            return query.order("id").limit(PAGE_SIZE);
          }),
        ),
      ),
      selectAll<{ id: string; member_id: string }>((after) => {
        let query = supabase.from("checkins").select("id, member_id").eq("week_start", week);
        if (after) query = query.gt("id", after);
        return query.order("id").limit(PAGE_SIZE);
      }),
    ]);
    const failed = people.find((r) => r.error)?.error ?? checkins.error;
    if (failed) throw failed;
    const members = people.flatMap((r) => r.data ?? []);
    return checkedInCounts(nodes, teams, members, new Set((checkins.data ?? []).map((c) => c.member_id)));
  } catch (error) {
    logError("portal who's checked in", error);
    return "failed";
  }
}
