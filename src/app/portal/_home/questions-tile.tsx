import { ChevronDown } from "lucide-react";
import { noticeSections } from "@/lib/checkin/notice";
import { QUESTIONS } from "@/lib/checkin/week";
import { Tile } from "./tile";

// The week's three questions, to think about before pressing Start, and the privacy notice members
// accepted, to read again (the check-in page shows it only once).
export function QuestionsTile() {
  return (
    <Tile id="questions" title="This week's questions">
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
      <details className="group border-t pt-3">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-md text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          How your recording is used
          <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
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
