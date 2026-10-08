"use client";

import { LoaderCircle, Mic } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { baseMimeType, extensionFor } from "@/lib/checkin/audio";
import { QUESTIONS } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/client";
import { prepareRecording, saveDraft } from "./actions";
import { formatClock } from "./format";

// Opus in WebM where the browser has it (Chrome, Edge, Firefox), AAC in MP4 on Safari. Speech at
// 32 kbit/s is about 0.25 MB a minute, far below the bucket's 25 MB limit.
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
const BITS_PER_SECOND = 32000;
const MAX_MS = 10 * 60 * 1000;
const WARN_MS = 9 * 60 * 1000;
const BUCKET = "checkin-audio";

const UNSUPPORTED = "This browser can't record audio here. Use an up-to-date Chrome, Edge, Firefox or Safari.";
const OFFLINE = "Couldn't reach the server. Check your connection, then try again.";

// A finished recording, kept in memory until it is saved, so a failed upload can be retried.
type Take = { blob: Blob; mimeType: string; durationMs: number; uploadedPath: string | null };

type State =
  | { step: "idle"; problem: string | null }
  | { step: "starting" }
  | { step: "recording"; question: number }
  | { step: "saving" }
  | { step: "failed"; take: Take; message: string }
  | { step: "saved" };

// What is live while recording: the microphone stream, the recorder and the clock.
type Media = { stream: MediaStream; recorder: MediaRecorder; timer: number };

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

function microphoneProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it for this site in your browser's settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone found. Connect one, then try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Your microphone is busy in another app. Close that app, then try again.";
  }
  return "Couldn't start the microphone. Try again.";
}

// Stops the clock, the recorder and the microphone. Detaches the recorder's handlers first, so a
// recording stopped this way (leaving the page, say) is dropped rather than uploaded.
function release(media: RefObject<Media | null>) {
  const live = media.current;
  if (!live) return;
  media.current = null;
  window.clearInterval(live.timer);
  live.recorder.ondataavailable = null;
  live.recorder.onstop = null;
  live.recorder.onerror = null;
  if (live.recorder.state !== "inactive") live.recorder.stop();
  live.stream.getTracks().forEach((track) => track.stop());
}

export function Recorder() {
  const [state, setState] = useState<State>({ step: "idle", problem: null });
  const [elapsedMs, setElapsedMs] = useState(0);
  const media = useRef<Media | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const firstStep = useRef(true);

  // Let go of the microphone if the member leaves the page mid-recording.
  useEffect(() => () => release(media), []);

  // Move keyboard and screen-reader focus to each step's main button as the steps change, since
  // the button that was pressed has usually gone. Not on first load, when nothing has happened.
  const step = state.step;
  const problem = state.step === "idle" ? state.problem : null;
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    primary.current?.focus();
  }, [step, problem]);

  async function save(take: Take) {
    setState({ step: "saving" });
    let current = take;
    try {
      let path = current.uploadedPath;
      if (path === null) {
        const prepared = await prepareRecording(current.mimeType);
        if (prepared.status === "submitted") return setState({ step: "saved" });
        if (prepared.status === "error") return setState({ step: "failed", take: current, message: prepared.message });
        // Storage records the file's type from the Blob itself; send the plain type the server allowed.
        const body = new Blob([current.blob], { type: prepared.contentType });
        const { error } = await createClient()
          .storage.from(BUCKET)
          .uploadToSignedUrl(prepared.path, prepared.token, body, { contentType: prepared.contentType });
        if (error) {
          return setState({
            step: "failed",
            take: current,
            message: "The upload didn't go through. Check your connection, then try again.",
          });
        }
        path = prepared.path;
        current = { ...current, uploadedPath: path };
      }
      const saved = await saveDraft({ path, durationMs: current.durationMs });
      if (saved.status === "error") {
        // Only a failure on our side after a good upload is worth retrying with the same file.
        const retake = saved.code === "failed" ? current : { ...current, uploadedPath: null };
        return setState({ step: "failed", take: retake, message: saved.message });
      }
      // The page re-renders with the saved draft (or the submitted check-in) in its place.
      setState({ step: "saved" });
    } catch {
      setState({ step: "failed", take: current, message: OFFLINE });
    }
  }

  function finish() {
    const live = media.current;
    if (!live || live.recorder.state === "inactive") return;
    window.clearInterval(live.timer);
    setState({ step: "saving" });
    live.recorder.stop(); // onstop collects the take
  }

  async function start() {
    const mimeType = pickMimeType();
    if (!mimeType) return setState({ step: "idle", problem: UNSUPPORTED });
    setState({ step: "starting" });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      return setState({ step: "idle", problem: microphoneProblem(error) });
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      return setState({ step: "idle", problem: UNSUPPORTED });
    }

    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      release(media);
      setState({ step: "idle", problem: "The recording stopped unexpectedly. Try again." });
    };
    recorder.onstop = () => {
      const durationMs = Date.now() - startedAt;
      release(media);
      // The type the recorder actually used, or the one asked for; never empty.
      const type = recorder.mimeType && extensionFor(recorder.mimeType) ? recorder.mimeType : mimeType;
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) {
        return setState({ step: "idle", problem: "Nothing was recorded. Check your microphone, then try again." });
      }
      void save({ blob, mimeType: baseMimeType(type), durationMs, uploadedPath: null });
    };

    const timer = window.setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsedMs(ms);
      if (ms >= MAX_MS) finish();
    }, 250);
    media.current = { stream, recorder, timer };
    setElapsedMs(0);
    recorder.start(1000); // a chunk a second, so a crash loses little
    setState({ step: "recording", question: 0 });
  }

  function nextQuestion() {
    setState((s) => (s.step === "recording" ? { ...s, question: Math.min(s.question + 1, QUESTIONS.length - 1) } : s));
  }

  function discard() {
    setElapsedMs(0);
    setState({ step: "idle", problem: null });
  }

  const announcement =
    state.step === "starting"
      ? "Waiting for your microphone…"
      : state.step === "recording"
        ? elapsedMs >= WARN_MS
          ? "One minute left. The recording stops at 10 minutes."
          : `Recording. Question ${state.question + 1} of ${QUESTIONS.length}: ${QUESTIONS[state.question].text}`
        : state.step === "saving"
          ? "Saving your recording…"
          : state.step === "saved"
            ? "Saved."
            : "";

  return (
    <div className="grid gap-4">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {state.step === "idle" && (
        <>
          <p className="text-sm leading-6">
            You&apos;ll see three questions, one at a time. Answer each one out loud, then move on. About a
            minute each is plenty; the recording stops at 10 minutes. You can listen back before you
            submit.
          </p>
          <ol className="grid list-decimal gap-1 pl-5 text-sm">
            {QUESTIONS.map((q) => (
              <li key={q.id}>{q.text}</li>
            ))}
          </ol>
          {state.problem && (
            <p role="alert" className="text-sm text-destructive">
              {state.problem}
            </p>
          )}
          <Button ref={primary} type="button" onClick={start} className="justify-self-start">
            <Mic aria-hidden="true" />
            Start recording
          </Button>
        </>
      )}

      {state.step === "starting" && (
        <p className="flex items-center gap-2 text-sm">
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          Waiting for your microphone…
        </p>
      )}

      {state.step === "recording" && (
        <>
          <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
            <span>
              Question {state.question + 1} of {QUESTIONS.length}
            </span>
            <span className="flex items-center gap-2 font-mono tabular-nums">
              <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-destructive" />
              <span role="timer" aria-label="Time recorded">
                {formatClock(elapsedMs)}
              </span>
            </span>
          </div>
          <h3 className="text-2xl leading-snug">{QUESTIONS[state.question].text}</h3>
          {elapsedMs >= WARN_MS && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              One minute left. The recording stops at 10 minutes.
            </p>
          )}
          <Button
            ref={primary}
            type="button"
            onClick={state.question < QUESTIONS.length - 1 ? nextQuestion : finish}
            className="justify-self-start"
          >
            {state.question < QUESTIONS.length - 1 ? "Next question" : "Finish"}
          </Button>
        </>
      )}

      {(state.step === "saving" || state.step === "saved") && (
        <p className="flex items-center gap-2 text-sm">
          {state.step === "saving" && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {state.step === "saving" ? "Saving your recording…" : "Saved."}
        </p>
      )}

      {state.step === "failed" && (
        <>
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <p className="text-sm text-muted-foreground">Your recording is still here, so nothing is lost yet.</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={primary} type="button" onClick={() => save(state.take)}>
              Try again
            </Button>
            <Button type="button" variant="outline" onClick={discard}>
              Discard
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
