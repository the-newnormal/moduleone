import { ChevronDown } from "lucide-react";
import { sgtDay } from "@/lib/checkin/diary";
import type { ViewGroup, ViewLine } from "@/lib/checkin/view-log";
import { formatDateTime, formatDayMonth, formatLongDate } from "./format";

// Who opened a member's check-in in Module One, or played its recording, and when (the view log,
// src/lib/checkin/view-log.ts), under the entry it was about. Only ever a name, Leader or HQ, what
// they did and when: never their team, email, title or grants, a count of views, or anything about
// the check-in itself. Nothing at all when nobody has, so it never says "nobody".

const NOTE = "text-[13px] leading-[18px] text-muted-foreground";

const DID: Record<ViewLine["kind"], string> = {
  opened: "opened your check-in",
  played: "played your recording",
};

const RESET = " (an earlier check-in for this week, since reset)";

// "Jane Tan", "Jane Tan and Ali Rahman", "Jane Tan, Ali Rahman and Wen Li", or past three people
// "Jane Tan, Ali Rahman and 2 others" (the most recent first).
export function viewerNames(groups: readonly ViewGroup[]): string {
  const names = groups.map((g) => g.name);
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

// "Jane Tan · HQ — opened your check-in on Friday 9 October at 2:15 pm", with the year when it isn't
// this one in Singapore.
export function viewLine(group: ViewGroup, line: ViewLine, thisYear: string): string {
  const when = formatDateTime(line.at, sgtDay(line.at).slice(0, 4) !== thisYear);
  return `${group.name} · ${group.role} — ${DID[line.kind]} on ${when}${line.reset ? RESET : ""}`;
}

// Every line, a person at a time.
function ViewLines({ groups, className = "" }: { groups: readonly ViewGroup[]; className?: string }) {
  const thisYear = sgtDay(new Date()).slice(0, 4);
  return (
    <ul className={`grid gap-1.5 text-[13px] leading-[18px] break-words ${className}`}>
      {groups.flatMap((group, g) =>
        group.lines.map((line, l) => <li key={`${g}-${l}`}>{viewLine(group, line, thisYear)}</li>),
      )}
    </ul>
  );
}

// Folded under an entry: "Opened by …", then each line.
export function ViewedBy({ groups }: { groups: readonly ViewGroup[] | undefined }) {
  if (!groups || groups.length === 0) return null;
  return (
    <details className="group">
      <summary
        className={`flex min-h-10 w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden ${NOTE}`}
      >
        <span className="break-words">{`Opened by ${viewerNames(groups)}`}</span>
        <ChevronDown aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 motion-safe:transition-transform group-open:rotate-180" />
      </summary>
      <ViewLines groups={groups} className="pt-1 pb-2" />
    </details>
  );
}

// Weeks whose check-in is no longer on the page (a Master Admin reset it and it wasn't recorded
// again): their lines stay listed here, newest week first.
export function NoLongerInDiary({ weeks }: { weeks: readonly (readonly [string, readonly ViewGroup[]])[] }) {
  if (weeks.length === 0) return null;
  const thisYear = sgtDay(new Date()).slice(0, 4);
  return (
    <section aria-labelledby="no-longer-title" className="grid gap-4">
      <h2 id="no-longer-title" className="text-[15px] leading-[22px] font-medium">
        No longer in your Diary
      </h2>
      {weeks.map(([week, groups]) => (
        <article key={week} aria-labelledby={`no-longer-${week}`} className="grid gap-2">
          <h3 id={`no-longer-${week}`} className="text-[15px] leading-[22px]">
            {`Week of ${week.slice(0, 4) === thisYear ? formatDayMonth(week) : formatLongDate(week)}`}
          </h3>
          <ViewLines groups={groups} />
        </article>
      ))}
    </section>
  );
}
