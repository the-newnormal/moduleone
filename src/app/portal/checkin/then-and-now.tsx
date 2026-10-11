import { Tile } from "@/app/portal/_home/tile";
import type { DiaryEntry } from "@/lib/checkin/diary";
import { EntryAudio, LengthAndKept } from "./entries";
import { formatLongDate } from "./format";

// The Diary's way of hearing how someone has changed: the earliest recording they can still play,
// next to their latest (buildDiary picks them; it needs two). Listening only, nothing scored. Now
// may be this week's, whose player is in the card: then its block links up to it.
export function ThenAndNow({ then, now }: { then: DiaryEntry; now: DiaryEntry }) {
  return (
    <Tile id="then-and-now" title="Then and now">
      <p className="text-[15px] leading-[22px]">
        Your earliest recording you can still play, next to your latest. Play one, then the other, and hear how
        you&apos;ve changed.
      </p>
      <div className="grid gap-6 sm:grid-cols-2">
        <Block id="then-and-now-then" eyebrow="Then" entry={then} />
        <Block id="then-and-now-now" eyebrow="Now" entry={now} />
      </div>
    </Tile>
  );
}

// content-start: side by side, a block with a link instead of a player is the shorter one, and its
// rows mustn't stretch to the other's height (its lines would sit lower than Then's).
function Block({ id, eyebrow, entry }: { id: string; eyebrow: string; entry: DiaryEntry }) {
  return (
    <article aria-labelledby={id} className="grid min-w-0 content-start gap-2">
      <h3 id={id} className="grid gap-1">
        <span className="font-sans text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">{eyebrow}</span>{" "}
        <span className="text-xl leading-[26px]">{`Week of ${formatLongDate(entry.week)}`}</span>
      </h3>
      <LengthAndKept entry={entry} />
      <EntryAudio entry={entry} here="then-and-now" />
    </article>
  );
}
