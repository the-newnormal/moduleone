"use client";

import { Camera, CameraOff } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { pauseOtherAudio } from "@/components/recordings/pause-others";
import { Button } from "@/components/ui/button";

// The privacy notice's VOICE_ONLY (src/lib/checkin/notice.ts), shortened for the screen. Say nothing
// here that the notice doesn't say.
export const VOICE_ONLY_LINE =
  "Only your voice is recorded. The camera just shows you to yourself; its picture is never saved or sent.";

// The camera on a stage that fills the screen below the app bar, with what the member needs laid
// over it: the progress and clock along the top (top), the question and the buttons in a panel at
// the bottom (children). The video is muted and inline, as iPhone Safari needs to play it in the
// page rather than fullscreen, and mirrored, as people expect to see themselves. The page behind
// doesn't scroll while the stage is up, and can't be reached under it (see below).
export function CameraStage({ stream, top, children }: { stream: MediaStream; top?: ReactNode; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  useEffect(() => {
    const page = document.documentElement;
    const before = page.style.overflow;
    page.style.overflow = "hidden";
    return () => {
      page.style.overflow = before;
    };
  }, []);
  // The page's other sections (the Diary's, with their players) sit unseen under the stage: inert
  // while it is up, so Tab and screen readers can't reach them there either, and nothing is played
  // into the take from under it. A recording already playing there is paused as the stage comes up,
  // since its controls go out of reach with it. The app bar stays above the stage, and in reach.
  useEffect(() => {
    pauseOtherAudio();
    const own = stage.current;
    const main = own?.closest("main");
    if (!own || !main) return;
    const behind = [...main.children].filter((section) => !section.contains(own) && !section.hasAttribute("inert"));
    behind.forEach((section) => section.setAttribute("inert", ""));
    return () => behind.forEach((section) => section.removeAttribute("inert"));
  }, []);
  return (
    <div ref={stage} className="fixed inset-x-0 top-(--app-bar-h) bottom-0 z-30 bg-background p-2 sm:p-4">
      <div className="relative mx-auto size-full max-w-6xl overflow-hidden rounded-2xl bg-black text-white">
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-hidden="true"
          className="absolute inset-0 size-full -scale-x-100 object-cover"
        />
        {/* Scrolls when there isn't room for both (a short screen, or zoomed in), so the question is never cut off. */}
        <div className="absolute inset-0 flex flex-col justify-between gap-3 overflow-y-auto p-3 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">{top}</div>
          <div className="mx-auto grid w-full max-w-3xl gap-4 rounded-2xl bg-black/65 p-4 backdrop-blur-md sm:p-6">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// Over the dark stage: the main button white, a second button outlined in white, each with a white
// focus ring.
export const ON_STAGE_MAIN = "focus-visible:outline-white bg-white text-black hover:bg-white/85";
export const ON_STAGE_OUTLINE =
  "focus-visible:outline-white border-white/60 bg-transparent text-white hover:bg-white/15 hover:text-white dark:border-white/60 dark:bg-transparent dark:hover:bg-white/15";
export const STAGE_PILL = "rounded-full bg-black/55 px-3 py-1 text-sm backdrop-blur-md";

// The camera's own row, under the main buttons, on the stage and in the card: what is recorded, and
// the camera's on/off button. Never the main action (no sun, never ON_STAGE_MAIN). Never announced;
// the note under it is tied to the button by aria-describedby instead.
// on: the camera is on (the button turns it off). waiting: the browser is asking about the camera, so
// the button waits, and ignores presses, until it's answered. note: a line under the row (why the
// camera isn't on yet, or didn't come on). onStage: over the dark stage.
export function CameraRow({
  on,
  waiting = false,
  note = null,
  onToggle,
  buttonRef,
  onStage = false,
}: {
  on: boolean;
  waiting?: boolean;
  note?: string | null;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onStage?: boolean;
}) {
  const lineId = useId();
  const noteId = useId();
  const muted = onStage ? "text-sm text-white/75" : "text-sm text-muted-foreground";
  const label = waiting ? "Waiting for your camera…" : on ? "Turn off my camera" : "Turn on my camera";
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p id={lineId} className={`${muted} min-w-48 flex-1`}>
          {VOICE_ONLY_LINE}
        </p>
        <Button
          ref={buttonRef}
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={waiting}
          aria-describedby={note ? `${lineId} ${noteId}` : lineId}
          onClick={() => !waiting && onToggle()}
          className={onStage ? ON_STAGE_OUTLINE : undefined}
        >
          {on && !waiting ? <CameraOff aria-hidden="true" /> : <Camera aria-hidden="true" />}
          {label}
        </Button>
      </div>
      {note && (
        <p id={noteId} className={muted}>
          {note}
        </p>
      )}
    </div>
  );
}
