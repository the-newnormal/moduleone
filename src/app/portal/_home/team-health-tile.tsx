import { ArrowRight, Clock } from "lucide-react";
import Link from "next/link";
import { Stat } from "@/components/normal/stat";
import { Tag } from "@/components/normal/tag";
import { Button } from "@/components/ui/button";
import type { HeatmapCell, OrgNode } from "@/lib/dashboard/org";
import { formatWeek } from "@/lib/dashboard/weeks";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import type { TeamHealthGlance } from "@/lib/portal/team-health";
import { BANDS, BandBadge, barClass, RedCount, thresholdItems } from "../dashboard/band";
import { cellWord, describeCell, plural, redCount } from "../dashboard/describe";
import { HeatmapTooltip } from "../dashboard/heatmap-tooltip";
import { Bars, drillIn } from "../dashboard/org-chart";
import { Tile } from "./tile";

type Ok = Extract<TeamHealthGlance, { status: "ok" }>;


// Leaders' and hq's numbers for the week: check-ins so far, last week's, and how many are still
// waiting for the grader. Counts only, from the teams the viewer covers.
export function TeamHealthStats({ health }: { health: Ok }) {
  const { tally, weeks } = health;
  return (
    <dl aria-label="This week in numbers" className="grid grid-cols-3 gap-2 sm:gap-4">
      <Stat
        label="Check-ins this week"
        value={tally.thisWeek.checkins}
        hint={`So far, week of ${formatWeek(weeks[weeks.length - 1])}`}
      />
      <Stat
        label="Check-ins last week"
        value={tally.lastWeek.checkins}
        hint={`Week of ${formatWeek(weeks[weeks.length - 2])}`}
      />
      <Stat label="Waiting for the grader" value={tally.thisWeek.pending} hint="This week's, not yet scored" />
    </dl>
  );
}

export const OpenTeamHealth = () => (
  <Button asChild variant="outline" className="h-10 w-fit px-5 text-[15px] has-[>svg]:px-5">
    <Link href="/portal/dashboard">
      Open Team health
      <ArrowRight aria-hidden strokeWidth={1.5} />
    </Link>
  </Button>
);

// This week so far for the topmost boxes the viewer covers, with a bar for each of the last few
// weeks, coloured by the scoring settings exactly as on the org chart (the status colours appear
// only in the team-health tiles on the portal). Each box opens that team's week.
export function TeamHealthTile({ health }: { health: Exclude<TeamHealthGlance, { status: "hidden" }> }) {
  if (health.status === "failed") {
    return (
      <Tile id="team-health" title="Team health">
        <p role="alert" className="text-[15px] leading-[22px]">
          Couldn&apos;t load team health just now.
        </p>
        <OpenTeamHealth />
      </Tile>
    );
  }

  const { glance, config, weeks, role } = health;
  const thisWeek = weeks[weeks.length - 1];
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
        <HeatmapTooltip>
          <div className="grid gap-1">
            <div
              aria-hidden
              className="hidden grid-cols-[minmax(0,1fr)_5.5rem_12.5rem] gap-4 border-b px-2 pb-2 text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground sm:grid"
            >
              <span>Team</span>
              <span>Last {weeks.length} weeks</span>
              <span>This week so far · {formatWeek(thisWeek)}</span>
            </div>
            <ul className="grid">
              {glance.summary && <GlanceRow node={glance.summary} config={config} lead />}
              {glance.rows.map((node) => (
                <GlanceRow key={node.teamId} node={node} config={config} indent={!!glance.summary} />
              ))}
            </ul>
            {glance.other.length > 0 && (
              <>
                <p className="px-2 pt-3 text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">Other</p>
                <ul className="grid">
                  {glance.other.map((node) => (
                    <GlanceRow key={node.teamId} node={node} config={config} />
                  ))}
                </ul>
              </>
            )}
          </div>
        </HeatmapTooltip>
      )}
      <GlanceKey thresholds={config.thresholds} weeks={weeks.length} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <OpenTeamHealth />
        {glance.more > 0 && (
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            {plural(glance.more, "more team")} there
          </span>
        )}
      </div>
    </Tile>
  );
}

// A box: its name, a bar for each week (oldest first), and this week so far. The bars are for the
// eye and the pointer; this week's link reads the earlier weeks out and is the way in from the
// keyboard, as on the org chart.
function GlanceRow({
  node,
  config,
  lead = false,
  indent = false,
}: {
  node: OrgNode;
  config: HealthConfig;
  lead?: boolean;
  indent?: boolean;
}) {
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_5.5rem_12.5rem] ${
        indent ? "pr-2 pl-5" : "px-2"
      }`}
    >
      <span className={`col-span-2 truncate text-[15px] leading-[22px] sm:col-span-1 ${lead ? "font-medium" : ""}`}>
        {node.name}
        {node.archived && <span className="text-muted-foreground"> (archived)</span>}
      </span>
      <Bars row={node} config={config} links={false} />
      <ThisWeek node={node} config={config} />
    </li>
  );
}

function ThisWeek({ node, config }: { node: OrgNode; config: HealthConfig }) {
  const cell: HeatmapCell = node.cells[node.cells.length - 1];
  const { title, lines } = describeCell(node.name, cell, config);
  const earlier = node.cells.slice(0, -1).map(cellWord);
  // What the link shows, first, so it can be named by voice; then the rest of the week.
  const shown = cell.health
    ? `${BANDS[cell.health.band].label} ${formatScore(cell.health.score, config)}`
    : cell.pending > 0
      ? "waiting"
      : "no check-ins";
  return (
    <Link
      href={drillIn(node.teamId, cell.week)}
      prefetch={false}
      aria-label={`${shown}, ${title}${node.archived ? " (archived)" : ""}. ${lines.join(". ")}.${
        earlier.length > 0 ? ` The ${plural(earlier.length, "week")} before, oldest first: ${earlier.join(", ")}.` : ""
      }`}
      data-tip-title={title}
      data-tip-body={lines.join("\n")}
      className="flex min-h-10 items-center justify-end gap-1.5 rounded-md px-1 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:justify-start"
    >
      {cell.health ? (
        <>
          <BandBadge band={cell.health.band} score={formatScore(cell.health.score, config)} />
          {redCount(cell) > 0 && <RedCount count={redCount(cell)} />}
          {cell.pending > 0 && <Clock aria-hidden className="size-3 text-muted-foreground" />}
        </>
      ) : cell.pending > 0 ? (
        <>
          <Clock aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">waiting</span>
        </>
      ) : (
        <span className="text-muted-foreground">no check-ins</span>
      )}
    </Link>
  );
}

// A sample bar for the key: just enough of a cell for barClass.
const sample = (band: "green" | "yellow" | "red" | null, pending = 0) => ({
  health: band && { band, score: 0, graded: 1, bands: { green: 0, yellow: 0, red: 0 } },
  pending,
});

// What the colours, marks and bars mean under the current thresholds.
function GlanceKey({ thresholds, weeks }: { thresholds: HealthConfig["thresholds"]; weeks: number }) {
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
        <RedCount count={2} />
        how many of the box&apos;s check-ins were red, whatever its colour
      </li>
      <li className="flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="flex h-5 items-end gap-0.5">
          {[sample("green"), sample("yellow"), sample("red"), sample(null, 1), sample(null)].map((cell, i) => (
            <span key={i} className={`w-2 rounded-t-[2px] ${barClass(cell)}`} />
          ))}
        </span>
        the last {weeks} weeks, oldest first: the taller, the better; dashed, waiting; flat, no check-ins
      </li>
    </ul>
  );
}
