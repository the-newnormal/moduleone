import { ArrowRight, Clock, OctagonAlert } from "lucide-react";
import Link from "next/link";
import { Stat } from "@/components/normal/stat";
import { Tag } from "@/components/normal/tag";
import { Button } from "@/components/ui/button";
import type { HeatmapCell, OrgNode } from "@/lib/dashboard/org";
import { formatWeek } from "@/lib/dashboard/weeks";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import type { TeamHealthGlance } from "@/lib/portal/team-health";
import { BANDS, BandBadge, thresholdItems } from "../dashboard/band";
import { describeCell, hidesRed, plural } from "../dashboard/describe";
import { drillIn } from "../dashboard/org-chart";
import { Tile } from "./tile";

type Ok = Extract<TeamHealthGlance, { status: "ok" }>;

// Leaders' and hq's numbers for the week: check-ins so far, last week's, and how many are still
// waiting for the grader. Counts only, from the teams the viewer covers.
export function TeamHealthStats({ health }: { health: Ok }) {
  const [lastWeek, thisWeek] = health.weeks;
  const { tally } = health;
  return (
    <dl aria-label="This week in numbers" className="grid grid-cols-3 gap-2 sm:gap-4">
      <Stat label="Check-ins this week" value={tally.thisWeek.checkins} hint={`So far, week of ${formatWeek(thisWeek)}`} />
      <Stat label="Check-ins last week" value={tally.lastWeek.checkins} hint={`Week of ${formatWeek(lastWeek)}`} />
      <Stat label="Waiting for the grader" value={tally.thisWeek.pending} hint="This week's, not yet scored" />
    </dl>
  );
}

// Last week beside this week so far, for the topmost boxes the viewer covers, coloured by the
// scoring settings exactly as on the org chart (the status colours appear only here on the
// portal). Each cell opens that team's week.
export function TeamHealthTile({ health }: { health: Exclude<TeamHealthGlance, { status: "hidden" }> }) {
  const open = (
    <Button asChild variant="outline" className="h-10 w-fit px-5 text-[15px]">
      <Link href="/portal/dashboard">
        Open Team health
        <ArrowRight aria-hidden />
      </Link>
    </Button>
  );

  if (health.status === "failed") {
    return (
      <Tile id="team-health" title="Team health">
        <p role="alert" className="text-[15px] leading-[22px]">
          Couldn&apos;t load team health just now.
        </p>
        {open}
      </Tile>
    );
  }

  const { glance, config, weeks, role } = health;
  const [lastWeek, thisWeek] = weeks;
  const empty = !glance.summary && glance.rows.length === 0 && glance.other.length === 0;

  return (
    <Tile
      id="team-health"
      title="Team health"
      aside={<Tag tone="outline">{role === "hq" ? "Every team" : "The teams you lead"}</Tag>}
    >
      {empty ? (
        <p className="text-[15px] leading-[22px] text-muted-foreground">No teams or check-ins to show yet.</p>
      ) : (
        <div className="grid gap-1">
          <div
            aria-hidden
            className="hidden grid-cols-[minmax(0,1fr)_10rem_10rem] gap-3 border-b px-2 pb-2 text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground sm:grid"
          >
            <span>Team</span>
            <span>Last week · {formatWeek(lastWeek)}</span>
            <span>This week so far · {formatWeek(thisWeek)}</span>
          </div>
          <ul className="grid">
            {glance.summary && <GlanceRow node={glance.summary} config={config} weeks={weeks} lead />}
            {glance.rows.map((node) => (
              <GlanceRow key={node.teamId} node={node} config={config} weeks={weeks} indent={!!glance.summary} />
            ))}
          </ul>
          {glance.other.length > 0 && (
            <>
              <p className="px-2 pt-3 text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">Other</p>
              <ul className="grid">
                {glance.other.map((node) => (
                  <GlanceRow key={node.teamId} node={node} config={config} weeks={weeks} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <GlanceKey thresholds={config.thresholds} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {open}
        {glance.more > 0 && <span className="text-[13px] leading-[18px] text-muted-foreground">{plural(glance.more, "more team")} there</span>}
      </div>
    </Tile>
  );
}

function GlanceRow({
  node,
  config,
  weeks,
  lead = false,
  indent = false,
}: {
  node: OrgNode;
  config: HealthConfig;
  weeks: [string, string];
  lead?: boolean;
  indent?: boolean;
}) {
  const cellFor = (week: string): HeatmapCell => node.cells.find((c) => c.week === week) ?? { week, health: null, pending: 0 };
  return (
    <li
      className={`grid grid-cols-2 items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_10rem_10rem] ${
        indent ? "pr-2 pl-5" : "px-2"
      }`}
    >
      <span className={`col-span-2 truncate text-[15px] leading-[22px] sm:col-span-1 ${lead ? "font-medium" : ""}`}>
        {node.name}
        {node.archived && <span className="text-muted-foreground"> (archived)</span>}
      </span>
      <GlanceCell name={node.name} teamId={node.teamId} cell={cellFor(weeks[0])} config={config} label="Last week" />
      <GlanceCell name={node.name} teamId={node.teamId} cell={cellFor(weeks[1])} config={config} label="This week so far" />
    </li>
  );
}

function GlanceCell({
  name,
  teamId,
  cell,
  config,
  label,
}: {
  name: string;
  teamId: string;
  cell: HeatmapCell;
  config: HealthConfig;
  label: string;
}) {
  const { title, lines } = describeCell(name, cell, config);
  return (
    <Link
      href={drillIn(teamId, cell.week)}
      prefetch={false}
      aria-label={`${title}. ${lines.join(". ")}`}
      className="flex min-h-10 flex-col justify-center gap-0.5 rounded-md px-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-start sm:gap-1.5"
    >
      <span aria-hidden className="text-xs leading-4 text-muted-foreground sm:hidden">
        {label}
      </span>
      <span aria-hidden className="flex flex-wrap items-center gap-1.5 text-sm sm:flex-nowrap">
        {cell.health ? (
          <>
            <BandBadge band={cell.health.band} score={formatScore(cell.health.score, config)} />
            {hidesRed(cell) && <OctagonAlert className="size-3 text-status-critical" strokeWidth={2.5} />}
            {cell.pending > 0 && <Clock className="size-3 text-muted-foreground" />}
          </>
        ) : cell.pending > 0 ? (
          <>
            <Clock className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">waiting</span>
          </>
        ) : (
          <span className="text-muted-foreground">– no check-ins</span>
        )}
      </span>
    </Link>
  );
}

// What the colours and marks mean under the current thresholds.
function GlanceKey({ thresholds }: { thresholds: HealthConfig["thresholds"] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] leading-[18px]">
      {thresholdItems(thresholds).map(({ band, text }) => {
        const { label, Icon, icon } = BANDS[band];
        return (
          <li key={band} className="flex items-center gap-1.5">
            <Icon aria-hidden className={`size-4 ${icon}`} strokeWidth={2.25} />
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground">{text}</span>
          </li>
        );
      })}
      <li className="flex items-center gap-1.5 text-muted-foreground">
        <Clock aria-hidden className="size-4" />
        waiting for the grader
      </li>
      <li className="flex items-center gap-1.5 text-muted-foreground">
        <OctagonAlert aria-hidden className="size-3 text-status-critical" strokeWidth={2.5} />
        someone was red
      </li>
    </ul>
  );
}
