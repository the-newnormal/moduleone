"use client";

import { useRef, useState } from "react";

// Plays a check-in recording from its stable address (src/lib/dashboard/recordings.ts), which
// signs a fresh Storage link on every request. The browser keeps reading from the link it was
// redirected to for every later byte range, so after a long pause that link can run out
// mid-listen; then fetch the address again and carry on from the same spot. If that fails too,
// say so (with a way to try again) rather than retry forever.
export function RecordingPlayer({ src }: { src: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const reloads = useRef(0); // since the recording last played
  const wantsToPlay = useRef(false);
  const [failed, setFailed] = useState(false);

  // Fetch the stable address again (a new query string, so the browser can't reuse the expired
  // link) and carry on from the same spot. With preload="none" nothing loads until play(), so
  // resume straight away when the listener was playing; otherwise their next press of play does.
  const reload = (resume: boolean) => {
    const el = audio.current;
    if (!el) return;
    const position = el.currentTime;
    reloads.current += 1;
    el.src = `${src}?reload=${reloads.current}`;
    // Before the new source loads, this sets where it starts playing.
    if (position > 0) el.currentTime = position;
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
        onPlaying={() => {
          reloads.current = 0;
          setFailed(false);
        }}
        onError={() => {
          if (reloads.current === 0) reload(wantsToPlay.current);
          else setFailed(true);
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
              reloads.current = 0;
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
