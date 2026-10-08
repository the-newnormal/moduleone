import { Check, Clock, OctagonAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buildHeatmap } from "@/lib/dashboard/heatmap";
import { loadHeatmapData, type Role } from "@/lib/dashboard/load";
import { parseWeekCount, recentWeeks, WEEK_COUNTS, weekStartFor } from "@/lib/dashboard/weeks";
import type { HealthConfig } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import { BANDS } from "./band";
import { HeatmapGrid } from "./heatmap-grid";

export const metadata: Metadata = { title: "Team health · Module One" };

const SCOPE: Record<Role, { caption: string; blurb: string }> = {
  hq: {
    caption: "Health of every team by week",
    blurb: "Every team, week by week. Open a cell to read that week's check-ins.",
  },
  leader: {
    caption: "Your team's health by week",
    blurb: "Check-ins made in your team, week by week. Open a cell to read them.",
  },
  member: {
    caption: "Your check-ins by week",
    blurb: "Your own check-ins, week by week. Your team leader sees the whole team.",
  },
};

function Legend({ config, forTeams }: { config: HealthConfig; forTeams: boolean }) {
  const { green, yellow } = config.thresholds;
  const items = [
    { band: BANDS.green, text: `${green} or more` },
    { band: BANDS.yellow, text: `${yellow} to under ${green}` },
    { band: BANDS.red, text: `under ${yellow}` },
  ];
  return (
    <div className="grid gap-2 text-sm">
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
        {items.map(({ band, text }) => (
          <li key={band.label} className="flex items-center gap-1.5">
            <band.Icon aria-hidden className={`size-4 ${band.icon}`} strokeWidth={2.25} />
            <span className="font-medium">{band.label}</span>
            <span className="text-muted-foreground">{text}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <Clock aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">waiting for the grader</span>
        </li>
        {forTeams && (
          <li className="flex items-center gap-1.5">
            <OctagonAlert aria-hidden className="size-3 text-status-critical" strokeWidth={2.5} />
            <span className="text-muted-foreground">someone in the team was red</span>
          </li>
        )}
      </ul>
      <p className="text-muted-foreground">
        A check-in&apos;s score is activity × excellence × a morale weight. Each cell shows the mean of
        that week&apos;s graded check-ins. Admins set the weights and thresholds.
      </p>
    </div>
  );
}

export default async function DashboardPage({ searchParams }: PageProps<"/portal/dashboard">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?next=/portal/dashboard");

  const weekCount = parseWeekCount((await searchParams).weeks);
  const now = new Date();
  const weeks = recentWeeks(now, weekCount);
  const { teams, checkins, config, role } = await loadHeatmapData(supabase, weeks);
  const heatmap = buildHeatmap({ teams, checkins, weeks, config });
  // A member only ever sees their own check-ins, so their row is theirs, not the team's.
  const groups =
    role === "member"
      ? heatmap.map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r, name: `You · ${r.name}` })) }))
      : heatmap;

  return (
    <main className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-10">
      <header className="grid gap-2">
        <Link href="/portal" className="w-fit text-sm text-muted-foreground hover:text-foreground">
          ← Portal
        </Link>
        <h1 className="text-4xl">Team health</h1>
        {role && <p className="text-muted-foreground">{SCOPE[role].blurb}</p>}
      </header>

      {!role ? (
        <p className="rounded-xl border bg-card p-6">
          Your sign-in isn&apos;t linked to a team member yet, so there&apos;s nothing to show. Ask an
          admin to add you.
        </p>
      ) : (
        <>
          <nav aria-label="Weeks shown" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Show the last</span>
            {WEEK_COUNTS.map((count) => {
              const selected = count === weekCount;
              return (
                <Link
                  key={count}
                  href={`/portal/dashboard?weeks=${count}`}
                  aria-current={selected ? "page" : undefined}
                  className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 ${
                    selected ? "border-foreground/30 bg-card font-semibold" : "hover:bg-card"
                  }`}
                >
                  {selected && <Check aria-hidden className="size-4" strokeWidth={2.75} />}
                  {count} weeks
                </Link>
              );
            })}
          </nav>

          <Legend config={config} forTeams={role !== "member"} />

          {groups.length === 0 ? (
            <p className="rounded-xl border bg-card p-6 text-muted-foreground">
              No teams or check-ins to show for these weeks yet.
            </p>
          ) : (
            <HeatmapGrid
              groups={groups}
              weeks={weeks}
              thisWeek={weekStartFor(now)}
              weeksParam={weekCount}
              caption={SCOPE[role].caption}
            />
          )}
        </>
      )}
    </main>
  );
}
