import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { loadHeatmapData } from "@/lib/dashboard/load";
import { buildOrg, coverage } from "@/lib/dashboard/org";
import {
  formatWeek,
  isWeekStart,
  ORG_WEEKS,
  parseWeek,
  parseWeekCount,
  shiftWeek,
  weekStartFor,
  weeksEndingAt,
} from "@/lib/dashboard/weeks";
import { createClient } from "@/lib/supabase/server";
import { DashboardFrame, Legend } from "./frame";
import { OrgChart } from "./org-chart";

export const metadata: Metadata = { title: "Team health · Module One" };

const weekHref = (week: string, thisWeek: string) =>
  week === thisWeek ? "/portal/dashboard" : `/portal/dashboard?week=${week}`;

const STEP = "inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5";

// A week the chart can show: its bars reach back ORG_WEEKS - 1 weeks, and every one must be a week
// the drill-in accepts.
const showable = (week: string) => isWeekStart(shiftWeek(week, 1 - ORG_WEEKS));

// The org chart, coloured by one week (?week=, this week by default).
export default async function OrgChartPage({ searchParams }: PageProps<"/portal/dashboard">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?next=/portal/dashboard");

  const params = await searchParams;
  // The teams × weeks grid was here, at ?weeks=, before it moved to the Trend tab.
  if (params.weeks !== undefined && params.week === undefined) {
    redirect(`/portal/dashboard/trend?weeks=${parseWeekCount(params.weeks)}`);
  }

  const thisWeek = weekStartFor(new Date());
  const picked = parseWeek(params.week, thisWeek);
  const week = showable(picked) ? picked : thisWeek;
  const weeks = weeksEndingAt(week, ORG_WEEKS);
  const { teams, checkins, config, role, ledTeams } = await loadHeatmapData(supabase, weeks);
  // Members never see their grade (the owner's rule, and the privacy notice says so): their only
  // box here would be their own scores. The heat-map is for leaders and hq.
  if (role === "member") redirect("/portal/checkin");
  const org = buildOrg({ teams, checkins, weeks, config, covers: coverage(role, ledTeams) });
  const previous = showable(shiftWeek(week, -1)) ? shiftWeek(week, -1) : null;
  const next = week < thisWeek ? shiftWeek(week, 1) : null;

  return (
    <DashboardFrame view="org" role={role}>
      <nav aria-label="Week" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <p className="mr-1 text-lg font-medium">
          Week of {formatWeek(week, true)}
          {week === thisWeek && <span className="ml-2 text-sm font-normal text-muted-foreground"> This week</span>}
        </p>
        {previous ? (
          <Link href={weekHref(previous, thisWeek)} className={`${STEP} hover:bg-card`}>
            <ChevronLeft aria-hidden className="size-4" />
            Previous week
          </Link>
        ) : (
          <span role="link" aria-disabled="true" className={`${STEP} text-muted-foreground/60`}>
            <ChevronLeft aria-hidden className="size-4" />
            Previous week
          </span>
        )}
        {next ? (
          <Link href={weekHref(next, thisWeek)} className={`${STEP} hover:bg-card`}>
            Next week
            <ChevronRight aria-hidden className="size-4" />
          </Link>
        ) : (
          <span role="link" aria-disabled="true" className={`${STEP} text-muted-foreground/60`}>
            Next week
            <ChevronRight aria-hidden className="size-4" />
          </span>
        )}
        {week !== thisWeek && (
          <Link href="/portal/dashboard" className="underline underline-offset-4 hover:text-foreground">
            Back to this week
          </Link>
        )}
      </nav>

      <Legend config={config} view="org" role={role} />

      {org.roots.length + org.loose.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-muted-foreground">No teams or check-ins to show yet.</p>
      ) : (
        <OrgChart key={week} org={org} config={config} />
      )}
    </DashboardFrame>
  );
}
