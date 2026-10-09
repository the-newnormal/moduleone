import { Check, Mic, Minus } from "lucide-react";
import { formatWeek } from "@/lib/dashboard/weeks";
import type { WeekMark, WeekStrip } from "@/lib/portal/my-week";
import { Tile } from "./tile";

// The viewer's own last weeks: whether they checked in, never how it went. Ink and outlines only,
// so nothing here reads like a grade.
const MARK: Record<WeekMark, { box: string; Icon: typeof Check | null; said: string }> = {
  done: { box: "bg-primary text-primary-foreground", Icon: Check, said: "checked in" },
  none: { box: "border border-border bg-background text-muted-foreground", Icon: Minus, said: "no check-in" },
  open: { box: "border border-dashed border-line-strong", Icon: null, said: "not yet" },
  draft: { box: "border border-dashed border-line-strong bg-sun-soft text-warning-ink", Icon: Mic, said: "recorded, not submitted" },
};

export function WeeksTile({ strip }: { strip: WeekStrip | null }) {
  return (
    <Tile id="weeks" title={`Your last ${strip?.cells.length ?? 8} weeks`}>
      {strip ? (
        <div className="grid gap-4">
          {strip.count === 0 ? (
            <p className="text-[15px] leading-[22px] text-muted-foreground">Your check-ins will show here.</p>
          ) : (
            <p className="flex items-baseline gap-2">
              <span className="font-mono text-[32px] leading-9 tracking-[-0.02em] tabular-nums">{strip.count}</span>
              <span className="text-[13px] leading-[18px] text-muted-foreground">
                {strip.count === 1 ? "check-in" : "check-ins"} in the last {strip.cells.length} weeks
              </span>
            </p>
          )}
          <div className="grid gap-2">
            <ol aria-label={`Your last ${strip.cells.length} weeks, oldest first`} className="grid grid-cols-8 gap-1.5">
              {strip.cells.map((cell, i) => {
                const { box, Icon, said } = MARK[cell.mark];
                const current = i === strip.cells.length - 1;
                return (
                  <li key={cell.week} className={`flex aspect-square items-center justify-center rounded-md ${box}`}>
                    {Icon && <Icon aria-hidden className="size-4" strokeWidth={1.75} />}
                    <span className="sr-only">
                      Week of {formatWeek(cell.week)}
                      {current && " (this week)"}: {said}
                    </span>
                  </li>
                );
              })}
            </ol>
            <div aria-hidden className="flex justify-between text-[13px] leading-[18px] text-muted-foreground">
              <span>{formatWeek(strip.cells[0].week)}</span>
              <span>This week</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[15px] leading-[22px] text-muted-foreground">Couldn&apos;t load your past weeks.</p>
      )}
    </Tile>
  );
}
