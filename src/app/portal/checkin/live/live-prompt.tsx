"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/normal/tag";
import type { Area, Touched } from "@/lib/coach/types";
import type { ShownOffer } from "./contract";

// What the member sees while recording a live check-in: the question on screen, which areas they
// have touched on (never how well: no scores, no percentages), "Different question" while a
// follow-up is shown, and Finish. Their words are never shown back to them, so their attention
// stays on talking. New questions are announced by the recorder's live region, without moving focus.

const AREA_LABELS: { area: Area; label: string }[] = [
  { area: "activity", label: "What you did" },
  { area: "excellence", label: "At your best" },
  { area: "morale", label: "The team" },
];

export function LivePrompt({
  offer,
  touched,
  canSkip,
  onSkip,
  onFinish,
  finishRef,
  children,
}: {
  offer: ShownOffer;
  touched: Touched;
  canSkip: boolean;
  onSkip: () => void;
  onFinish: () => void;
  // The recorder's main button, which it focuses as its steps change.
  finishRef: RefObject<HTMLButtonElement | null>;
  // Shown above the buttons (the recorder's one-minute warning).
  children?: ReactNode;
}) {
  // "Different question" goes when a closing line replaces the question. If it had focus, focus
  // would fall to the page, so it moves to Finish instead; a question that simply replaces another
  // keeps the button, and focus, where they are.
  const skipPressed = useRef(false);
  useEffect(() => {
    if (canSkip || !skipPressed.current) return;
    skipPressed.current = false;
    if (!document.activeElement || document.activeElement === document.body) finishRef.current?.focus();
  }, [canSkip, finishRef]);

  return (
    <>
      <h3 className="text-2xl leading-snug">{offer.text}</h3>
      {offer.kind === "question" && (
        <p className="text-sm text-muted-foreground">Answer out loud. When you pause, a follow-up may appear.</p>
      )}
      <ul aria-label="What you've talked about so far" className="flex flex-wrap gap-2">
        {AREA_LABELS.map(({ area, label }) => (
          <li key={area}>
            <Tag tone={touched[area] ? "success" : "outline"} className={touched[area] ? undefined : "text-muted-foreground"}>
              {touched[area] && <Check aria-hidden="true" className="size-3" />}
              <span className="sr-only">{touched[area] ? "Touched on: " : "Not yet: "}</span>
              {label}
            </Tag>
          </li>
        ))}
      </ul>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button ref={finishRef} type="button" onClick={onFinish}>
          Finish
        </Button>
        {canSkip && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              skipPressed.current = true;
              onSkip();
            }}
          >
            Different question
          </Button>
        )}
      </div>
    </>
  );
}
