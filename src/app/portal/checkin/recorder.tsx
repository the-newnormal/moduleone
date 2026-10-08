"use client";

import { LoaderCircle, Mic } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { baseMimeType, extensionFor } from "@/lib/checkin/audio";
import { QUESTIONS } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/client";
import { prepareRecording, saveDraft } from "./actions";
import { formatClock } from "./format";
import { saveTake, type ReadyToUpload, type SaveOutcome, type Take } from "./take";

// Opus in WebM where the browser has it (Chrome, Edge, Firefox), AAC in MP4 on Safari. Speech at
// 32 kbit/s is about 0.25 MB a minute, far below the bucket's 25 MB limit.
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
const BITS_PER_SECOND = 32000;
const MAX_MS = 10 * 60 * 1000;
const WARN_MS = 9 * 60 * 1000;
const BUCKET = "checkin-audio";

const UNSUPPORTED = "This browser can't record audio here. Use an up-to-date Chrome, Edge, Firefox or Safari.";
const AWAY = "Your phone may have paused the recording while you were away. Listen back before you submit.";
const LEAVE_MESSAGE = "Leave this page? Your recording hasn't been saved yet, so it will be lost.";

type State =
  | { step: "idle"; problem: string | null }
  | { step: "starting" }
  | { step: "recording"; question: number }
  | { step: "saving" }
  | SaveOutcome;

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

function upload(ready: ReadyToUpload, body: Blob) {
  return createClient()
    .storage.from(BUCKET)
    .uploadToSignedUrl(ready.path, ready.token, body, { contentType: ready.contentType });
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
  // The page was hidden, or the microphone muted, while recording, so the take may have a gap.
  const [away, setAway] = useState(false);
  const media = useRef<Media | null>(null);
  // Bumped by every start and by leaving the page, so a microphone that is granted only after the
  // member has moved on (or started again) is let go instead of recording in the background.
  const startCount = useRef(0);
  const primary = useRef<HTMLButtonElement>(null);
  const firstStep = useRef(true);

  // Let go of the microphone if the member leaves the page mid-recording.
  useEffect(
    () => () => {
      startCount.current += 1;
      release(media);
    },
    [],
  );

  // Ask before leaving (or reloading) while a take exists only in this page.
  const unsaved =
    state.step === "recording" || state.step === "saving" || (state.step === "failed" && !state.updated);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    // App links (← Portal) change pages without unloading this one, so beforeunload doesn't see
    // them. This runs before Next's own click handler, and stops it if the member stays.
    const confirmLeave = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || event.defaultPrevented || event.button !== 0) return;
      // A new tab or window leaves this page, and the take, where it is.
      if (event.metaKey || event.ctrlKey || event.shiftKey || link.getAttribute("target") === "_blank") return;
      if (window.confirm(LEAVE_MESSAGE)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", confirmLeave, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", confirmLeave, true);
    };
  }, [unsaved]);

  // iOS Safari mutes the microphone while the page is hidden (another app, a locked screen), so
  // anything said meanwhile is missing from the take. Any visibility change while recording means
  // the page is or was hidden. Once muted, the gap is in the take, so unmuting changes nothing.
  const recording = state.step === "recording";
  useEffect(() => {
    if (!recording) return;
    const tracks = media.current?.stream.getAudioTracks() ?? [];
    const left = () => setAway(true);
    document.addEventListener("visibilitychange", left);
    tracks.forEach((track) => track.addEventListener("mute", left));
    return () => {
      document.removeEventListener("visibilitychange", left);
      tracks.forEach((track) => track.removeEventListener("mute", left));
    };
  }, [recording]);

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
    setState(await saveTake(take, { prepare: prepareRecording, upload, saveDraft }));
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
    const attempt = ++startCount.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      if (attempt !== startCount.current) return;
      return setState({ step: "idle", problem: microphoneProblem(error) });
    }
    // Granted after the member left the page (the browser's prompt can outlive it): let it go.
    if (attempt !== startCount.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
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
    setAway(false);
    try {
      recorder.start(1000); // a chunk a second, so a crash loses little
    } catch {
      // The microphone went away between the prompt and here (unplugged, or taken by another app).
      release(media);
      return setState({ step: "idle", problem: "Couldn't start the microphone. Try again." });
    }
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
  // Kept on screen until the take is saved (or can't be). In the live region it is a node of its
  // own, so it is announced when it appears and not again with every later step.
  const awayNote = away && unsaved;

  return (
    <div className="grid gap-4">
      <p aria-live="polite" className="sr-only">
        <span>{announcement}</span>
        {awayNote && <span> {AWAY}</span>}
      </p>

      {awayNote && <p className="rounded-md bg-muted px-3 py-2 text-sm">{AWAY}</p>}

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

      {state.step === "failed" && !state.updated && (
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

      {state.step === "failed" && state.updated && (
        <>
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <Button ref={primary} type="button" className="justify-self-start" onClick={() => window.location.reload()}>
            Refresh the page
          </Button>
        </>
      )}
    </div>
  );
}
