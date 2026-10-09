import type { Role } from "@/lib/dashboard/load";
import type { BandCounts } from "@/lib/dashboard/summary";
import { formatWeek } from "@/lib/dashboard/weeks";
import { BANDS } from "./band";

const ORDER = ["green", "yellow", "red"] as const;

// The header's tally: how many teams are each colour in one week (src/lib/dashboard/summary.ts), so
// the whole chart reads at a glance.
export function BandSummary({
  counts,
  week,
  thisWeek,
  role,
}: {
  counts: BandCounts;
  week: string;
  thisWeek: string;
  role: Exclude<Role, "member">;
}) {
  if (counts.green + counts.yellow + counts.red + counts.ungraded === 0) return null;
  const when = week === thisWeek ? "this week" : `week of ${formatWeek(week)}`;
  return (
    <section aria-labelledby="band-summary" className="grid gap-2 rounded-xl bg-card px-5 py-4 text-sm">
      {/* Names the region without adding a heading the view switch and the chart would fall under. */}
      <p id="band-summary" className="text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">
        {`${role === "hq" ? "Teams" : "Teams you lead"}, ${when}`}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {ORDER.map((band) => {
          const { label, Icon, icon } = BANDS[band];
          return (
            <li key={band} className="flex items-center gap-1.5">
              <Icon aria-hidden className={`size-5 shrink-0 ${icon}`} strokeWidth={2.25} />
              <span className="font-mono text-2xl leading-none tracking-[-0.02em] tabular-nums">{counts[band]}</span>
              <span className="text-muted-foreground">{label.toLowerCase()}</span>
            </li>
          );
        })}
      </ul>
      {counts.ungraded > 0 && (
        <p className="text-xs text-muted-foreground">{counts.ungraded} more with nothing graded</p>
      )}
    </section>
  );
}
