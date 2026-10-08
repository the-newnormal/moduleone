"use client";

import { useState } from "react";

// The draft's player. The signed link expires, and an <audio> element that can't load says
// nothing, so say why playback failed and how to fix it.
export function DraftPlayer({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="grid gap-2">
      <audio controls preload="metadata" src={src} className="w-full" onError={() => setFailed(true)}>
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
