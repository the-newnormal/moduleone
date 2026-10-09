"use client";

import { Camera, CameraOff, LoaderCircle, Mic } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { baseMimeType, extensionFor } from "@/lib/checkin/audio";
import { QUESTIONS } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/client";
import { prepareRecording, saveDraft } from "./actions";
import { formatClock } from "./format";
import { currentSave, holdFailedTake, holdRecording, releaseSave, trackSave, wasDeleted } from "./pending-save";
import { saveTake, type ReadyToUpload, type SaveOutcome, type Take } from "./take";

// Opus in WebM where the browser has it (Chrome, Edge, Firefox), AAC in MP4 on Safari. Speech at
// 32 kbit/s is about 0.25 MB a minute, far below the bucket's 25 MB limit.
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
const BITS_PER_SECOND = 32000;
const MAX_MS = 10 * 60 * 1000;
const WARN_MS = 9 * 60 * 1000;
const BUCKET = "checkin-audio";

const UNSUPPORTED = "This browser can't record audio here. Use an up-to-date Chrome, Edge, Firefox or Safari.";
const SUPERSEDED =
  "You'd already saved a newer recording, on another device or tab, so this one wasn't kept. Your draft is the newer one.";
const AWAY = "Your phone may have paused the recording while you were away. Listen back before you submit.";

type State =
  | { step: "idle"; problem: string | null }
  | { step: "starting" }
  | { step: "recording"; question: number }
  | { step: "saving" }
  | SaveOutcome;

// The member's camera, shown mirrored so they can see themselves talk. Only a preview: it never
// reaches the recorder, so the take stays audio-only. Small and front-facing.
const CAMERA: MediaTrackConstraints = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };

// What is live while recording: the microphone stream, the recorder, the clock, and what becomes
// of the take once the recorder stops (null: nothing to save).
type Media = { stream: MediaStream; recorder: MediaRecorder; timer: number; saved: Promise<SaveOutcome | null> };

// The camera while it's on. asked counts requests and is bumped whenever the camera is turned off,
// so a camera the browser grants only after that is let go.
type CameraState = { stream: MediaStream | null; asked: number };

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

// This server's clock (now/route.ts), to stamp takes with.
async function serverNow(): Promise<number> {
  const response = await fetch("/portal/checkin/now", { cache: "no-store" });
  if (!response.ok) throw new Error(`clock: ${response.status}`);
  const { now } = (await response.json()) as { now?: unknown };
  if (typeof now !== "number") throw new Error("clock: no time");
  return now;
}

function upload(ready: ReadyToUpload, body: Blob) {
  return createClient()
    .storage.from(BUCKET)
    .uploadToSignedUrl(ready.path, ready.token, body, { contentType: ready.contentType });
}

// Stops the clock, the recorder and the microphone. Detaches the recorder's handlers first, so a
// recording stopped this way (after an error, say) is dropped rather than uploaded.
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

// Turns the camera off. One the browser is still asking about is let go once it's allowed.
function closeCamera(camera: RefObject<CameraState>) {
  camera.current.asked += 1;
  camera.current.stream?.getTracks().forEach((track) => track.stop());
  camera.current.stream = null;
}

// Whether the browser lets this site use the camera without asking: allowed here before (Chrome
// remembers it; Safari only for the page). False when it can't say, as in Firefox.
async function cameraAllowed(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: "camera" })).state === "granted";
  } catch {
    return false;
  }
}

// The camera preview: muted and inline, as iPhone Safari needs to play it in the page rather than
// fullscreen; mirrored, as people expect to see themselves. Its height is capped and its width
// follows the picture (portrait on an upright phone, nothing cut off), so the question and the
// buttons fit on screen with it; it's brought into view when it appears and when recording starts.
function CameraMirror({ stream, recording }: { stream: MediaStream; recording: boolean }) {
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
    video.current?.scrollIntoView({ block: "nearest" });
  }, [recording]);
  return (
    <video
      ref={video}
      autoPlay
      muted
      playsInline
      aria-hidden="true"
      className="h-[min(30svh,18rem)] w-auto max-w-full -scale-x-100 justify-self-start rounded-lg bg-muted object-cover [aspect-ratio:auto_4/3]"
    />
  );
}

// Stops a live recording with its save registered first, so Sign out and a return to the page wait
// for the take from the moment it stops, not only once the stop event has collected it.
function stopAndTrack(live: Media) {
  window.clearInterval(live.timer);
  void trackSave(live.saved);
  live.recorder.stop(); // onstop collects the take and saves it
}

// heldOnly: shown under a draft (see saved-take.tsx) only for a take this tab still holds, saving or
// failed, or the news that it wasn't kept; it can't start a recording, and shows nothing otherwise.
export function Recorder({ heldOnly = false }: { heldOnly?: boolean }) {
  // The save this recorder came back to, if any (see pending-save.ts). Read once, so the first
  // render and the effect that waits for it agree even if the save settles in between.
  const [returnedTo] = useState(currentSave);
  const [state, setState] = useState<State>(() => (returnedTo ? { step: "saving" } : { step: "idle", problem: null }));
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);
  // The page was hidden, or the microphone muted, while recording, so the take may have a gap.
  const [away, setAway] = useState(false);
  const media = useRef<Media | null>(null);
  // The camera, on only when the member chose it before starting, or by itself at Start where the
  // browser won't ask (a question then would pop up mid-answer). Off once the recording ends.
  const camera = useRef<CameraState>({ stream: null, asked: 0 });
  const [mirror, setMirror] = useState<MediaStream | null>(null);
  // "asking": the browser's camera question is open. Start waits for the answer: Chrome won't ask
  // this page anything else meanwhile, so the microphone's question would never come.
  // "unavailable": blocked, missing or busy, so the member records without seeing themselves.
  const [cameraNote, setCameraNote] = useState<"asking" | "unavailable" | null>(null);
  // The member's choice: true once they showed the camera, false once they hid it.
  const wantsCamera = useRef<boolean | null>(null);
  // Bumped by every start and by leaving the page, so a microphone that is granted only after the
  // member has moved on (or started again) is let go instead of recording in the background.
  const startCount = useRef(0);
  const primary = useRef<HTMLButtonElement>(null);
  const [refreshing, startRefresh] = useTransition();

  // A take whose save failed, kept so leaving the page can still try to save it.
  const failedTake = useRef<Take | null>(null);
  useEffect(() => {
    failedTake.current = state.step === "failed" && !state.updated ? state.take : null;
  }, [state]);

  // Leaving the page within the app (a link, Back or Forward) keeps the take: a recording is
  // finished and saved as a draft, as Finish would, and a take that failed to save is tried once
  // more. Next.js can't hold such a navigation, so this is what stops the take being lost; the
  // member finds the draft when they come back. A save already under way carries on by itself.
  useEffect(
    () => () => {
      startCount.current += 1;
      closeCamera(camera);
      // Still set while recording, and after Finish until onstop has collected the take.
      const live = media.current;
      if (live) {
        window.clearInterval(live.timer);
        void trackSave(live.saved); // registered now, before onstop runs, so a quick return waits too
        if (live.recorder.state !== "inactive") live.recorder.stop(); // onstop saves the take and lets go of the microphone
        return;
      }
      release(media);
      const take = failedTake.current;
      if (take) void trackSave(saveTake(take, { prepare: prepareRecording, upload, saveDraft, serverNow }));
    },
    [],
  );

  // Back on the page while a take saved on the way out is still going: wait for it, then show
  // what it left (the draft, or the take with Try again).
  useEffect(() => {
    const pending = returnedTo;
    if (!pending) return;
    let mounted = true;
    void pending.then((outcome) => {
      if (!mounted) return;
      // This recorder holds the outcome now (a failed take included), so it's no longer pending.
      // Except under a draft: there the save stays held, so Submit waits until it is saved or
      // discarded (see draft-controls.tsx).
      if (!heldOnly) releaseSave(pending);
      // A failed save of the draft the member has since deleted: nothing to offer again.
      setState(outcome && !wasDeleted(outcome) ? outcome : { step: "idle", problem: null });
      // The save re-rendered the page while the member was elsewhere; this page hasn't seen it.
      if (outcome?.step === "saved") startRefresh(() => router.refresh());
    });
    return () => {
      mounted = false;
    };
  }, [returnedTo, router, heldOnly]);

  // Still here once that refresh has landed: the draft has gone since (deleted, or the week
  // turned), so offer a new recording rather than stay on "Saved.".
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshing) refreshed.current = true;
    else if (refreshed.current) setState((s) => (s.step === "saved" ? { step: "idle", problem: null } : s));
  }, [refreshing]);

  // Closing or reloading the tab ends the page before a save could finish, so ask first while a
  // take exists only in this page.
  const unsaved =
    state.step === "recording" || state.step === "saving" || (state.step === "failed" && !state.updated);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
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

  // While recording, Sign out (in the app bar beside this) can finish the recording first: the take
  // is saved as Finish would, and Sign out waits for that save before ending the session.
  useEffect(() => {
    if (!recording) return;
    return holdRecording(() => {
      const live = media.current;
      if (!live || live.recorder.state === "inactive") return;
      setState({ step: "saving" });
      closeCamera(camera); // off with the take, not only once the recorder's stop event comes
      setMirror(null);
      stopAndTrack(live);
    });
  }, [recording]);

  // A failed take shown here (with Try again) is safe only in this page: Sign out asks first.
  const failedShown = state.step === "failed" && !state.updated;
  useEffect(() => (failedShown ? holdFailedTake() : undefined), [failedShown]);

  // Move keyboard and screen-reader focus to each step's main button as the steps change, since
  // the button that was pressed has usually gone. Not on first load, when nothing has happened
  // (compared with the last step shown, so React's double effects in development don't count).
  const step = state.step;
  const problem = state.step === "idle" ? state.problem : null;
  const shown = useRef({ step, problem });
  useEffect(() => {
    if (shown.current.step === step && shown.current.problem === problem) return;
    shown.current = { step, problem };
    primary.current?.focus();
  }, [step, problem]);

  async function save(take: Take): Promise<SaveOutcome> {
    setState({ step: "saving" });
    const outcome = await trackSave(saveTake(take, { prepare: prepareRecording, upload, saveDraft, serverNow }));
    setState(outcome);
    return outcome;
  }

  function turnCameraOff() {
    closeCamera(camera);
    setMirror(null);
    setCameraNote(null);
  }

  // ask: the member pressed Show my camera, so the browser may ask them. Otherwise it's Start
  // turning on a camera the browser allows without asking.
  async function turnCameraOn(ask: boolean) {
    const attempt = ++camera.current.asked;
    if (ask) setCameraNote("asking");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA });
    } catch {
      if (attempt === camera.current.asked) setCameraNote(ask ? "unavailable" : null);
      return;
    }
    // Turned off (or the page left) while the browser asked: let it go.
    if (attempt !== camera.current.asked) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    camera.current.stream = stream;
    setMirror(stream);
    setCameraNote(null);
    // A camera that goes away by itself (unplugged, taken by another app) takes the mirror with it.
    stream.getTracks().forEach((track) =>
      track.addEventListener("ended", () => camera.current.stream === stream && turnCameraOff(), { once: true }),
    );
  }

  function toggleCamera() {
    if (cameraNote === "asking") return;
    wantsCamera.current = !mirror;
    if (mirror) turnCameraOff();
    else void turnCameraOn(true);
  }

  // Finish, or the ten-minute limit.
  function finish() {
    const live = media.current;
    if (!live || live.recorder.state === "inactive") return;
    setState({ step: "saving" });
    turnCameraOff(); // off with the take, not only once the recorder's stop event comes
    stopAndTrack(live);
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
    // Settles once the take is saved (or there is nothing to save), for a return to the page to wait on.
    let settle: (outcome: SaveOutcome | null) => void = () => {};
    const saved = new Promise<SaveOutcome | null>((resolve) => {
      settle = resolve;
    });
    recorder.onerror = () => {
      release(media);
      turnCameraOff();
      settle(null);
      setState({ step: "idle", problem: "The recording stopped unexpectedly. Try again." });
    };
    recorder.onstop = () => {
      const durationMs = Date.now() - startedAt;
      release(media);
      turnCameraOff(); // the take is over, and so is the mirror
      // The type the recorder actually used, or the one asked for; never empty.
      const type = recorder.mimeType && extensionFor(recorder.mimeType) ? recorder.mimeType : mimeType;
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) {
        settle(null);
        return setState({ step: "idle", problem: "Nothing was recorded. Check your microphone, then try again." });
      }
      const take: Take = {
        blob,
        mimeType: baseMimeType(type),
        durationMs,
        recordedAt: Date.now(),
        recordedAtMono: performance.now(),
        serverRecordedAt: null,
        uploadedPath: null,
      };
      void save(take).then(settle);
    };

    const timer = window.setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsedMs(ms);
      if (ms >= MAX_MS) finish();
    }, 250);
    const live: Media = { stream, recorder, timer, saved };
    media.current = live;
    setElapsedMs(0);
    setAway(false);
    try {
      recorder.start(1000); // a chunk a second, so a crash loses little
    } catch {
      // The microphone went away between the prompt and here (unplugged, or taken by another app).
      release(media);
      settle(null);
      return setState({ step: "idle", problem: "Couldn't start the microphone. Try again." });
    }
    setState({ step: "recording", question: 0 });
    // A camera the member hasn't turned on comes on now only if the browser won't ask about it.
    if (!camera.current.stream && wantsCamera.current !== false) {
      const asked = camera.current.asked;
      void cameraAllowed().then((allowed) => {
        if (allowed && camera.current.asked === asked && media.current === live) void turnCameraOn(false);
      });
    }
  }

  function nextQuestion() {
    setState((s) => (s.step === "recording" ? { ...s, question: Math.min(s.question + 1, QUESTIONS.length - 1) } : s));
  }

  function discard() {
    releaseSave(); // the failed take this recorder was showing, if it was still kept there
    setElapsedMs(0);
    setState({ step: "idle", problem: null });
  }

  // After "superseded": show the newer draft (the page hasn't been re-rendered for it yet).
  function showDraft() {
    releaseSave();
    setState({ step: "idle", problem: null });
    startRefresh(() => router.refresh());
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
  if (heldOnly && state.step !== "saving" && state.step !== "failed" && state.step !== "superseded") return null;
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
          <p className="text-sm text-muted-foreground">
            Want to see yourself while you talk? Show your camera before you start. Only your voice is
            recorded; the picture isn&apos;t saved.
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
          <div className="flex flex-wrap gap-2">
            <Button ref={primary} type="button" onClick={start} disabled={refreshing || cameraNote === "asking"}>
              <Mic aria-hidden="true" />
              Start recording
            </Button>
            <Button type="button" variant="outline" onClick={toggleCamera} aria-disabled={cameraNote === "asking"}>
              {mirror ? <CameraOff aria-hidden="true" /> : <Camera aria-hidden="true" />}
              {cameraNote === "asking" ? "Waiting for your camera…" : mirror ? "Hide my camera" : "Show my camera"}
            </Button>
          </div>
          {cameraNote === "asking" && (
            <p className="text-sm text-muted-foreground">
              Answer your browser&apos;s question about the camera to go on. On a computer, it&apos;s by the
              address bar.
            </p>
          )}
          {cameraNote === "unavailable" && (
            <p className="text-sm text-muted-foreground">
              Your camera isn&apos;t available, so you won&apos;t see yourself. You can still record.
            </p>
          )}
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
          <div className="flex flex-wrap gap-2">
            <Button ref={primary} type="button" onClick={state.question < QUESTIONS.length - 1 ? nextQuestion : finish}>
              {state.question < QUESTIONS.length - 1 ? "Next question" : "Finish"}
            </Button>
            {/* Hide only: showing it here would ask the browser mid-answer. */}
            {mirror && (
              <Button type="button" variant="outline" onClick={toggleCamera}>
                <CameraOff aria-hidden="true" />
                Hide my camera
              </Button>
            )}
          </div>
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

      {state.step === "superseded" && (
        <>
          <p role="status" className="text-sm">
            {SUPERSEDED}
          </p>
          <Button ref={primary} type="button" className="justify-self-start" onClick={showDraft}>
            {heldOnly ? "OK" : "Show my draft"}
          </Button>
        </>
      )}

      {mirror && (state.step === "idle" || state.step === "starting" || state.step === "recording") && (
        <CameraMirror stream={mirror} recording={state.step === "recording"} />
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
