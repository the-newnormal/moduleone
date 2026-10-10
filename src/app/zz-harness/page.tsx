"use client";
// TEMPORARY visual harness, never committed.
import { createRef, useEffect, useState } from "react";
import { AppBar } from "../_shell/app-bar";
import { CameraStage, STAGE_PILL } from "../portal/checkin/camera-stage";
import { LivePrompt } from "../portal/checkin/live/live-prompt";
import { Recorder } from "../portal/checkin/recorder";

const OPENING = "Talk me through your week: what you worked on, what came of it, and how you're feeling about the team.";

function PromptView({ dark }: { dark: boolean }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    void navigator.mediaDevices.getUserMedia({ video: true }).then(setStream);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  if (!stream) return <p>waiting</p>;
  return (
    <CameraStage
      stream={stream}
      top={
        <>
          <span className={STAGE_PILL}>Recording</span>
          <span className={STAGE_PILL}>3:12</span>
        </>
      }
    >
      <LivePrompt
        offer={{ id: 2, kind: "question", text: "What came of the vendor onboarding at the Jurong site, and who on the team made it work?" }}
        touched={{ activity: true, excellence: false, morale: false }}
        canSkip
        onSkip={() => {}}
        onFinish={() => {}}
        finishRef={createRef<HTMLButtonElement>()}
        onStage
      >
        <p className="text-sm text-white/80">One minute left. The recording stops at 10 minutes.</p>
      </LivePrompt>
    </CameraStage>
  );
}

export default function Harness() {
  const [view, setView] = useState<string | null>(null);
  useEffect(() => setView(new URLSearchParams(location.search).get("view") ?? "recorder"), []);
  if (!view) return null;
  return (
    <>
      <AppBar nav={[]} />
      <main className="mx-auto w-full max-w-2xl p-4">
        {view === "recorder" ? (
          <div className="rounded-xl border p-4">
            <Recorder live={{ opening: OPENING }} />
          </div>
        ) : (
          <PromptView dark={view === "prompt-dark"} />
        )}
      </main>
    </>
  );
}
