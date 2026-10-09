import { Mic } from "lucide-react";
import Link from "next/link";
import { Tag } from "@/components/normal/tag";
import { Button } from "@/components/ui/button";
import { shiftWeek } from "@/lib/dashboard/weeks";
import type { MyWeek } from "@/lib/portal/my-week";
import { formatDateTime, formatLength, formatWeekEnd, formatWeekStart } from "../checkin/format";
import { SaveWatch } from "./save-watch";
import { Tile } from "./tile";

// The portal's main tile: where the viewer is with this week's check-in, and the one thing to do
// next. Its button is the page's sun, Normal's single accent, while there's a check-in to make.
// The check-in page itself does the recording, shows the privacy notice and submits; this only
// reports what the viewer's own rows say, and never their grade.
export function CheckinTile({ week, thisWeek }: { week: MyWeek; thisWeek: string }) {
  const deadline = `Submit by ${formatWeekEnd(thisWeek)}, 11:59 pm Singapore time.`;
  return (
    <Tile id="checkin" title="This week's check-in" small>
      {week.state === "no_member" ? (
        <p role="status" className="text-[15px] leading-[22px]">
          Your account isn&apos;t set up yet. Ask HQ.
        </p>
      ) : week.state === "unavailable" ? (
        <div className="grid gap-3">
          <p role="alert" className="text-[15px] leading-[22px]">
            Couldn&apos;t load your check-in. Refresh the page to try again.
          </p>
          <Link href="/portal/checkin" className="inline-flex min-h-10 w-fit items-center rounded-sm text-[15px] font-medium underline underline-offset-4">
            Open your check-in
          </Link>
        </div>
      ) : (
        <SaveWatch>
          {week.thisWeek.state === "record" ? (
            <State
              tag={<Tag tone="outline">Not started</Tag>}
              heading="Record this week's check-in"
              body={<p>Five minutes, three questions. {deadline}</p>}
              action={
                <Button asChild variant="accent" className="h-12 w-full px-6 text-[15px] has-[>svg]:px-6 sm:h-10 sm:w-fit">
                  <Link href="/portal/checkin">
                    <Mic aria-hidden strokeWidth={1.5} />
                    Start check-in
                  </Link>
                </Button>
              }
            />
          ) : week.thisWeek.state === "draft" ? (
            <State
              tag={
                <Tag tone="warning" dot>
                  Not submitted
                </Tag>
              }
              heading="Your recording is waiting"
              body={
                <>
                  <p>
                    Recorded {formatDateTime(week.thisWeek.recordedAt)}
                    {week.thisWeek.durationMs !== null && ` · ${formatLength(week.thisWeek.durationMs)}`}. Only you
                    can hear it until you submit.
                  </p>
                  <p className="text-muted-foreground">{deadline}</p>
                </>
              }
              action={
                <Button asChild variant="accent" className="h-12 w-full px-6 text-[15px] has-[>svg]:px-6 sm:h-10 sm:w-fit">
                  <Link href="/portal/checkin">Listen back and submit</Link>
                </Button>
              }
            />
          ) : (
            <State
              tag={
                <Tag tone="success" dot>
                  Done
                </Tag>
              }
              heading="Done for this week"
              body={
                <>
                  <p>
                    {week.thisWeek.submittedAt
                      ? `Submitted on ${formatDateTime(week.thisWeek.submittedAt)}. Thanks, see you next week.`
                      : "Your check-in for this week is in. Thanks, see you next week."}
                  </p>
                  <p className="text-muted-foreground">
                    Next check-in opens {formatWeekStart(shiftWeek(thisWeek, 1))}.
                  </p>
                </>
              }
              action={
                <Button asChild variant="outline" className="h-10 w-fit px-5 text-[15px]">
                  <Link href="/portal/checkin">Open check-in</Link>
                </Button>
              }
            />
          )}
        </SaveWatch>
      )}
    </Tile>
  );
}

function State({
  tag,
  heading,
  body,
  action,
}: {
  tag: React.ReactNode;
  heading: string;
  body: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid justify-items-start gap-3">
        {tag}
        <h3 className="text-[28px] leading-[34px]">{heading}</h3>
      </div>
      <div className="grid max-w-[680px] gap-1 text-[15px] leading-[22px]">{body}</div>
      <div className="pt-2">{action}</div>
    </div>
  );
}
