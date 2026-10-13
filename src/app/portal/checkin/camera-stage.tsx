"use client";

import { Camera, CameraOff } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { pauseOtherAudio } from "@/components/recordings/pause-others";
import { Button } from "@/components/ui/button";

// What members are told before they record (the privacy notice's "What we record", or the onboarding
// form that replaces it), shortened for the screen. Say nothing here that they aren't told.
export const VOICE_ONLY_LINE =
  "Only your voice is recorded. The camera just shows you to yourself; its picture is never saved or sent.";

// The camera on a stage that fills the screen below the app bar, with what the member needs laid
// over it: a top row with what is happening (status: the pill and the clock during the take) and the
// camera's own button (control), and under it the question and the buttons in a panel at the bottom
// (children). The video is muted and inline, as iPhone Safari needs to play it in the page rather
// than fullscreen, and mirrored, as people expect to see themselves. The page behind doesn't scroll
// while the stage is up, and can't be reached under it (see below).
export function CameraStage({
  stream,
  status,
  control,
  children,
}: {
  stream: MediaStream;
  status?: ReactNode;
  control?: ReactNode;
  children: ReactNode;
}) {
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
        {/* On a very short screen (zoomed in, as WCAG's 320 x 256, or a phone on its side) the top row
            would leave the panel only a sliver to scroll in, so there the whole layer scrolls instead,
            top row and all. Every phone held upright is taller than that. */}
        <div className="absolute inset-0 flex flex-col gap-3 p-3 sm:p-5 [@media(max-height:30rem)]:overflow-y-auto">
          {/* Doesn't scroll, so the camera's button is always in view; it wraps under the status on a phone. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {status}
            {control && <div className="ml-auto">{control}</div>}
          </div>
          {/* The panel sits at the bottom, and scrolls when there isn't room for it (a short phone), so
              the question is never cut off. mt-auto, not justify-end, which would put the panel's top
              out of reach once it scrolls. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [@media(max-height:30rem)]:min-h-auto [@media(max-height:30rem)]:overflow-y-visible">
            <div className="mx-auto mt-auto grid w-full max-w-3xl gap-4 rounded-2xl bg-black/65 p-4 backdrop-blur-md sm:p-6">
              {children}
            </div>
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
// A button in the stage's top row, straight over the camera's picture: outlined in white on a dark
// ground of its own, as the pills are, so its words can be read over a bright picture, and with a dark
// band round its white focus ring, so the ring can be seen over one too.
export const ON_STAGE_TOP =
  "focus-visible:outline-white focus-visible:shadow-[0_0_0_6px_rgb(0_0_0/0.6)] border-white/60 bg-black/55 text-white backdrop-blur-md hover:bg-black/70 hover:text-white dark:border-white/60 dark:bg-black/55 dark:hover:bg-black/70";

// The privacy notice's line, on the stage (under its main buttons) and in the card.
export function VoiceOnlyLine({ id, onStage = false, className }: { id?: string; onStage?: boolean; className?: string }) {
  const muted = onStage ? "text-sm text-white/75" : "text-sm text-muted-foreground";
  return (
    <p id={id} className={className ? `${muted} ${className}` : muted}>
      {VOICE_ONLY_LINE}
    </p>
  );
}

// The camera's on/off button: one button whose words change (no aria-pressed), never the main action
// (no sun, never ON_STAGE_MAIN). on: the camera is on (the button turns it off). waiting: the browser
// is asking about the camera, so the button waits, and ignores presses, until it's answered. onStage:
// in the stage's top row, over the camera's picture. describedBy: the id of what describes it, only
// while nothing records: a screen reader reads a description out as focus lands on the button (the
// recorder moves focus to it at each switch mid-take), and reads it again when it changes, and its
// voice through the speakers would reach the microphone, the take and the live transcript.
export function CameraButton({
  on,
  waiting = false,
  onToggle,
  buttonRef,
  onStage = false,
  describedBy,
}: {
  on: boolean;
  waiting?: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onStage?: boolean;
  describedBy?: string;
}) {
  const label = waiting ? "Waiting for your camera…" : on ? "Turn off my camera" : "Turn on my camera";
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      size="sm"
      aria-disabled={waiting}
      aria-describedby={describedBy}
      onClick={() => !waiting && onToggle()}
      className={onStage ? ON_STAGE_TOP : undefined}
    >
      {on && !waiting ? <CameraOff aria-hidden="true" /> : <Camera aria-hidden="true" />}
      {label}
    </Button>
  );
}

// The camera's row in the card while recording, where the camera is off (the stage is the camera):
// what is recorded, the button that turns the camera on, and a note under them (while the browser
// asks, or once it didn't come on). Nothing in it is announced, and nothing in it describes the
// button (see CameraButton): the note is only there to be seen, and read like any other text.
export function CameraRow({
  waiting = false,
  note = null,
  onToggle,
  buttonRef,
}: {
  waiting?: boolean;
  note?: string | null;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <VoiceOnlyLine className="min-w-48 flex-1" />
        <CameraButton on={false} waiting={waiting} onToggle={onToggle} buttonRef={buttonRef} />
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}
