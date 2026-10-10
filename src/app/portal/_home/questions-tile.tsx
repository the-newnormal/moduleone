import { ChevronDown } from "lucide-react";
import { noticeSections } from "@/lib/checkin/notice";
import { checkinQuestion } from "@/lib/checkin/opening";
import { Tile } from "./tile";

// The week's question, to think about before pressing Start, and the privacy notice members
// accepted, to read again (the check-in page shows it only once). It is the one open question from
// rubrics/coach.md; with the live check-in on, the follow-ups depend on what the member says.
export function QuestionsTile() {
  const { opening, live } = checkinQuestion();
  return (
    <Tile id="questions" title="This week's question">
      <p className="text-[15px] leading-[22px]">{opening}</p>
      <p className="text-[13px] leading-[18px] text-muted-foreground">
        {live && "As you talk, a follow-up question may appear when you pause. "}
        The topics are what you did, where you or your team were at your best, and how you feel about the team.
      </p>
      <details className="group border-t pt-3">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-md text-[15px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          How your recording is used
          <ChevronDown aria-hidden strokeWidth={1.5} className="size-4 motion-safe:transition-transform group-open:rotate-180" />
        </summary>
        <dl className="grid gap-3 pt-2 text-[13px] leading-[18px]">
          {noticeSections().map((section) => (
            <div key={section.heading} className="grid gap-0.5">
              <dt className="font-medium">{section.heading}</dt>
              <dd className="text-muted-foreground">{section.body}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Tile>
  );
}
