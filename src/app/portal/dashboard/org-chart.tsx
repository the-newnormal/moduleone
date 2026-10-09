import { Clock, OctagonAlert } from "lucide-react";
import Link from "next/link";
import { type HeatmapCell, type LooseRow, looseKey, type Org, type OrgNode } from "@/lib/dashboard/org";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import { BANDS, barClass } from "./band";
import { cellWord, describeCell, hidesRed } from "./describe";
import { HeatmapTooltip } from "./heatmap-tooltip";

// The org chart, one card per division (under the organisation's own box, once there is one), each
// box coloured by the last of its weeks (the week picked on the page) with a bar for each week up
// to it. A box covers its team and every team
// under it (src/lib/dashboard/org.ts); open it to read that week's check-ins.

const drillIn = (teamId: string | null, week: string) => `/portal/dashboard/${teamId ?? "none"}/${week}`;

function Bars({ row, config }: { row: Row; config: HealthConfig }) {
  const viewing = row.cells[row.cells.length - 1].week;
  return (
    // For the eye and the pointer: each bar opens its own week. The row's link reads the weeks out
    // and is the way in from the keyboard, so the bars stay out of the tab order.
    <span aria-hidden className="flex h-5 shrink-0 items-end gap-0.5">
      {row.cells.map((cell) => {
        const { title, lines } = describeCell(row.name, cell, config);
        return (
          <Link
            key={cell.week}
            // ?from= sends the drill-in's back link to the week being viewed, not the bar's.
            href={`${drillIn(row.teamId, cell.week)}${cell.week === viewing ? "" : `?from=${viewing}`}`}
            prefetch={false}
            tabIndex={-1}
            data-tip-title={title}
            data-tip-body={lines.join("\n")}
            className="flex h-full w-2 items-end sm:w-2.5"
          >
            <span className={`w-full rounded-t-[2px] ${barClass(cell)}`} />
          </Link>
        );
      })}
    </span>
  );
}

type Row = { teamId: string | null; name: string; archived: boolean; cells: HeatmapCell[] };

// A box: the team, its colour and score for the picked week, and its recent weeks.
function TeamRow({ row, config, heading }: { row: Row; config: HealthConfig; heading?: boolean }) {
  const cell = row.cells[row.cells.length - 1];
  const { title, lines } = describeCell(row.name, cell, config);
  const earlier = row.cells.slice(0, -1).map(cellWord).join(", ");
  const band = cell.health ? BANDS[cell.health.band] : null;
  const Name = heading ? "h2" : "span";

  return (
    <div
      className={`flex min-h-11 items-center gap-3 rounded-md px-2.5 py-1.5 text-sm transition hover:ring-2 hover:ring-foreground/25 ${
        band ? band.tint : cell.pending > 0 ? "bg-muted" : ""
      }`}
    >
      <Link
        href={drillIn(row.teamId, cell.week)}
        aria-label={`${title}${row.archived ? " (archived)" : ""}. ${lines.join(". ")}. The ${row.cells.length - 1} weeks before, oldest first: ${earlier}.`}
        data-tip-title={title}
        data-tip-body={lines.join("\n")}
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {band ? (
            <band.Icon aria-hidden className={`size-4 shrink-0 ${band.icon}`} strokeWidth={2.25} />
          ) : cell.pending > 0 ? (
            <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <span aria-hidden className="w-4 shrink-0 text-center text-muted-foreground">
              –
            </span>
          )}
          <Name
            className={`truncate ${heading ? "font-sans text-xs font-semibold tracking-wide uppercase" : "font-medium"}`}
          >
            {row.name}
          </Name>
          {row.archived && <span className="shrink-0 text-xs text-muted-foreground">archived</span>}
          {hidesRed(cell) && (
            <OctagonAlert aria-hidden className="size-3 shrink-0 text-status-critical" strokeWidth={2.5} />
          )}
          {band && cell.pending > 0 && (
            <Clock aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2.5} />
          )}
          {!cell.health && (
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {cell.pending > 0 ? "waiting for the grader" : "no check-ins"}
            </span>
          )}
        </div>
        <span className="w-10 shrink-0 text-right font-medium tabular-nums">
          {cell.health && formatScore(cell.health.score, config)}
        </span>
      </Link>
      <Bars row={row} config={config} />
    </div>
  );
}

// A domain or team, with the teams under it indented beneath. One the viewer doesn't cover is
// only a label above the teams they do.
function Branch({ node, config }: { node: OrgNode; config: HealthConfig }) {
  return (
    <li className="grid gap-1">
      {node.scored ? (
        <TeamRow row={node} config={config} />
      ) : (
        <span className="flex min-h-9 items-center px-2.5 text-sm text-muted-foreground">
          {node.name}
          {node.archived && <span className="ml-1.5 text-xs"> archived</span>}
        </span>
      )}
      {node.children.length > 0 && (
        <ul className="ml-4 grid gap-1 border-l pl-2">
          {node.children.map((child) => (
            <Branch key={child.teamId} node={child} config={config} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Card({
  label,
  head,
  branches,
  loose = [],
  config,
}: {
  label: string;
  head: OrgNode | null; // the division's own box, when the viewer covers it
  branches: readonly OrgNode[];
  loose?: readonly LooseRow[];
  config: HealthConfig;
}) {
  return (
    <section aria-label={label} className="grid gap-1 rounded-xl border bg-card p-2">
      {head?.scored ? (
        <TeamRow row={head} config={config} heading />
      ) : (
        <h2 className="flex min-h-9 items-center px-2.5 font-sans text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </h2>
      )}
      {branches.length + loose.length > 0 ? (
        <ul className="grid gap-1">
          {branches.map((node) => (
            <Branch key={node.teamId} node={node} config={config} />
          ))}
          {loose.map((row) => (
            <li key={looseKey(row)}>
              <TeamRow row={row} config={config} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2.5 pb-1.5 text-sm text-muted-foreground">Nothing under it yet.</p>
      )}
    </section>
  );
}

export function OrgChart({ org, config }: { org: Org; config: HealthConfig }) {
  // The organisation node (migration 0006) holds every division: its own box, rolled up over the
  // whole organisation, goes on top for a viewer who covers it, and its divisions get their cards.
  const organisations = org.roots.filter((root) => root.kind === "organisation");
  const roots = org.roots.flatMap((root) => (root.kind === "organisation" ? root.children : [root]));
  const divisions = roots.filter((root) => root.kind === "division");
  const unplaced = roots.filter((root) => root.kind !== "division");
  return (
    <HeatmapTooltip>
      <div className="grid items-start gap-4 md:grid-cols-2">
        {organisations
          .filter((node) => node.scored)
          .map((node) => (
            <section key={node.teamId} aria-label={node.name} className="grid rounded-xl border bg-card p-2 md:col-span-2">
              <TeamRow row={node} config={config} heading />
            </section>
          ))}
        {divisions.map((division) => (
          <Card
            key={division.teamId}
            label={division.name}
            head={division}
            branches={division.children}
            config={config}
          />
        ))}
        {unplaced.length + org.loose.length > 0 && (
          <Card label="Other" head={null} branches={unplaced} loose={org.loose} config={config} />
        )}
      </div>
    </HeatmapTooltip>
  );
}
