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
    <section aria-labelledby="band-summary" className="grid gap-2 rounded-xl border bg-card px-4 py-3 text-sm">
      <h2 id="band-summary" className="font-sans text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {`${role === "hq" ? "Teams" : "Teams you lead"}, ${when}`}
      </h2>
      <ul className="flex flex-wrap gap-x-5 gap-y-1">
        {ORDER.map((band) => {
          const { label, Icon, icon } = BANDS[band];
          return (
            <li key={band} className="flex items-center gap-1.5">
              <Icon aria-hidden className={`size-5 shrink-0 ${icon}`} strokeWidth={2.25} />
              <span className="text-2xl leading-none font-semibold tabular-nums">{counts[band]}</span>
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
