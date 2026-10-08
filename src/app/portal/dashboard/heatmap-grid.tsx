import { Clock, OctagonAlert } from "lucide-react";
import Link from "next/link";
import type { HeatmapCell, HeatmapGroup, HeatmapRow } from "@/lib/dashboard/heatmap";
import { formatWeek } from "@/lib/dashboard/weeks";
import { BANDS } from "./band";
import { HeatmapTooltip } from "./heatmap-tooltip";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The tooltip and the cell's accessible name say the same thing.
function describe(row: HeatmapRow, cell: HeatmapCell) {
  const title = `${row.name} · week of ${formatWeek(cell.week, true)}`;
  const lines: string[] = [];
  if (cell.health) {
    const { band, score, graded, bands } = cell.health;
    lines.push(`${BANDS[band].label} · mean score ${score}`);
    lines.push(
      `${plural(graded, "graded check-in")}: ${bands.green} green, ${bands.yellow} yellow, ${bands.red} red`,
    );
  } else {
    lines.push("Nothing graded yet");
  }
  if (cell.pending > 0) lines.push(`${cell.pending} waiting for the grader`);
  return { title, lines };
}

function Cell({ row, cell, weeksParam }: { row: HeatmapRow; cell: HeatmapCell; weeksParam: number }) {
  if (!cell.health && cell.pending === 0) {
    return (
      <td className="p-0.5">
        <span className="flex h-11 items-center justify-center rounded-md text-muted-foreground/60">
          <span aria-hidden>–</span>
          <span className="sr-only">No check-ins</span>
        </span>
      </td>
    );
  }

  const { title, lines } = describe(row, cell);
  const band = cell.health ? BANDS[cell.health.band] : null;
  // A green or yellow mean can hide a red check-in; flag it in the corner.
  const hiddenRed = cell.health && cell.health.band !== "red" && cell.health.bands.red > 0;

  return (
    <td className="p-0.5">
      <Link
        href={`/portal/dashboard/${row.teamId ?? "none"}/${cell.week}?weeks=${weeksParam}`}
        aria-label={`${title}. ${lines.join(". ")}.`}
        data-tip-title={title}
        data-tip-body={lines.join("\n")}
        className={`relative flex h-11 items-center justify-center gap-1.5 rounded-md text-sm font-medium tabular-nums outline-offset-2 transition hover:ring-2 hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-ring ${band ? band.tint : "bg-muted"}`}
      >
        {band ? (
          <>
            <band.Icon aria-hidden className={`size-4 shrink-0 ${band.icon}`} strokeWidth={2.25} />
            {cell.health!.score.toFixed(1)}
          </>
        ) : (
          <>
            <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {cell.pending}
          </>
        )}
        {hiddenRed && (
          <OctagonAlert
            aria-hidden
            className="absolute top-1 right-1 size-3 text-status-critical"
            strokeWidth={2.5}
          />
        )}
        {band && cell.pending > 0 && (
          <Clock aria-hidden className="absolute right-1 bottom-1 size-3 text-muted-foreground" strokeWidth={2.5} />
        )}
      </Link>
    </td>
  );
}

export function HeatmapGrid({
  groups,
  weeks,
  thisWeek,
  weeksParam,
  caption,
}: {
  groups: HeatmapGroup[];
  weeks: readonly string[];
  thisWeek: string;
  weeksParam: number;
  caption: string;
}) {
  return (
    <HeatmapTooltip>
      <div data-scroll-to-end className="relative overflow-x-auto rounded-xl border bg-card">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">
                Team
              </th>
              {weeks.map((week) => (
                <th key={week} scope="col" className="min-w-[5.5rem] px-1 py-2 text-center font-medium">
                  <span className={week === thisWeek ? "text-foreground" : "text-muted-foreground"}>
                    {formatWeek(week)}
                  </span>
                  {week === thisWeek && (
                    <span className="block text-xs font-normal text-muted-foreground">This week</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.division ?? "none"}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={weeks.length + 1}
                  className="sticky left-0 border-t bg-card px-3 pt-3 pb-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  {group.division ?? "Other"}
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.teamId ?? "none"}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 max-w-48 truncate bg-card px-3 py-0.5 text-left font-medium"
                  >
                    {row.name}
                    {row.archived && <span className="ml-1.5 text-xs font-normal text-muted-foreground">archived</span>}
                  </th>
                  {row.cells.map((cell) => (
                    <Cell key={cell.week} row={row} cell={cell} weeksParam={weeksParam} />
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </HeatmapTooltip>
  );
}
