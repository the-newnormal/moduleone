import { ChevronDown } from "lucide-react";
import { liveCheckinEnabled } from "@/lib/checkin/live-config";
import { noticeSections } from "@/lib/checkin/notice";
import { QUESTIONS } from "@/lib/checkin/week";
import { coachRubric } from "@/lib/coach/rubric";
import { RubricError } from "@/lib/rubrics/markdown";
import { Tile } from "./tile";

// The week's questions, to think about before pressing Start, and the privacy notice members
// accepted, to read again (the check-in page shows it only once). With the live check-in on, that is
// the opening question from rubrics/coach.md; the follow-ups depend on what the member says.
export function QuestionsTile() {
  const opening = openingQuestion();
  return (
    <Tile id="questions" title="This week's questions">
      {opening ? (
        <>
          <p className="text-[15px] leading-[22px]">{opening}</p>
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            As you talk, a follow-up question may appear when you pause. The topics are what you did, where you or your team were
            at your best, and how you feel about the team.
          </p>
        </>
      ) : (
        <>
          <ol className="grid gap-3">
            {QUESTIONS.map((q, i) => (
              <li key={q.id} className="flex gap-3 text-[15px] leading-[22px]">
                <span
                  aria-hidden
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background font-mono text-xs"
                >
                  {i + 1}
                </span>
                {q.text}
              </li>
            ))}
          </ol>
          <p className="text-[13px] leading-[18px] text-muted-foreground">The recorder shows them one at a time.</p>
        </>
      )}
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

// The live check-in's opening question, or null when the recorder will show the three fixed ones:
// live check-ins are off, or rubrics/coach.md can't be used (the live start route logs that, and
// the recorder falls back to the three questions too).
function openingQuestion(): string | null {
  if (!liveCheckinEnabled()) return null;
  try {
    return coachRubric().opening;
  } catch (error) {
    if (error instanceof RubricError) return null;
    throw error;
  }
}
