import type { CheckedInRow } from "@/lib/dashboard/checked-in";
import type { Glance } from "@/lib/dashboard/glance";
import { Tile } from "./tile";

// For leaders and hq: how many of the people in each box they cover have checked in this week.
// Counts only, never names or scores, and drawn in ink, so nothing here reads like a grade.
export function CheckedInTile({ rows, glance }: { rows: CheckedInRow[] | "failed"; glance: Glance }) {
  if (rows === "failed") {
    return (
      <Tile id="checked-in" title="Who's checked in">
        <p role="alert" className="text-[15px] leading-[22px]">
          Couldn&apos;t load who&apos;s checked in just now.
        </p>
      </Tile>
    );
  }
  const summary = glance.summary?.teamId;
  const other = new Set(glance.other.map((n) => n.teamId));
  return (
    <Tile id="checked-in" title="Who's checked in">
      <p className="text-[13px] leading-[18px] text-muted-foreground">This week so far. Counts only, never names.</p>
      {rows.length === 0 ? (
        <p className="text-[15px] leading-[22px] text-muted-foreground">No teams to show yet.</p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li
              key={row.teamId}
              className={`grid gap-1.5 ${summary && row.teamId !== summary && !other.has(row.teamId) ? "pl-3" : ""}`}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3 text-[15px] leading-[22px]">
                <span className={`truncate ${row.teamId === summary ? "font-medium" : ""}`}>{row.name}</span>
                <span className="shrink-0 text-[13px] leading-[18px] text-muted-foreground">
                  {row.people === 0 ? (
                    "No one here yet"
                  ) : (
                    <>
                      <span className="font-mono text-foreground tabular-nums">{row.checkedIn}</span> of{" "}
                      <span className="font-mono tabular-nums">{row.people}</span>
                      <span className="sr-only"> checked in</span>
                    </>
                  )}
                </span>
              </div>
              {row.people > 0 && (
                <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${Math.round((row.checkedIn / row.people) * 100)}%` }}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}
