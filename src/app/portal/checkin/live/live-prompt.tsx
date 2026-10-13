"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/normal/tag";
import type { Area, Touched } from "@/lib/coach/types";
import { ON_STAGE_MAIN, ON_STAGE_OUTLINE, STAGE_QUESTION } from "../camera-stage";
import type { ShownOffer } from "./contract";
import type { FollowUpStatus } from "./pacing";
import { OPENING_OFFER_ID } from "./use-live-coach";

// What the member sees while recording: the question on screen and Finish. With follow-ups coming
// (touched), also a line under the question saying what is coming (status: starting, listening,
// checking for one, one ready for their next pause, or no more), which areas they have touched on
// (never how well: no scores, no percentages), and "Different question" while a follow-up is shown.
// Their words are never shown back to them, so their attention stays on talking. New questions are
// announced by the recorder's live region, without moving focus; the line under the question isn't
// announced (bar "no more", once: see recorder.tsx), so a screen reader's voice doesn't reach the
// microphone. onStage: laid over the member's camera (the recorder's CameraStage), so light on dark.

const AREA_LABELS: { area: Area; label: string }[] = [
  { area: "activity", label: "What you did" },
  { area: "excellence", label: "At your best" },
  { area: "morale", label: "The team" },
];

// Only "ready" says a follow-up is coming: a call that is out may bring one, or a closing line, or
// nothing new, so "checking" promises nothing.
export const FOLLOW_UP_COPY: Record<FollowUpStatus, string> = {
  starting: "Starting follow-ups…",
  listening: "Listening…",
  checking: "Checking for a follow-up…",
  ready: "A follow-up will show when you pause.",
  no_more: "No more follow-ups.",
};
// Under a follow-up question, "Different question" can still swap it: what stays true is that none
// come after it.
export const LAST_FOLLOW_UP = "No more follow-ups after this one.";

export function followUpCopy(status: FollowUpStatus, offer: ShownOffer): string {
  return status === "no_more" && offer.kind === "question" && offer.id !== OPENING_OFFER_ID ? LAST_FOLLOW_UP : FOLLOW_UP_COPY[status];
}

// The dots' stagger must sit under motion-safe too: the animate-* shorthand would reset a plain delay.
const DOTS = ["", "motion-safe:[animation-delay:200ms]", "motion-safe:[animation-delay:400ms]"];

// Told by its words first, the number of dots second (one still dot while listening, three while
// starting, checking or ready, none once no more are coming) and motion third (a slow fade while
// starting or checking, only where the device allows motion; ready waits on them, so it is still);
// never by colour, which is the text's own. The dots' slot is a fixed width, so the words don't shift
// between states.
function FollowUpLine({ status, offer, onStage }: { status: FollowUpStatus; offer: ShownOffer; onStage: boolean }) {
  const count = status === "no_more" ? 0 : status === "listening" ? 1 : 3;
  const moving = status === "starting" || status === "checking";
  return (
    <p className={onStage ? "flex min-h-5 items-center gap-2 text-sm text-white/75" : "flex min-h-5 items-center gap-2 text-sm text-muted-foreground"}>
      {count > 0 && (
        <span aria-hidden="true" className="flex w-6.5 shrink-0 items-center gap-1">
          {DOTS.slice(0, count).map((delay) => (
            <span
              key={delay}
              className={moving ? `size-1.5 rounded-full bg-current motion-safe:animate-follow-up ${delay}` : "size-1.5 rounded-full bg-current"}
            />
          ))}
        </span>
      )}
      {followUpCopy(status, offer)}
    </p>
  );
}

export function LivePrompt({
  offer,
  touched,
  status,
  canSkip,
  onSkip,
  onFinish,
  finishRef,
  onStage = false,
  children,
}: {
  offer: ShownOffer;
  // null when no follow-ups are coming: live check-ins are off, or live coaching has stopped.
  touched: Touched | null;
  // What the line under the question says; null when no follow-ups are coming, as for touched.
  status: FollowUpStatus | null;
  canSkip: boolean;
  onSkip: () => void;
  onFinish: () => void;
  // The recorder's main button, which it focuses as its steps change.
  finishRef: RefObject<HTMLButtonElement | null>;
  onStage?: boolean;
  // Shown above the buttons (the recorder's one-minute warning).
  children?: ReactNode;
}) {
  // "Different question" goes when a closing line replaces the question. If it had focus (pressed, or
  // just tabbed to), focus would fall to the page, so it moves to Finish instead; a question that
  // simply replaces another keeps the button, and focus, where they are.
  const skipFocused = useRef(false);
  useEffect(() => {
    if (canSkip || !skipFocused.current) return;
    skipFocused.current = false;
    if (!document.activeElement || document.activeElement === document.body) finishRef.current?.focus();
  }, [canSkip, finishRef]);

  return (
    <>
      {/* Over the camera, the size it was before the take began, so the panel doesn't cover their face. */}
      <h3 className={onStage ? STAGE_QUESTION : "text-2xl leading-snug"}>{offer.text}</h3>
      {status && <FollowUpLine status={status} offer={offer} onStage={onStage} />}
      {touched && (
        <ul aria-label="What you've talked about so far" className="flex flex-wrap gap-2">
          {AREA_LABELS.map(({ area, label }) => (
            <li key={area}>
              <Tag
                tone={touched[area] ? "success" : "outline"}
                className={touched[area] ? undefined : onStage ? "border-white/45 text-white/80" : "text-muted-foreground"}
              >
                {touched[area] && <Check aria-hidden="true" className="size-3" />}
                <span className="sr-only">{touched[area] ? "Touched on: " : "Not yet: "}</span>
                {label}
              </Tag>
            </li>
          ))}
        </ul>
      )}
      {children}
      <div className="flex flex-wrap gap-2">
        <Button ref={finishRef} type="button" onClick={onFinish} className={onStage ? ON_STAGE_MAIN : undefined}>
          Finish
        </Button>
        {canSkip && (
          <Button
            type="button"
            variant="outline"
            className={onStage ? ON_STAGE_OUTLINE : undefined}
            onFocus={() => {
              skipFocused.current = true;
            }}
            onBlur={(event) => {
              // Focus moving to something else; a blur from the button being removed has no target.
              if (event.relatedTarget) skipFocused.current = false;
            }}
            onClick={onSkip}
          >
            Different question
          </Button>
        )}
      </div>
    </>
  );
}
