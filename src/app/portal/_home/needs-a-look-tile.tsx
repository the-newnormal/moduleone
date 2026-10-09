import { OctagonAlert } from "lucide-react";
import Link from "next/link";
import type { RedSpot } from "@/lib/dashboard/needs-a-look";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import { BandBadge } from "../dashboard/band";
import { describeCell, plural } from "../dashboard/describe";
import { drillIn } from "../dashboard/org-chart";
import { Tile } from "./tile";

const SHOWN = 5;

// For division leaders and hq (src/lib/dashboard/needs-a-look.ts decides who): the teams that are
// red this week, or where someone was red, each named once at the smallest box. On a quiet week so
// far it shows last week's instead, so Monday isn't empty.
export function NeedsALookTile({
  spots,
  config,
}: {
  spots: { thisWeek: RedSpot[]; lastWeek: RedSpot[] };
  config: HealthConfig;
}) {
  const showing = spots.thisWeek.length > 0 ? spots.thisWeek : spots.lastWeek;
  const more = showing.length - SHOWN;
  return (
    <Tile id="needs-a-look" title="Needs a look">
      {spots.thisWeek.length === 0 && (
        <p className="text-[15px] leading-[22px] text-muted-foreground">
          Nothing red so far this week.{spots.lastWeek.length > 0 && " Last week:"}
        </p>
      )}
      {showing.length > 0 && (
        <ul className="grid">
          {showing.slice(0, SHOWN).map((spot) => (
            <Spot key={spot.teamId} spot={spot} config={config} />
          ))}
        </ul>
      )}
      {more > 0 && (
        <Link href="/portal/dashboard" className="w-fit text-sm font-medium underline underline-offset-4">
          {plural(more, "more")} on Team health
        </Link>
      )}
    </Tile>
  );
}

function Spot({ spot, config }: { spot: RedSpot; config: HealthConfig }) {
  const { cell } = spot;
  const health = cell.health;
  if (!health) return null;
  const { title, lines } = describeCell(spot.name, cell, config);
  return (
    <li className="border-b last:border-b-0">
      <Link
        href={drillIn(spot.teamId, cell.week)}
        prefetch={false}
        aria-label={`${title}. ${lines.join(". ")}`}
        className="flex min-h-12 items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden className="grid min-w-0 gap-0.5">
          {spot.context.length > 0 && (
            <span className="truncate text-[13px] leading-[18px] text-muted-foreground">{spot.context.join(" › ")}</span>
          )}
          <span className="truncate text-[15px] leading-[22px] font-medium">{spot.name}</span>
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            {health.bands.red} of {plural(health.graded, "graded check-in")} red
          </span>
        </span>
        <span aria-hidden className="flex shrink-0 items-center gap-1.5">
          <BandBadge band={health.band} score={formatScore(health.score, config)} />
          {!spot.red && <OctagonAlert className="size-3 text-status-critical" strokeWidth={2.5} />}
        </span>
      </Link>
    </li>
  );
}
