import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { heatmapGroups } from "@/lib/dashboard/heatmap";
import { loadHeatmapData } from "@/lib/dashboard/load";
import { buildOrg, coverage } from "@/lib/dashboard/org";
import { teamCounts } from "@/lib/dashboard/summary";
import { parseWeekCount, recentWeeks, WEEK_COUNTS, weekStartFor } from "@/lib/dashboard/weeks";
import { createClient } from "@/lib/supabase/server";
import { DashboardFrame, Legend } from "../frame";
import { HeatmapGrid } from "../heatmap-grid";
import { signInAgain } from "../sign-in";
import { BandSummary } from "../summary";

export const metadata: Metadata = { title: "Team health trend · Module One" };

const CAPTION = {
  hq: "Health of every team by week",
  leader: "Health of the teams you lead, by week",
};

// Teams × weeks: the last 1, 4, 8 or 12 weeks (?weeks=), every team on its own row.
export default async function TrendPage({ searchParams }: PageProps<"/portal/dashboard/trend">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const params = await searchParams;
  if (!data?.claims) redirect(signInAgain("/portal/dashboard/trend", params));

  const weekCount = parseWeekCount(params.weeks);
  const now = new Date();
  const weeks = recentWeeks(now, weekCount);
  const { teams, checkins, config, role, ledTeams } = await loadHeatmapData(supabase, weeks);
  // Members never see their grade (see ../page.tsx).
  if (role === "member") redirect("/portal/checkin");
  const org = buildOrg({ teams, checkins, weeks, config, covers: coverage(role, ledTeams) });
  const groups = heatmapGroups(org);
  const thisWeek = weekStartFor(now);

  return (
    <DashboardFrame
      view="trend"
      role={role}
      // The tally is of the latest week shown: this one.
      aside={role && <BandSummary counts={teamCounts(org)} week={thisWeek} thisWeek={thisWeek} role={role} />}
    >
      <nav aria-label="Weeks shown" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Show the last</span>
        {WEEK_COUNTS.map((count) => {
          const selected = count === weekCount;
          return (
            <Link
              key={count}
              href={`/portal/dashboard/trend?weeks=${count}`}
              aria-current={selected ? "page" : undefined}
              className={`inline-flex h-10 items-center gap-1 rounded-full px-4 text-[15px] font-medium ${
                selected ? "bg-primary text-primary-foreground" : "border border-input hover:bg-accent"
              }`}
            >
              {selected && <Check aria-hidden className="size-4" strokeWidth={1.5} />}
              {count} {count === 1 ? "week" : "weeks"}
            </Link>
          );
        })}
      </nav>

      <Legend config={config} view="trend" role={role} redCounts={weekCount > 1} />

      {groups.length === 0 || !role ? (
        <p className="rounded-xl bg-card p-6 text-muted-foreground">
          No teams or check-ins to show for {weekCount === 1 ? "this week" : "these weeks"} yet.
        </p>
      ) : (
        <HeatmapGrid
          key={weekCount} // remount, so a new range opens on the latest week again
          groups={groups}
          weeks={weeks}
          thisWeek={thisWeek}
          weeksParam={weekCount}
          caption={CAPTION[role]}
          config={config}
        />
      )}
    </DashboardFrame>
  );
}
