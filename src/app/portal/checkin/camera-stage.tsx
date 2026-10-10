"use client";

import { useEffect, useRef, type ReactNode } from "react";

// The camera on a stage that fills the screen below the app bar, with what the member needs laid
// over it: the progress and clock along the top (top), the question and the buttons in a panel at
// the bottom (children). The video is muted and inline, as iPhone Safari needs to play it in the
// page rather than fullscreen, and mirrored, as people expect to see themselves. The page behind
// doesn't scroll while the stage is up.
export function CameraStage({ stream, top, children }: { stream: MediaStream; top?: ReactNode; children: ReactNode }) {
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
  return (
    <div className="fixed inset-x-0 top-(--app-bar-h) bottom-0 z-30 bg-background p-2 sm:p-4">
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
          <div className="flex items-start justify-between gap-2">{top}</div>
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
  "focus-visible:outline-white border-white/60 bg-transparent text-white hover:bg-white/15 hover:text-white dark:bg-transparent dark:hover:bg-white/15";
export const STAGE_PILL = "rounded-full bg-black/55 px-3 py-1 text-sm backdrop-blur-md";
