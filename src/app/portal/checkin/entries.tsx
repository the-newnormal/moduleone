import { ChevronDown } from "lucide-react";
import { RecordingPlayer } from "@/components/recordings/recording-player";
import { type Diary, type DiaryEntry, sgtDay, type Spot } from "@/lib/checkin/diary";
import type { ViewGroup } from "@/lib/checkin/view-log";
import { formatDay, formatDayMonth, formatLength, formatLongDate } from "./format";
import { ViewedBy } from "./viewed-by";

// The Diary's timeline: every entry but this week's submitted one (the card has that), newest
// first, grouped by the year of its Monday. A year with nothing left to play folds away, its heading
// left outside so it can still be found. Each recording has one player on the page (buildDiary's
// playsIn); wherever else it is listed links up to it. Never a grade: only what DiaryEntry holds,
// and under each entry who opened it (./viewed-by.tsx), from the view log's map by week.

const NOTE = "text-[13px] leading-[18px] text-muted-foreground";
const LINK = "inline-flex min-h-10 w-fit items-center rounded-sm text-[15px] font-medium underline underline-offset-4";

const GONE: Record<NonNullable<DiaryEntry["gone"]>, string> = {
  no_longer_kept: "Recording no longer kept",
  none: "No recording to play",
};

// Where a recording plays, from further down the page. Nothing links down to Entries: it comes last.
const PLAYS_ABOVE: Partial<Record<Spot, { href: string; text: string }>> = {
  card: { href: "#this-week", text: "Play it in this week's entry, above" },
  "then-and-now": { href: "#then-and-now-title", text: "Play it in Then and now, above" },
};

// An entry's recording where the page shows the entry: its player if it plays here, a link up to
// where it plays, or why there is nothing to play. The card adds the length and kept-until line
// under its player (Then and now and Entries show those themselves).
export function EntryAudio({ entry, here }: { entry: DiaryEntry; here: Spot }) {
  if (entry.playsIn === null || entry.src === null) return <p className={NOTE}>{GONE[entry.gone ?? "none"]}</p>;
  if (entry.playsIn !== here) {
    const up = PLAYS_ABOVE[entry.playsIn];
    return up ? (
      <a href={up.href} className={LINK}>
        {up.text}
      </a>
    ) : null;
  }
  const player = <RecordingPlayer src={entry.src} label={`Your recording for the week of ${formatLongDate(entry.week)}`} />;
  if (here !== "card") return player;
  return (
    <div className="grid gap-2">
      {player}
      <LengthAndKept entry={entry} />
    </div>
  );
}

// A recording's length, kept on one line: a phone would otherwise break '3 min 5 s' after the 3.
function Length({ ms }: { ms: number }) {
  return <span className="font-mono whitespace-nowrap tabular-nums">{formatLength(ms)}</span>;
}

// '3 min 12 s · Kept until 6 October 2027', each part only if known; nothing if neither is.
export function LengthAndKept({ entry }: { entry: DiaryEntry }) {
  const length = entry.durationMs !== null && <Length ms={entry.durationMs} />;
  const kept = entry.keptUntil !== null && `Kept until ${formatLongDate(entry.keptUntil)}`;
  if (!length && !kept) return null;
  return (
    <p className={NOTE}>
      {length}
      {length && kept && " · "}
      {kept}
    </p>
  );
}

// views: who opened each week's check-in (viewsByWeek), when the log loaded.
type Views = ReadonlyMap<string, readonly ViewGroup[]> | null;

export function Entries({ diary, views = null }: { diary: Diary | "failed"; views?: Views }) {
  return (
    <section aria-labelledby="entries-title" className="grid gap-4">
      <h2 id="entries-title" className="text-xl leading-[26px]">
        Entries
      </h2>
      <EntriesBody diary={diary} views={views} />
    </section>
  );
}

function EntriesBody({ diary, views }: { diary: Diary | "failed"; views: Views }) {
  if (diary === "failed") return <p role="alert">Couldn&apos;t load your entries. Refresh the page to try again.</p>;
  if (diary.years.length === 0) {
    return (
      <p className="text-[15px] leading-[22px]">
        Each week you submit a check-in, it becomes an entry here that you can listen back to.
      </p>
    );
  }
  return (
    <>
      {diary.firstWeek && <p className={NOTE}>{`Your first entry was the week of ${formatLongDate(diary.firstWeek)}.`}</p>}
      {diary.ninetyDayNote && (
        <p className={NOTE}>
          Recordings you made under the earlier privacy notice are kept for 90 days, as it said. Newer ones are kept
          for a year.
        </p>
      )}
      {diary.years.map((group) => (
        <Year key={group.year} {...group} views={views} />
      ))}
    </>
  );
}

function Year({ year, folded, entries, views }: Diary["years"][number] & { views: Views }) {
  const list = (
    <ol className="grid">
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} year={year} viewedBy={views?.get(entry.week)} />
      ))}
    </ol>
  );
  return (
    <section aria-labelledby={`entries-${year}`} className="grid gap-3">
      <h3
        id={`entries-${year}`}
        className="flex items-center gap-3 font-mono text-[15px] leading-[22px] font-medium tabular-nums after:h-px after:flex-1 after:bg-border"
      >
        {year}
      </h3>
      {folded ? (
        <details className="group">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-md text-[15px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span>
              <span className="font-mono tabular-nums">{entries.length}</span>
              {entries.length === 1 ? " entry, no recording to play" : " entries, no recordings to play"}
            </span>
            <ChevronDown aria-hidden strokeWidth={1.5} className="size-4 motion-safe:transition-transform group-open:rotate-180" />
          </summary>
          {list}
        </details>
      ) : (
        list
      )}
    </section>
  );
}

// One week. With a recording to play (here or above), the heading is full size; otherwise the entry
// is compact and says why there's nothing to play. The dot's shape repeats what the words say.
function Entry({ entry, year, viewedBy }: { entry: DiaryEntry; year: string; viewedBy: readonly ViewGroup[] | undefined }) {
  const playable = entry.src !== null;
  const titleId = `entry-${entry.id}-title`;
  // The day it was submitted, with its year when that isn't the group's (the week of 29 December).
  const submitted =
    entry.submittedAt !== null &&
    `Submitted ${formatDay(entry.submittedAt, sgtDay(entry.submittedAt).slice(0, 4) !== year)}`;
  const length = entry.durationMs !== null && <Length ms={entry.durationMs} />;
  return (
    <li className={`relative grid gap-2 border-l border-border pl-6 last:pb-0 ${playable ? "pb-8" : "pb-6"}`}>
      <span
        aria-hidden
        className={`absolute top-2 -left-[5.5px] size-2.5 rounded-full ${
          playable ? "bg-foreground" : "border border-line-strong bg-background"
        }`}
      />
      <article aria-labelledby={titleId} className="grid gap-2">
        <h4 id={titleId} className={playable ? "text-xl leading-[26px]" : "text-[15px] leading-[22px] font-medium"}>
          {`Week of ${formatDayMonth(entry.week)}`}
          <span className="sr-only">{` ${year}`}</span>
        </h4>
        {(submitted || length) && (
          <p className={NOTE}>
            {submitted}
            {submitted && length && " · "}
            {length}
          </p>
        )}
        <EntryAudio entry={entry} here="entries" />
        {entry.keptUntil !== null && <p className={NOTE}>{`Kept until ${formatLongDate(entry.keptUntil)}`}</p>}
        <ViewedBy groups={viewedBy} />
      </article>
    </li>
  );
}
