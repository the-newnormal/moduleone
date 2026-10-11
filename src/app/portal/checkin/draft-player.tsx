"use client";

import { useState } from "react";
import { pauseOtherAudio } from "@/components/recordings/pause-others";

// The draft's player. The signed link expires, and an <audio> element that can't load says
// nothing, so say why playback failed and how to fix it. Playing it pauses the diary's recordings.
// label names it for screen readers among the Diary's players (they give the week and year too).
export function DraftPlayer({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="grid gap-2">
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={label}
        className="w-full"
        onPlay={(e) => pauseOtherAudio(e.currentTarget)}
        onError={() => setFailed(true)}
      >
        Your browser can&apos;t play this recording.
      </audio>
      {failed && (
        <p role="alert" className="text-sm text-muted-foreground">
          Couldn&apos;t play the recording. Refresh the page to listen again.
        </p>
      )}
    </div>
  );
}
