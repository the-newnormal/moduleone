"use client";

import { useRef, useState } from "react";
import { mayAutoReload, reloadAddress } from "@/lib/dashboard/playback";

// Plays a check-in recording from its stable address (src/lib/dashboard/recordings.ts), which
// signs a fresh Storage link on every request. The browser keeps reading from the link it was
// redirected to for every later byte range, so after a long pause that link can run out
// mid-listen; then fetch the address again and carry on where the listener was. Automatic reloads
// are rate-limited (src/lib/dashboard/playback.ts); past that, say so, with a way to try again.
export function RecordingPlayer({ src }: { src: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const attempts = useRef(0);
  const lastAutoReload = useRef<number | null>(null);
  const wantsToPlay = useRef(false);
  const [failed, setFailed] = useState(false);

  const reload = (resume: boolean) => {
    const el = audio.current;
    if (!el) return;
    const { currentTime: position, playbackRate: rate } = el;
    attempts.current += 1;
    // Load the new link's metadata even when paused, so the timeline and scrubber come back.
    el.preload = "metadata";
    el.src = reloadAddress(src, attempts.current);
    // A new source resets the position and speed; before it loads, these set where it starts.
    if (position > 0) el.currentTime = position;
    el.playbackRate = rate;
    if (resume) {
      el.play().catch((error: unknown) => {
        // A pause or another reload interrupting this play() isn't a failure.
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    }
  };

  return (
    <div className="grid gap-1.5">
      <audio
        ref={audio}
        controls
        preload="none"
        src={src}
        className="w-full"
        onPlay={() => {
          wantsToPlay.current = true;
        }}
        onPause={() => {
          wantsToPlay.current = false;
        }}
        onPlaying={() => setFailed(false)}
        onError={() => {
          const now = performance.now();
          if (!mayAutoReload(now, lastAutoReload.current)) {
            setFailed(true);
            return;
          }
          lastAutoReload.current = now;
          reload(wantsToPlay.current);
        }}
      >
        <a href={src}>Download the recording</a>
      </audio>
      {failed && (
        <p role="alert" className="text-sm text-muted-foreground">
          The recording didn&apos;t load. If you&apos;ve been away a while, you may need to sign in again.{" "}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-4"
            onClick={() => {
              setFailed(false);
              reload(true);
            }}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
