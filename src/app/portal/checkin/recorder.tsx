"use client";

import { Camera, LoaderCircle, Mic } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, useTransition, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { baseMimeType, extensionFor } from "@/lib/checkin/audio";
import { DEFAULT_OPENING_QUESTION } from "@/lib/checkin/week";
import { createClient } from "@/lib/supabase/client";
import { prepareRecording, saveDraft } from "./actions";
import { CameraStage, ON_STAGE_MAIN, STAGE_PILL } from "./camera-stage";
import { formatClock } from "./format";
import { LivePrompt } from "./live/live-prompt";
import type { ShownOffer } from "./live/contract";
import { canSkip, OPENING_OFFER_ID, openingOffer, useLiveCoach } from "./live/use-live-coach";
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
const LAST_MINUTE = "One minute left. The recording stops at 10 minutes.";
const AWAY = "Your phone may have paused the recording while you were away. Listen back before you submit.";
const CAMERA_ASKING = "If your browser asks about the camera, answer it to go on. On a computer, it's by the address bar.";
const CAMERA_STOPPED = "Your camera stopped before the recording began. Turn it on again, or record without it.";
const FELL_BACK = "Follow-up questions have stopped. Keep going, and press Finish when you're done.";

type State =
  | { step: "idle"; problem: string | null }
  | { step: "starting" }
  | { step: "recording" }
  | { step: "saving" }
  | SaveOutcome;

// The member's camera, shown mirrored so they see themselves as they talk: they record looking at
// themselves, so it has to be on to start. Only a preview: it never reaches the recorder, so the
// take stays audio-only. Small and front-facing.
const CAMERA: MediaTrackConstraints = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };

// What is live while recording: the microphone stream, the recorder, the clock, and what becomes
// of the take once the recorder stops (null: nothing to save).
type Media = { stream: MediaStream; recorder: MediaRecorder; timer: number; saved: Promise<SaveOutcome | null> };

// The camera while it's on. asked counts requests and is bumped whenever the camera is turned off,
// so a camera the browser grants only after that is let go.
type CameraState = { stream: MediaStream | null; asked: number };

// While the camera is off: "asking" while the browser's question about it is open (Start waits for
// the answer: Chrome won't ask this page anything else meanwhile, so the microphone's question would
// never come), or why it couldn't come on.
type CameraNote = "asking" | { problem: string } | null;

// The browser's camera question while it's open. Leaving by a link within the app keeps it open,
// and Chrome asks nothing else (the microphone included) until it's answered, so a recorder that
// mounts meanwhile waits for it too.
let cameraQuestion: Promise<void> | null = null;

function holdCameraQuestion(request: Promise<unknown>) {
  const question = request.then(
    () => {},
    () => {},
  );
  cameraQuestion = question;
  void question.then(() => {
    if (cameraQuestion === question) cameraQuestion = null;
  });
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

function cameraProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  // Chrome's words for a camera the computer itself blocks for the browser (a Mac's privacy
  // settings), and for a question closed without an answer: the site setting can't fix either.
  if (name === "NotAllowedError" && message === "Permission denied by system") {
    return "Your computer doesn't let this browser use the camera. Allow it in your computer's privacy settings (on a Mac: System Settings, Privacy & Security, Camera), then try again.";
  }
  if (name === "NotAllowedError" && message === "Permission dismissed") {
    return "The camera question was closed. Turn on your camera again, and choose Allow when asked.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access is blocked. Allow it for this site in your browser's settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found. Connect one, then try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Your camera is busy in another app. Close that app, then try again.";
  }
  return "Couldn't start the camera. Try again.";
}

function microphoneProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  // As for the camera: Chrome's words for the computer blocking the browser, and for a closed question.
  if (name === "NotAllowedError" && message === "Permission denied by system") {
    return "Your computer doesn't let this browser use the microphone. Allow it in your computer's privacy settings (on a Mac: System Settings, Privacy & Security, Microphone), then try again.";
  }
  if (name === "NotAllowedError" && message === "Permission dismissed") {
    return "The microphone question was closed. Try again, and choose Allow when asked.";
  }
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

// What the live region says for the question on screen.
function questionAnnouncement(offer: ShownOffer): string {
  if (offer.kind !== "question") return offer.text;
  return offer.id === OPENING_OFFER_ID ? `Recording. ${offer.text}` : `Follow-up question: ${offer.text}`;
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

// Stops a live recording with its save registered first, so Sign out and a return to the page wait
// for the take from the moment it stops, not only once the stop event has collected it.
function stopAndTrack(live: Media) {
  window.clearInterval(live.timer);
  void trackSave(live.saved);
  live.recorder.stop(); // onstop collects the take and saves it
}

// heldOnly: shown under a draft (see saved-take.tsx) only for a take this tab still holds, saving or
// failed, or the news that it wasn't kept; it can't start a recording, and shows nothing otherwise.
// opening: the one open question the check-in asks (page.tsx). live: live check-ins are on, so
// follow-up questions from the live coach (live/use-live-coach.ts) appear as the member talks; if
// live coaching stops working, the question on screen stays and the take carries on.
export function Recorder({
  heldOnly = false,
  opening = DEFAULT_OPENING_QUESTION,
  live = false,
}: {
  heldOnly?: boolean;
  opening?: string;
  live?: boolean;
}) {
  // The save this recorder came back to, if any (see pending-save.ts). Read once, so the first
  // render and the effect that waits for it agree even if the save settles in between.
  const [returnedTo] = useState(currentSave);
  const [state, setState] = useState<State>(() => (returnedTo ? { step: "saving" } : { step: "idle", problem: null }));
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);
  // The page was hidden, or the microphone muted, while recording, so the take may have a gap.
  const [away, setAway] = useState(false);
  const media = useRef<Media | null>(null);
  // Never waited on: the recording starts, carries on and is saved the same with or without it.
  const { view: liveView, coach } = useLiveCoach(live && !heldOnly ? { opening } : undefined);
  // The member's camera, which they need on to start: it comes on by itself when the recorder is
  // ready and the browser allows it without asking, or when they turn it on. Off once the take ends.
  const camera = useRef<CameraState>({ stream: null, asked: 0 });
  const [mirror, setMirror] = useState<MediaStream | null>(null);
  // A question an earlier recorder in this tab left open: wait for its answer too. Read once, so the
  // note and the wait agree even if it's answered in between.
  const [openQuestion] = useState(() => cameraQuestion);
  const [cameraNote, setCameraNote] = useState<CameraNote>(openQuestion ? "asking" : null);
  useEffect(() => {
    if (!openQuestion) return;
    let mounted = true;
    void openQuestion.then(() => mounted && setCameraNote((note) => (note === "asking" ? null : note)));
    return () => {
      mounted = false;
    };
  }, [openQuestion]);
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
      coach.stop();
      closeCamera(camera); // off with the take, not only once the recorder's stop event comes
      setMirror(null);
      stopAndTrack(live);
    });
  }, [recording, coach]);

  // A failed take shown here (with Try again) is safe only in this page: Sign out asks first.
  const failedShown = state.step === "failed" && !state.updated;
  useEffect(() => (failedShown ? holdFailedTake() : undefined), [failedShown]);

  // With the camera on, the recorder is a stage over the page (see CameraStage).
  const staged = mirror !== null && (state.step === "idle" || state.step === "starting" || state.step === "recording");

  // Move keyboard and screen-reader focus to each step's main button as the steps change, and as
  // the stage comes up or goes, since the button that was pressed has usually gone. Not on first
  // load, when nothing has happened (compared with the last one shown, so React's double effects
  // in development don't count).
  const step = state.step;
  const problem = state.step === "idle" ? state.problem : null;
  const shown = useRef({ step, problem, staged });
  useEffect(() => {
    const last = shown.current;
    if (last.step === step && last.problem === problem && last.staged === staged) return;
    shown.current = { step, problem, staged };
    primary.current?.focus();
  }, [step, problem, staged]);

  async function save(take: Take): Promise<SaveOutcome> {
    setState({ step: "saving" });
    const outcome = await trackSave(saveTake(take, { prepare: prepareRecording, upload, saveDraft, serverNow }));
    setState(outcome);
    return outcome;
  }

  // The camera note is left as it is: null while the camera was on, and the camera's problem after a
  // take recorded without it, so that take ends with the reason and Record without camera still there.
  function turnCameraOff() {
    closeCamera(camera);
    setMirror(null);
  }

  // ask: the member pressed Turn on my camera, so the browser may ask them. Otherwise the camera is
  // coming on by itself, as the browser allows it without asking.
  async function turnCameraOn(ask: boolean) {
    // A browser that can't record the take gets no camera, but the reason.
    if (!pickMimeType()) return setState({ step: "idle", problem: UNSUPPORTED });
    const attempt = ++camera.current.asked;
    if (ask) setCameraNote("asking");
    let stream: MediaStream;
    try {
      const request = navigator.mediaDevices.getUserMedia({ video: CAMERA });
      if (ask) holdCameraQuestion(request);
      stream = await request;
    } catch (error) {
      // Coming on by itself too: the member needs it, so they're told at once why it can't.
      if (attempt === camera.current.asked) setCameraNote({ problem: cameraProblem(error) });
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

  function showCamera() {
    if (cameraNote !== "asking") void turnCameraOn(true);
  }

  // Ready for a take, where the browser allows the camera without asking (allowed here before):
  // it comes on by itself, so the member goes straight to seeing themselves. Not while the page
  // refreshes to show a newer draft (Show my draft), which usually takes this recorder away, nor
  // while a camera question is open or a camera problem shows (Turn on my camera tries again); so
  // once a question an earlier visit left open is answered Allow, it comes on.
  const ready = state.step === "idle" && !heldOnly && !refreshing && cameraNote === null;
  // asked unchanged: nothing turned the camera on or off meanwhile (the member's Turn on included).
  const cameraByItself = useEffectEvent((asked: number) => {
    if (camera.current.asked === asked) void turnCameraOn(false);
  });
  useEffect(() => {
    if (!ready || camera.current.stream) return;
    const asked = camera.current.asked;
    let current = true;
    void cameraAllowed().then((allowed) => {
      if (current && allowed) cameraByItself(asked);
    });
    return () => {
      current = false;
    };
  }, [ready]);

  // Finish, or the ten-minute limit.
  function finish() {
    const live = media.current;
    if (!live || live.recorder.state === "inactive") return;
    setState({ step: "saving" });
    coach.stop();
    turnCameraOff(); // off with the take, not only once the recorder's stop event comes
    stopAndTrack(live);
  }

  // withoutCamera: Record without camera, offered only when the camera can't come on. Otherwise the
  // member records looking at themselves.
  async function start(withoutCamera = false) {
    if (!camera.current.stream && !withoutCamera) return;
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
    // The camera went away while the browser asked about the microphone: the take hasn't begun, so
    // the member turns the camera on again, or chooses to record without it.
    if (!withoutCamera && !camera.current.stream) {
      stream.getTracks().forEach((track) => track.stop());
      setCameraNote({ problem: CAMERA_STOPPED });
      return setState({ step: "idle", problem: null });
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
      coach.stop();
      turnCameraOff();
      settle(null);
      setState({ step: "idle", problem: "The recording stopped unexpectedly. Try again." });
    };
    recorder.onstop = () => {
      const durationMs = Date.now() - startedAt;
      release(media);
      // Ended already by Finish or by leaving the page; this gives the take its session.
      const liveSessionId = coach.stop();
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
        liveSessionId,
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
    // Only now asks for a live session (leaving the page stops it), so a refused or abandoned
    // microphone prompt starts none.
    coach.begin();
    coach.attach(stream);
    setState({ step: "recording" });
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

  // The question on screen while recording: the live coach's, with the areas touched on while
  // follow-ups are coming; once live coaching has stopped working, the one it last showed; without
  // live check-ins, the opening question.
  const coached = liveView?.mode === "live" ? liveView : null;
  const fellBack = liveView?.mode === "fallback";
  const offer = liveView?.offer ?? openingOffer(opening);
  const announcement =
    state.step === "idle"
      ? cameraNote === "asking"
        ? CAMERA_ASKING
        : "" // a camera problem is announced by its own alert, as a microphone problem is
      : state.step === "starting"
        ? "Waiting for your microphone…"
        : state.step === "recording"
          ? questionAnnouncement(offer)
          : state.step === "saving"
            ? "Saving your recording…"
            : state.step === "saved"
              ? "Saved."
              : "";
  if (heldOnly && state.step !== "saving" && state.step !== "failed" && state.step !== "superseded") return null;
  // Kept on screen until the take is saved (or can't be). In the live region it is a node of its
  // own, so it is announced when it appears and not again with every later step.
  const awayNote = away && unsaved;
  // Said once, quietly, as follow-ups stop.
  const fellBackNote = state.step === "recording" && fellBack;
  // A node of its own in the live region too, so a question shown in the last minute is still read.
  const lastMinute = state.step === "recording" && elapsedMs >= WARN_MS;

  return (
    <div className="grid gap-4">
      <p aria-live="polite" className="sr-only">
        <span>{announcement}</span>
        {lastMinute && <span> {LAST_MINUTE}</span>}
        {awayNote && <span> {AWAY}</span>}
        {fellBackNote && <span> {FELL_BACK}</span>}
      </p>

      {awayNote && !staged && <p className="rounded-md bg-muted px-3 py-2 text-sm">{AWAY}</p>}

      {/* Not under the stage, which says it all itself: screen readers would find it there twice. */}
      {state.step === "idle" && !staged && (
        <>
          {live ? (
            <p className="text-sm leading-6">
              We&apos;ll start with one question. As you talk, a follow-up question may appear when you
              pause. Answer it if you like, or tap Different question. A few minutes is plenty; the
              recording stops at 10 minutes. You can listen back before you submit.
            </p>
          ) : (
            <p className="text-sm leading-6">
              There&apos;s one question. Answer it out loud, in your own words, then press Finish. A few
              minutes is plenty; the recording stops at 10 minutes. You can listen back before you submit.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            You record with your camera on, so you see yourself as you talk. Only your voice is recorded;
            the picture isn&apos;t saved.
          </p>
          <p className="text-lg leading-snug">{opening}</p>
        </>
      )}

      {state.step === "idle" && !staged && (
        <>
          {state.problem && (
            <p role="alert" className="text-sm text-destructive">
              {state.problem}
            </p>
          )}
          {cameraNote !== null && cameraNote !== "asking" && (
            <p role="alert" className="text-sm text-destructive">
              {cameraNote.problem}
            </p>
          )}
          <Button
            ref={primary}
            type="button"
            onClick={showCamera}
            disabled={refreshing}
            aria-disabled={cameraNote === "asking"}
            className="justify-self-start"
          >
            <Camera aria-hidden="true" />
            {cameraNote === "asking" ? "Waiting for your camera…" : "Turn on my camera"}
          </Button>
          {cameraNote === "asking" && <p className="text-sm text-muted-foreground">{CAMERA_ASKING}</p>}
          {/* The way round a camera that can't come on (blocked, missing, busy): the take, in this card. */}
          {cameraNote !== null && cameraNote !== "asking" && (
            <Button
              type="button"
              variant="link"
              onClick={() => void start(true)}
              disabled={refreshing}
              className="justify-self-start px-0 underline"
            >
              Record without camera
            </Button>
          )}
        </>
      )}

      {state.step === "starting" && !staged && (
        <p className="flex items-center gap-2 text-sm">
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          Waiting for your microphone…
        </p>
      )}

      {state.step === "recording" && !staged && (
        <>
          <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
            <span>Recording</span>
            <span className="flex items-center gap-2 font-mono tabular-nums">
              <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-destructive" />
              <span role="timer" aria-label="Time recorded">
                {formatClock(elapsedMs)}
              </span>
            </span>
          </div>
          <LivePrompt
            offer={offer}
            touched={coached?.touched ?? null}
            canSkip={canSkip(liveView)}
            onSkip={coach.skip}
            onFinish={finish}
            finishRef={primary}
          >
            {fellBackNote && <p className="text-sm text-muted-foreground">{FELL_BACK}</p>}
            {lastMinute && <p className="rounded-md bg-muted px-3 py-2 text-sm">{LAST_MINUTE}</p>}
          </LivePrompt>
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

      {staged && (
        <CameraStage
          stream={mirror}
          top={
            state.step === "recording" && (
              <>
                <span className={STAGE_PILL}>Recording</span>
                <span className={`${STAGE_PILL} flex items-center gap-2 font-mono tabular-nums`}>
                  <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-destructive" />
                  <span role="timer" aria-label="Time recorded">
                    {formatClock(elapsedMs)}
                  </span>
                </span>
              </>
            )
          }
        >
          {state.step === "idle" && (
            <>
              <p className="text-2xl leading-snug font-medium sm:text-3xl">Ready when you are.</p>
              <p className="text-lg leading-snug">{opening}</p>
              <p className="text-sm text-white/75">
                {live
                  ? "We'll start with this question; follow-ups may appear when you pause."
                  : "Answer it out loud, then press Finish."}{" "}
                Only your voice is recorded; the picture isn&apos;t saved.
              </p>
              {state.problem && (
                <p role="alert" className="text-sm font-medium">
                  {state.problem}
                </p>
              )}
              <Button
                ref={primary}
                type="button"
                onClick={() => void start()}
                disabled={refreshing}
                className={`${ON_STAGE_MAIN} justify-self-start`}
              >
                <Mic aria-hidden="true" />
                Start recording
              </Button>
            </>
          )}
          {state.step === "starting" && (
            <p className="flex items-center gap-2 text-lg">
              <LoaderCircle aria-hidden="true" className="animate-spin" />
              Waiting for your microphone…
            </p>
          )}
          {state.step === "recording" && (
            <LivePrompt
              offer={offer}
              touched={coached?.touched ?? null}
              canSkip={canSkip(liveView)}
              onSkip={coach.skip}
              onFinish={finish}
              finishRef={primary}
              onStage
            >
              {fellBackNote && <p className="text-sm text-white/75">{FELL_BACK}</p>}
              {lastMinute && <p className="text-sm text-white/80">{LAST_MINUTE}</p>}
              {awayNote && <p className="text-sm text-white/80">{AWAY}</p>}
            </LivePrompt>
          )}
        </CameraStage>
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
