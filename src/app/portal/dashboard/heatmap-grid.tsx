import { Clock, OctagonAlert } from "lucide-react";
import Link from "next/link";
import type { HeatmapGroup, HeatmapRow } from "@/lib/dashboard/heatmap";
import type { HeatmapCell } from "@/lib/dashboard/org";
import { formatWeek } from "@/lib/dashboard/weeks";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import { BANDS } from "./band";
import { describeCell, hidesRed } from "./describe";
import { HeatmapTooltip } from "./heatmap-tooltip";

// With a single week there's room to spell the cell out instead of leaving it to the tooltip.
function Cell({
  row,
  cell,
  weeksParam,
  config,
  detailed,
}: {
  row: HeatmapRow;
  cell: HeatmapCell;
  weeksParam: number;
  config: HealthConfig;
  detailed: boolean;
}) {
  const size = detailed ? "min-h-11 justify-start px-3 py-2 text-left" : "h-11 justify-center";

  if (!cell.health && cell.pending === 0) {
    return (
      <td className="p-0.5">
        <span
          className={`flex items-center rounded-md ${detailed ? "text-muted-foreground" : "text-muted-foreground/60"} ${size}`}
        >
          {detailed ? (
            "No check-ins yet"
          ) : (
            <>
              <span aria-hidden>–</span>
              <span className="sr-only">No check-ins</span>
            </>
          )}
        </span>
      </td>
    );
  }

  const { title, lines } = describeCell(row.name, cell, config);
  // Everything after the band line: the colour counts and anything still waiting.
  const detail = cell.health ? lines.slice(1).join(" · ") : lines[lines.length - 1];
  const band = cell.health ? BANDS[cell.health.band] : null;

  return (
    <td className="p-0.5">
      <Link
        href={`/portal/dashboard/${row.teamId ?? "none"}/${cell.week}?weeks=${weeksParam}`}
        aria-label={`${title}. ${lines.join(". ")}.`}
        data-tip-title={title}
        data-tip-body={lines.join("\n")}
        className={`relative flex items-center gap-1.5 rounded-md text-sm font-medium tabular-nums outline-offset-2 transition hover:ring-2 hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-ring ${size} ${band ? band.tint : "bg-muted"}`}
      >
        {band ? (
          <>
            <band.Icon aria-hidden className={`size-4 shrink-0 ${band.icon}`} strokeWidth={2.25} />
            {formatScore(cell.health!.score, config)}
          </>
        ) : (
          <>
            <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {!detailed && cell.pending}
          </>
        )}
        {detailed && <span className="pr-3 font-normal text-muted-foreground">{detail}</span>}
        {/* A green or yellow mean can hide a red check-in; flag it in the corner. */}
        {hidesRed(cell) && (
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
  config,
}: {
  groups: HeatmapGroup[];
  weeks: readonly string[];
  thisWeek: string;
  weeksParam: number;
  caption: string;
  config: HealthConfig;
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
                <th
                  key={week}
                  scope="col"
                  className={`min-w-[5.5rem] py-2 font-medium ${weeks.length === 1 ? "px-3.5 text-left" : "px-1 text-center"}`}
                >
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
            <tbody key={group.key ?? "other"}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={weeks.length + 1}
                  className="border-t bg-card px-3 pt-3 pb-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  {/* A cell spanning every column can't stick; its label can, so it stays in view on phones. */}
                  <span className="sticky left-3 inline-block">{group.label ?? "Other"}</span>
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.key}>
                  <th
                    scope="row"
                    className={`sticky left-0 z-10 max-w-48 truncate bg-card py-0.5 pr-3 text-left ${row.scored ? "font-medium" : "font-normal text-muted-foreground"} ${row.depth > 0 ? "pl-7" : "pl-3"}`}
                  >
                    {row.name}
                    {row.archived && <span className="ml-1.5 text-xs font-normal text-muted-foreground">archived</span>}
                  </th>
                  {row.scored ? (
                    row.cells.map((cell) => (
                      <Cell
                        key={cell.week}
                        row={row}
                        cell={cell}
                        weeksParam={weeksParam}
                        config={config}
                        detailed={weeks.length === 1}
                      />
                    ))
                  ) : (
                    // A domain the viewer doesn't lead, above the teams they do: no colours of its own
                    // (the legend says so).
                    <td colSpan={weeks.length}>
                      <span className="sr-only">No colour: you lead only some of the teams under it</span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </HeatmapTooltip>
  );
}
