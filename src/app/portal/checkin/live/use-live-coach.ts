// The live coach beside the recorder: while the member records, their speech is transcribed live
// (transport.ts), the transcript so far goes to the coach every few seconds (api.ts), and the
// question it picks is shown when they pause (pacing.ts). The recording itself never waits on any
// of this, and anything going wrong ends live coaching for the rest of the take: the recorder then
// shows the three fixed questions, exactly as without live check-ins.
//
// createLiveCoach is the whole flow over plain callbacks, with its browser parts passed in (the
// start, coach and end calls, the transcription connection, the level meter and the clock), so it
// runs in tests with fakes and fake timers. useLiveCoach gives it to the recorder.
// Nothing here logs or keeps what was said beyond the transcript it sends to the coach, and the
// short-lived transcription key goes only to the transport.

import { useEffect, useState } from "react";
import type { Pacing, Touched } from "@/lib/coach/types";
import { askCoach, endLive, isLiveStartReady, startLive } from "./api";
import { MAX_TRANSCRIPT_CHARS, type CoachResponse, type LiveErrorCode, type LiveStartResponse, type ShownOffer } from "./contract";
import {
  CONNECT_TIMEOUT_MS,
  liveClock,
  MAX_COACH_FAILURES_IN_A_ROW,
  NO_TEXT_WHILE_SPEAKING_MS,
  shouldCommit,
  shouldRead,
  shouldShow,
} from "./pacing";
import { applyEvent, emptyTranscript, transcriptText, wordCount, type LiveTranscript, type TranscriptEvent } from "./transcript";
import { connectLiveTranscription, type LiveConnection } from "./transport";
import { emptyVoice, silenceMs, spokenMs, startLevelMeter, voiceStep, type Voice } from "./voice";

// What the page passes when live check-ins are on (page.tsx): the opening question, shown before
// Start is pressed and until the first follow-up.
export type LiveOptions = { opening: string };

// What the recorder shows: live questions (what is on screen, and which areas they have touched
// on), or the fixed questions once live coaching has stopped working.
export type LiveView = { mode: "live"; offer: ShownOffer; touched: Touched } | { mode: "fallback" };

export type LiveCoachDeps = {
  start: () => Promise<LiveStartResponse | null>;
  connect: typeof connectLiveTranscription;
  ask: typeof askCoach;
  end: typeof endLive;
  meter: typeof startLevelMeter;
  // The clock every pacing time is measured on (liveClock).
  now: () => number;
};

const LIVE_COACH_DEPS: LiveCoachDeps = {
  start: () => startLive(),
  connect: connectLiveTranscription,
  ask: askCoach,
  end: endLive,
  meter: startLevelMeter,
  now: liveClock,
};

// The opening question is offer 0 (OPENING_OFFER_ID in src/lib/coach/policy.ts, which is server
// code and stays out of the browser bundle).
export const OPENING_OFFER_ID = 0;
// How often the recorder ends turns, asks the coach and shows what it offered.
export const TICK_MS = 250;
// The level meter samples every 50 ms; none at all in this long means the browser has no Web Audio,
// and without it nothing knows when they pause.
export const METER_WAIT_MS = 3000;
// A coach call that hasn't answered in this long counts as failed, so one lost request can't hold
// up every later one.
export const COACH_TIMEOUT_MS = 15_000;
// The coach route turns away a call less than a second after the last (MIN_COACH_INTERVAL_MS in
// live-sessions.ts); a little more here, so a quick "Different question" isn't turned away.
export const MIN_ASK_GAP_MS = 1200;

// Answers that will never change for this take: carry on with the fixed questions straight away.
const FINAL: readonly LiveErrorCode[] = ["submitted", "session_over", "no_session", "signed_out", "no_member", "too_many_calls"];

const NOTHING_TOUCHED: Touched = { activity: false, excellence: false, morale: false };

function openingOffer(opening: string): ShownOffer {
  return { id: OPENING_OFFER_ID, kind: "question", text: opening };
}

export function openingView(opening: string): LiveView {
  return { mode: "live", offer: openingOffer(opening), touched: NOTHING_TOUCHED };
}

// Whether "Different question" is offered: only for a follow-up question, never for the opening
// question or a closing line.
export function canSkip(view: LiveView | null): boolean {
  return view?.mode === "live" && view.offer.kind === "question" && view.offer.id !== OPENING_OFFER_ID;
}

export type LiveCoachController = {
  // Start was pressed: asks for a live session while the microphone is set up.
  begin(): void;
  // The recording has started with this stream: transcribe it live (a copy of its track).
  attach(stream: MediaStream): void;
  // "Different question".
  skip(): void;
  // The take has ended (or the page is going): stops everything and ends the session, once.
  // Returns the session's id for the take, or null; safe to call again, with the same answer.
  stop(): string | null;
};

type Timer = ReturnType<typeof setTimeout>;

// One take's live coaching, from Start to stop.
type Run = {
  stopped: boolean;
  // Gave up on live coaching for this take.
  fallen: boolean;
  abort: AbortController;
  sessionId: string | null;
  // The short-lived transcription key, until it is handed to the transport.
  secret: string | null;
  pacing: Pacing | null;
  endSent: boolean;
  stream: MediaStream | null;
  // When the recording started, on the live clock.
  startedAt: number;
  connecting: boolean;
  connection: LiveConnection | null;
  connectedAt: number | null;
  closedAt: number | null;
  deadline: Timer | null;
  ticker: ReturnType<typeof setInterval> | null;
  stopMeter: (() => void) | null;
  sampled: boolean;
  voice: Voice;
  transcript: LiveTranscript;
  text: string;
  words: number;
  // How much they had spoken when text last came back, and at the last commit.
  spokenAtText: number;
  spokenAtCommit: number;
  lastCommitAt: number;
  reads: number;
  lastReadAt: number | null;
  wordsAtLastRead: number;
  lastAskAt: number | null;
  // The coach call in flight (one at a time), numbered so a late answer is recognised.
  call: { seq: number; controller: AbortController; timer: Timer } | null;
  seq: number;
  failures: number;
  // The offer they asked to replace with "Different question", until that call is sent.
  skipWanted: number | null;
  // The coach's latest offer, waiting for a pause, and when the read behind it was asked for.
  pending: { offer: ShownOffer; requestedAt: number } | null;
  shown: ShownOffer;
  shownAt: number;
  wordsAtShown: number;
  touched: Touched;
};

function newRun(opening: string): Run {
  return {
    stopped: false,
    fallen: false,
    abort: new AbortController(),
    sessionId: null,
    secret: null,
    pacing: null,
    endSent: false,
    stream: null,
    startedAt: 0,
    connecting: false,
    connection: null,
    connectedAt: null,
    closedAt: null,
    deadline: null,
    ticker: null,
    stopMeter: null,
    sampled: false,
    voice: emptyVoice(),
    transcript: emptyTranscript(),
    text: "",
    words: 0,
    spokenAtText: 0,
    spokenAtCommit: 0,
    lastCommitAt: 0,
    reads: 0,
    lastReadAt: null,
    wordsAtLastRead: 0,
    lastAskAt: null,
    call: null,
    seq: 0,
    failures: 0,
    skipWanted: null,
    pending: null,
    shown: openingOffer(opening),
    shownAt: 0,
    wordsAtShown: 0,
    touched: NOTHING_TOUCHED,
  };
}

export function createLiveCoach({
  opening,
  deps,
  onView,
}: {
  opening: string;
  deps: LiveCoachDeps;
  onView: (view: LiveView) => void;
}): LiveCoachController {
  let run: Run | null = null;

  const active = (r: Run) => run === r && !r.stopped && !r.fallen;

  function publish(r: Run) {
    onView({ mode: "live", offer: r.shown, touched: r.touched });
  }

  // Stops the transport, the meter, the tick and any coach call. The session itself is ended
  // separately (endSession), once.
  function shutdown(r: Run) {
    if (r.ticker !== null) clearInterval(r.ticker);
    if (r.deadline !== null) clearTimeout(r.deadline);
    r.ticker = null;
    r.deadline = null;
    r.stopMeter?.();
    r.stopMeter = null;
    if (r.call) {
      clearTimeout(r.call.timer);
      r.call.controller.abort();
      r.call = null;
    }
    r.abort.abort();
    if (r.connection) {
      r.connection.close();
      r.connection = null;
      r.closedAt = deps.now();
    }
    r.secret = null;
  }

  // Ends the session with how long live transcription heard the recording (for its cost), once.
  function endSession(r: Run) {
    if (r.sessionId === null || r.endSent) return;
    r.endSent = true;
    const heardMs = r.connectedAt === null ? 0 : Math.max(0, (r.closedAt ?? deps.now()) - r.connectedAt);
    deps.end({ sessionId: r.sessionId, recordedMs: Math.round(heardMs), shown: r.shown.id });
  }

  // One way, for the rest of the take: the recorder shows the fixed questions from the first.
  function fallback(r: Run) {
    if (!active(r)) return;
    r.fallen = true;
    shutdown(r);
    endSession(r);
    onView({ mode: "fallback" });
  }

  function failed(r: Run) {
    r.failures += 1;
    if (r.failures >= MAX_COACH_FAILURES_IN_A_ROW) fallback(r);
  }

  // Live transcription must be connected this long after the recording starts (or after the key
  // arrives, if that was later).
  function armDeadline(r: Run) {
    if (r.deadline !== null) clearTimeout(r.deadline);
    r.deadline = setTimeout(() => {
      r.deadline = null;
      if (!r.connection) fallback(r);
    }, CONNECT_TIMEOUT_MS);
  }

  function started(r: Run, response: LiveStartResponse | null) {
    if (!active(r)) {
      // Answered after the take ended, or after live coaching was given up: nothing will use it.
      if (isLiveStartReady(response)) deps.end({ sessionId: response.sessionId, recordedMs: 0, shown: null });
      return;
    }
    if (!isLiveStartReady(response)) return fallback(r);
    r.sessionId = response.sessionId;
    r.secret = response.clientSecret;
    r.pacing = response.pacing;
    connect(r);
  }

  // Once there is both a key and a stream.
  function connect(r: Run) {
    const { stream, secret } = r;
    if (!stream || !secret || r.connecting || !active(r)) return;
    r.connecting = true;
    r.secret = null;
    armDeadline(r);
    deps
      .connect({
        stream,
        clientSecret: secret,
        signal: r.abort.signal,
        onEvent: (event) => heard(r, event),
        onFailure: () => fallback(r),
      })
      .then(
        (connection) => {
          if (!active(r)) return connection.close();
          const at = deps.now();
          r.connection = connection;
          r.connectedAt = at;
          // Speech before now never reached the transcription, so none of it is waiting for a commit
          // or owed any text.
          r.lastCommitAt = at;
          r.spokenAtCommit = spokenMs(r.voice, at);
          r.spokenAtText = r.spokenAtCommit;
          if (r.deadline !== null) clearTimeout(r.deadline);
          r.deadline = null;
        },
        () => fallback(r),
      );
  }

  function heard(r: Run, event: TranscriptEvent) {
    if (!active(r)) return;
    const next = applyEvent(r.transcript, event);
    if (next === r.transcript) return;
    r.transcript = next;
    const text = transcriptText(next);
    if (text === r.text) return;
    r.text = text;
    r.words = wordCount(text);
    r.spokenAtText = spokenMs(r.voice, deps.now());
  }

  function show(r: Run, offer: ShownOffer) {
    r.shown = offer;
    r.shownAt = deps.now();
    r.wordsAtShown = r.words;
    r.pending = null;
    publish(r);
  }

  async function ask(r: Run, skip: number | null) {
    const sessionId = r.sessionId;
    if (sessionId === null) return;
    const at = deps.now();
    const seq = ++r.seq;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (r.call?.seq !== seq) return;
      r.call = null;
      controller.abort();
      if (active(r)) failed(r);
    }, COACH_TIMEOUT_MS);
    r.call = { seq, controller, timer };
    r.lastAskAt = at;
    if (skip === null) {
      r.reads += 1;
      r.lastReadAt = at;
      r.wordsAtLastRead = r.words;
    } else {
      r.skipWanted = null;
    }
    // The newest speech matters most; a transcript this long is well past ten minutes anyway.
    const transcript = r.text.length > MAX_TRANSCRIPT_CHARS ? r.text.slice(-MAX_TRANSCRIPT_CHARS) : r.text;
    let response: CoachResponse | null;
    try {
      response = await deps.ask(
        { sessionId, transcript, elapsedMs: Math.max(0, Math.round(at - r.startedAt)), shown: r.shown.id, skip },
        controller.signal,
      );
    } catch {
      response = null;
    }
    // Timed out or stopped meanwhile: this answer is older than what has happened since.
    if (r.call?.seq !== seq) return;
    clearTimeout(timer);
    r.call = null;
    if (active(r)) answer(r, response, at, skip);
  }

  function answer(r: Run, response: CoachResponse | null, requestedAt: number, skip: number | null) {
    if (response === null) return failed(r);
    if (response.status === "error") {
      // Too soon after the last call: a "Different question" waits a moment and goes again.
      if (response.code === "too_soon") {
        if (skip !== null && r.skipWanted === null && r.shown.id === skip) r.skipWanted = skip;
        return;
      }
      if (FINAL.includes(response.code)) return fallback(r);
      return failed(r);
    }
    const touchedNow = !sameTouched(r.touched, response.touched);
    if (touchedNow) r.touched = response.touched;
    // Claude's read failed (the offer comes from what was known before, so it can still be shown).
    if (response.degraded) {
      failed(r);
      if (!active(r)) return;
    } else {
      r.failures = 0;
    }
    const offer = response.offer && response.offer.id !== r.shown.id ? response.offer : null;
    // They asked for a different question: it replaces the one on screen straight away.
    if (skip !== null && offer && r.shown.id === skip) return show(r, offer);
    // A "Different question" waiting to be sent answers instead of this.
    if (skip === null) r.pending = offer && r.skipWanted === null ? { offer, requestedAt } : null;
    if (touchedNow) publish(r);
  }

  function tick(r: Run) {
    if (!active(r)) return;
    const at = deps.now();
    if (!r.sampled) {
      if (at - r.startedAt >= METER_WAIT_MS) fallback(r);
      return;
    }
    const { connection, pacing } = r;
    if (!connection || !pacing) return;
    const silence = silenceMs(r.voice, at);
    const spoken = spokenMs(r.voice, at);

    if (
      shouldCommit({ now: at, silenceMs: silence, speechSinceCommitMs: spoken - r.spokenAtCommit, lastCommitAt: r.lastCommitAt })
    ) {
      connection.commit();
      r.lastCommitAt = at;
      r.spokenAtCommit = spoken;
    }
    // They have been talking and nothing has come back: live transcription isn't working.
    if (spoken - r.spokenAtText >= NO_TEXT_WHILE_SPEAKING_MS) return fallback(r);

    // The question they wanted replaced has gone from the screen meanwhile.
    if (r.skipWanted !== null && r.skipWanted !== r.shown.id) r.skipWanted = null;
    if (!r.call && (r.lastAskAt === null || at - r.lastAskAt >= MIN_ASK_GAP_MS)) {
      if (r.skipWanted !== null) {
        void ask(r, r.skipWanted);
      } else if (
        shouldRead({
          now: at,
          silenceMs: silence,
          words: r.words,
          wordsAtLastRead: r.wordsAtLastRead,
          lastReadAt: r.lastReadAt,
          inFlight: false,
          reads: r.reads,
          ended: false,
        })
      ) {
        void ask(r, null);
      }
    }

    if (
      r.pending &&
      r.skipWanted === null &&
      shouldShow({
        now: at,
        speaking: r.voice.speaking,
        silenceMs: silence,
        pacing,
        shownAt: r.shownAt,
        wordsSinceShown: r.words - r.wordsAtShown,
        elapsedMs: at - r.startedAt,
        onOpening: r.shown.id === OPENING_OFFER_ID,
        offerRequestedAt: r.pending.requestedAt,
      })
    ) {
      show(r, r.pending.offer);
    }
  }

  function stop(): string | null {
    const r = run;
    if (!r) return null;
    if (!r.stopped) {
      r.stopped = true;
      if (!r.fallen) shutdown(r);
      endSession(r);
    }
    return r.sessionId;
  }

  return {
    begin() {
      stop();
      const r = newRun(opening);
      run = r;
      publish(r);
      // Not cancelled if the take ends first: the session it starts is then ended at once, rather
      // than left for the daily job.
      deps.start().then(
        (response) => started(r, response),
        () => started(r, null),
      );
    },

    attach(stream) {
      const r = run;
      if (!r || r.stopped || r.stream) return;
      r.stream = stream;
      if (r.fallen) return;
      const at = deps.now();
      r.startedAt = at;
      r.shownAt = at;
      r.lastCommitAt = at;
      r.stopMeter = deps.meter(stream, (level, sampledAt) => {
        if (!active(r)) return;
        r.sampled = true;
        r.voice = voiceStep(r.voice, { level, now: sampledAt });
      });
      r.ticker = setInterval(() => tick(r), TICK_MS);
      armDeadline(r);
      connect(r);
    },

    skip() {
      const r = run;
      if (!r || !active(r) || r.skipWanted !== null) return;
      if (r.shown.kind !== "question" || r.shown.id === OPENING_OFFER_ID) return;
      r.skipWanted = r.shown.id;
      r.pending = null;
      // At once, unless a call is already on its way (then as soon as it answers).
      if (!r.call && (r.lastAskAt === null || deps.now() - r.lastAskAt >= MIN_ASK_GAP_MS)) void ask(r, r.skipWanted);
    },

    stop,
  };
}

// An answer that touches nothing new doesn't re-render the recorder.
function sameTouched(a: Touched, b: Touched): boolean {
  return a.activity === b.activity && a.excellence === b.excellence && a.morale === b.morale;
}

// Without live check-ins: nothing to start, and no session for the take.
const OFF: LiveCoachController = { begin() {}, attach() {}, skip() {}, stop: () => null };

// The live coach for one recorder: what to show (null without live check-ins), and the controller,
// which stays the same object for the recorder's life. `live` and `deps` (the browser parts,
// replaced in tests) are read once.
export function useLiveCoach(
  live: LiveOptions | undefined,
  deps?: Partial<LiveCoachDeps>,
): { view: LiveView | null; coach: LiveCoachController } {
  const [view, setView] = useState<LiveView | null>(() => (live ? openingView(live.opening) : null));
  const [coach] = useState<LiveCoachController>(() =>
    live ? createLiveCoach({ opening: live.opening, deps: { ...LIVE_COACH_DEPS, ...deps }, onView: setView }) : OFF,
  );
  // Leaving the page ends the session (the recorder finishes the take itself, see recorder.tsx), and
  // so does closing the tab, which never unmounts anything: endLive is sent with keepalive for that.
  useEffect(() => {
    const leave = () => void coach.stop();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      coach.stop();
    };
  }, [coach]);
  return { view, coach };
}
