// The live coach beside the recorder: while the member records, their speech is transcribed live
// (transport.ts), the transcript so far goes to the coach every few seconds (api.ts), and the
// question it picks is shown when they pause (pacing.ts). The recording itself never waits on any
// of this, and anything going wrong ends live coaching for the rest of the take: the recorder then
// keeps the question on screen, with no more follow-ups, as without live check-ins, and the end call
// says what went wrong, as a code.
//
// createLiveCoach is the whole flow over plain callbacks, with its browser parts passed in (the
// start, coach and end calls, the transcription connection, the level meter and the clock), so it
// runs in tests with fakes and fake timers. useLiveCoach gives it to the recorder.
// Nothing here logs or keeps what was said beyond the transcript it sends to the coach. No key ever
// reaches the browser: the transport's WebRTC offer goes to the connect route, and the server opens
// the transcription.

import { useEffect, useState } from "react";
import type { Pacing, Touched } from "@/lib/coach/types";
import { askCoach, connectLive, endLive, isLiveStartReady, startLive } from "./api";
import {
  MAX_TRANSCRIPT_CHARS,
  type CoachResponse,
  type FallbackReason,
  type LiveErrorCode,
  type LiveStartResponse,
  type ShownOffer,
} from "./contract";
import {
  CONNECT_TIMEOUT_MS,
  followUpStatus,
  heardSinceRead,
  liveClock,
  MAX_COACH_FAILURES_IN_A_ROW,
  MAX_READS,
  NO_TEXT_WHILE_SPEAKING_MS,
  questionHadItsTime,
  questionTime,
  RENEW_AFTER_MS,
  rereadDue,
  shouldCommit,
  shouldRead,
  shouldShow,
  TEXT_WAIT_MS,
  type BusyStatus,
  type FollowUpStatus,
} from "./pacing";
import { applyEvent, emptyTranscript, transcriptText, wordCount, type LiveTranscript, type TranscriptEvent } from "./transcript";
import { connectLiveTranscription, type LiveConnection } from "./transport";
import { emptyVoice, silenceMs, spokenMs, startLevelMeter, voiceStep, type Voice } from "./voice";

// What the page passes when live check-ins are on (page.tsx): the opening question, shown before
// Start is pressed and until the first follow-up.
export type LiveOptions = { opening: string };

// What the recorder shows: live questions (what is on screen, which areas they have touched on, and
// what they are told is coming: followUpStatus in pacing.ts), or, once live coaching has stopped
// working, the question that was on screen, kept there, and whether live transcription had connected
// (started) before it stopped.
export type LiveView =
  | { mode: "live"; offer: ShownOffer; touched: Touched; status: FollowUpStatus }
  | { mode: "fallback"; offer: ShownOffer; started: boolean };

export type LiveCoachDeps = {
  start: () => Promise<LiveStartResponse | null>;
  connect: typeof connectLiveTranscription;
  // The session's WebRTC offer to the server, OpenAI's answer back.
  exchange: typeof connectLive;
  ask: typeof askCoach;
  end: typeof endLive;
  meter: typeof startLevelMeter;
  // The clock every pacing time is measured on (liveClock).
  now: () => number;
};

const LIVE_COACH_DEPS: LiveCoachDeps = {
  start: () => startLive(),
  connect: connectLiveTranscription,
  exchange: connectLive,
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

// Answers that will never change for this take: carry on without follow-ups straight away.
const FINAL: readonly LiveErrorCode[] = ["submitted", "session_over", "no_session", "signed_out", "no_member", "too_many_calls"];

const NOTHING_TOUCHED: Touched = { activity: false, excellence: false, morale: false };

export function openingOffer(opening: string): ShownOffer {
  return { id: OPENING_OFFER_ID, kind: "question", text: opening };
}

export function openingView(opening: string): LiveView {
  return { mode: "live", offer: openingOffer(opening), touched: NOTHING_TOUCHED, status: "starting" };
}

// Whether "Different question" is offered: only for a follow-up question, never for the opening
// question or a closing line.
export function canSkip(view: LiveView | null): boolean {
  return view?.mode === "live" && view.offer.kind === "question" && view.offer.id !== OPENING_OFFER_ID;
}

export type LiveCoachController = {
  // The recording has started: asks for a live session (never while the browser's microphone prompt
  // is open, so a refused microphone starts none). attach follows at once.
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

// When a read was asked for, and how much they had said by then: words of text, time spoken (some
// of it may not have come back as text yet), and turns whose transcription had failed; whether it
// was a held offer's one read to confirm it (its own offer is then never held); and whether it
// renews a question lined up to show (RENEW_AFTER_MS).
type ReadAsked = { requestedAt: number; words: number; spokenAt: number; lost: number; confirms: boolean; renews: boolean };

// The coach's latest offer, waiting for a pause, with the read behind it, and whether a follow-up
// question can still come once it is on screen (the coach call's more).
type Pending = { offer: ShownOffer; more: boolean } & ReadAsked;

// A read's options: reread asks the server to read any new words with Claude, however few (they
// may answer what an offer asks); confirms marks a held offer's one read to confirm it, and renews
// a read that renews a question lined up to show (its offer is never held either).
type ReadOptions = { reread: boolean; confirms: boolean; renews: boolean };
const PLAIN_READ: ReadOptions = { reread: false, confirms: false, renews: false };

// One take's live coaching, from Start to stop.
type Run = {
  stopped: boolean;
  // Gave up on live coaching for this take, and why (sent with the end call).
  fallen: boolean;
  fallenWhy: FallbackReason | null;
  abort: AbortController;
  sessionId: string | null;
  pacing: Pacing | null;
  endSent: boolean;
  stream: MediaStream | null;
  // When the recording started, on the live clock, and when the start answered (questionTime).
  startedAt: number;
  startAnsweredAt: number | null;
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
  // Turns ended (commits), turns whose text has come back in full or failed, and those that failed.
  commits: number;
  turnsBack: number;
  turnsLost: number;
  reads: number;
  lastReadAt: number | null;
  wordsAtLastRead: number;
  lastAskAt: number | null;
  // The coach call in flight (one at a time), numbered so a late answer is recognised; skip: the
  // offer a "Different question" replaces, null for a read; renews: a read that renews a
  // question lined up to show, which never holds it back.
  call: { seq: number; controller: AbortController; timer: Timer; skip: number | null; renews: boolean } | null;
  seq: number;
  failures: number;
  // The offer they asked to replace with "Different question", until that call is sent, and when
  // they pressed it.
  skipWanted: number | null;
  skippedAt: number;
  // A held offer was dropped before what they said after its read came back as text: the next read
  // asks the server to read that with Claude, so it doesn't offer the same again from what it knew.
  rereadOwed: boolean;
  pending: Pending | null;
  shown: ShownOffer;
  shownAt: number;
  wordsAtShown: number;
  touched: Touched;
  // Whether a later read can still bring a follow-up question with the offer on screen, as the
  // coach last said (moreToAsk in src/lib/coach/policy.ts).
  more: boolean;
  // What the line under the question last said (publish), and since when it has said checking or
  // ready.
  status: FollowUpStatus;
  busySince: number | null;
  // The question on screen has had its time (questionHadItsTime): kept once true until the next
  // question shows: the word count can dip as a turn's draft text is replaced by its final text.
  hadItsTime: boolean;
};

function newRun(opening: string): Run {
  return {
    stopped: false,
    fallen: false,
    fallenWhy: null,
    abort: new AbortController(),
    sessionId: null,
    pacing: null,
    endSent: false,
    stream: null,
    startedAt: 0,
    startAnsweredAt: null,
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
    commits: 0,
    turnsBack: 0,
    turnsLost: 0,
    reads: 0,
    lastReadAt: null,
    wordsAtLastRead: 0,
    lastAskAt: null,
    call: null,
    seq: 0,
    failures: 0,
    skipWanted: null,
    skippedAt: 0,
    rereadOwed: false,
    pending: null,
    shown: openingOffer(opening),
    shownAt: 0,
    wordsAtShown: 0,
    touched: NOTHING_TOUCHED,
    more: true,
    status: "starting",
    busySince: null,
    hadItsTime: false,
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

  function publish(r: Run, status?: FollowUpStatus) {
    const at = deps.now();
    r.status = status ?? statusOf(r, at);
    r.busySince = isBusy(r.status) ? (r.busySince ?? at) : null;
    onView({ mode: "live", offer: r.shown, touched: r.touched, status: r.status });
  }

  // What the line under the question says now (followUpStatus).
  function statusOf(r: Run, at: number): FollowUpStatus {
    // Only once connected: a start that answers before the recording is attached can't latch it.
    if (r.connection && r.pacing && !r.hadItsTime) {
      r.hadItsTime = questionHadItsTime({
        now: at,
        pacing: r.pacing,
        shownAt: r.shownAt,
        wordsSinceShown: r.words - r.wordsAtShown,
        elapsedMs: at - r.startedAt,
        onOpening: r.shown.id === OPENING_OFFER_ID,
      });
    }
    const time = (when: number) =>
      questionTime({ now: when, startedAt: r.startedAt, startAnsweredAt: r.startAnsweredAt, limitMs: r.pacing?.noNewQuestionsAfterMs });
    // Only from a read asked for since the question on screen appeared, as shouldShow. A question is
    // lined up only once nothing can stop it showing as it is: one held for what they have said since
    // is read again first, and a newer read out replaces it or drops it (shouldShow), so either may
    // bring another question, a closing line or nothing; and one they are talking over may be held a
    // moment later. That goes for a read renewing it too: it doesn't hold the question back (should
    // they pause first, it shows), but its answer may drop it. Once the time for new questions may be
    // over, a read again may only bring "Time is nearly up".
    const pending = r.pending && r.pending.requestedAt >= r.shownAt ? r.pending : null;
    const newerRead = r.call !== null && r.call.skip === null;
    const lined = (p: Pending) =>
      !holding(r, p, at).held && !newerRead && !(mayHold(r, p) && r.voice.speaking && spokenMs(r.voice, at) > p.spokenAt);
    const waiting =
      pending === null
        ? null
        : pending.offer.kind !== "question"
          ? "closing"
          : lined(pending)
            ? "question"
            : time(at) === "open"
              ? "held"
              : null;
    // A "Different question" for the question on screen (a repeat press, or one left over from the
    // question before, doesn't count), or a read that could still bring a question back: not one
    // asked for before the question on screen appeared (a read renewing it, which then brings nothing).
    const skipping = r.skipWanted === r.shown.id || r.call?.skip === r.shown.id;
    const readAt =
      r.call?.skip === null && r.more && r.lastAskAt !== null && r.lastAskAt >= r.shownAt && time(r.lastAskAt) !== "over" ? r.lastAskAt : null;
    return followUpStatus({
      connected: r.connection !== null,
      closingShown: r.shown.kind !== "question",
      waiting,
      call: skipping ? { ms: at - r.skippedAt, skip: true } : readAt !== null ? { ms: at - readAt, skip: false } : null,
      busy: r.busySince !== null && isBusy(r.status) ? { status: r.status, ms: at - r.busySince } : null,
      due: r.hadItsTime,
      paused: r.pacing !== null && !r.voice.speaking && silenceMs(r.voice, at) >= r.pacing.showAfterSilenceMs,
      moreToCome: r.more && r.reads < MAX_READS && time(at) !== "over",
    });
  }

  // Whether they have said more since the read behind the waiting offer (heard), and so it waits for
  // a read that has heard them (held): see tick.
  function holding(r: Run, pending: Pending, at: number): { heard: boolean; held: boolean } {
    const heard = heardSinceRead({ words: r.words, wordsAtRead: pending.words, spokenMs: spokenMs(r.voice, at), spokenAtRead: pending.spokenAt });
    return { heard, held: heard && mayHold(r, pending) };
  }

  // Whether what they say after its read can hold the waiting offer: not one a read that heard them
  // brought, nor once no read is left to confirm it.
  function mayHold(r: Run, pending: Pending): boolean {
    return !pending.confirms && r.reads < MAX_READS;
  }

  // Each tick: the recorder re-renders only when the line under the question changes.
  function refresh(r: Run) {
    if (active(r) && statusOf(r, deps.now()) !== r.status) publish(r);
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
  }

  // Ends the session with how long live transcription heard the recording (for its cost), once.
  function endSession(r: Run) {
    if (r.sessionId === null || r.endSent) return;
    r.endSent = true;
    const heardMs = r.connectedAt === null ? 0 : Math.max(0, (r.closedAt ?? deps.now()) - r.connectedAt);
    deps.end({ sessionId: r.sessionId, recordedMs: Math.round(heardMs), shown: r.shown.id, ...fellBack(r) });
  }

  // One way, for the rest of the take: the recorder keeps the question on screen, with no more
  // follow-ups.
  function fallback(r: Run, why: FallbackReason) {
    if (!active(r)) return;
    r.fallen = true;
    r.fallenWhy = why;
    shutdown(r);
    endSession(r);
    onView({ mode: "fallback", offer: r.shown, started: r.connectedAt !== null });
  }

  function failed(r: Run) {
    r.failures += 1;
    if (r.failures >= MAX_COACH_FAILURES_IN_A_ROW) fallback(r, "coach_failures");
  }

  // Live transcription must be connected this long after the recording starts (or after the key
  // arrives, if that was later).
  function armDeadline(r: Run) {
    if (r.deadline !== null) clearTimeout(r.deadline);
    r.deadline = setTimeout(() => {
      r.deadline = null;
      if (!r.connection) fallback(r, "connect_timeout");
    }, CONNECT_TIMEOUT_MS);
  }

  function started(r: Run, response: LiveStartResponse | null) {
    if (!active(r)) {
      // Answered after the take ended, or after live coaching was given up: nothing will use it.
      if (isLiveStartReady(response)) deps.end({ sessionId: response.sessionId, recordedMs: 0, shown: null, ...fellBack(r) });
      return;
    }
    if (!isLiveStartReady(response)) return fallback(r, "start_not_ready");
    r.startAnsweredAt = deps.now();
    r.sessionId = response.sessionId;
    r.pacing = response.pacing;
    connect(r);
  }

  // Once there is both a session and a stream: the offer goes to the server (once per session), which
  // opens the transcription and sends OpenAI's answer back.
  function connect(r: Run) {
    const { stream, sessionId } = r;
    if (!stream || sessionId === null || r.connecting || !active(r)) return;
    r.connecting = true;
    armDeadline(r);
    deps
      .connect({
        stream,
        exchange: async (offer, signal) => {
          const reply = await deps.exchange({ sessionId, offer }, signal);
          if (reply?.status !== "connected") throw new Error("live transcription: the server didn't connect it");
          return reply.answer;
        },
        signal: r.abort.signal,
        onEvent: (event) => heard(r, event),
        onFailure: () => fallback(r, "connection_lost"),
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
        () => fallback(r, "connect_failed"),
      );
  }

  function heard(r: Run, event: TranscriptEvent) {
    if (!active(r)) return;
    const finished = (event.type === "completed" || event.type === "failed") && !r.transcript.items.get(event.itemId)?.final;
    const next = applyEvent(r.transcript, event);
    if (next === r.transcript) return;
    r.transcript = next;
    // Counted even when it brings no words (a cough, an "mm"): the turn is back all the same.
    if (finished) r.turnsBack += 1;
    if (finished && event.type === "failed") r.turnsLost += 1;
    const text = transcriptText(next);
    if (text === r.text) return;
    r.text = text;
    r.words = wordCount(text);
    r.spokenAtText = spokenMs(r.voice, deps.now());
  }

  function show(r: Run, offer: ShownOffer, more: boolean) {
    r.shown = offer;
    r.shownAt = deps.now();
    r.wordsAtShown = r.words;
    r.pending = null;
    r.more = more;
    r.hadItsTime = false;
    // A second press of "Different question" for the question before, while the first was on its
    // way: that question has gone.
    r.skipWanted = null;
    // What was on its way is here: the line moves on with it, without holding checking or ready.
    r.busySince = null;
    publish(r);
  }

  async function ask(r: Run, skip: number | null, { reread, confirms, renews }: ReadOptions = PLAIN_READ) {
    const sessionId = r.sessionId;
    if (sessionId === null) return;
    const at = deps.now();
    const asked: ReadAsked = { requestedAt: at, words: r.words, spokenAt: spokenMs(r.voice, at), lost: r.turnsLost, confirms, renews };
    // A reread that never reaches Claude (timed out, failed, turned away, or degraded) still owes
    // one: without it, the next few words go unread and a dropped question can come straight back.
    const stillOwed = () => {
      if (reread) r.rereadOwed = true;
    };
    const seq = ++r.seq;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (r.call?.seq !== seq) return;
      r.call = null;
      controller.abort();
      if (skip === null && !renews) r.pending = null; // see answer()
      stillOwed();
      if (active(r)) failed(r);
    }, COACH_TIMEOUT_MS);
    r.call = { seq, controller, timer, skip, renews };
    r.lastAskAt = at;
    if (skip === null) {
      r.reads += 1;
      r.lastReadAt = at;
      r.wordsAtLastRead = r.words;
      r.rereadOwed = false;
    } else {
      r.skipWanted = null;
    }
    // The newest speech matters most; a transcript this long is well past ten minutes anyway.
    const transcript = r.text.length > MAX_TRANSCRIPT_CHARS ? r.text.slice(-MAX_TRANSCRIPT_CHARS) : r.text;
    let response: CoachResponse | null;
    try {
      response = await deps.ask(
        {
          sessionId,
          transcript,
          elapsedMs: Math.max(0, Math.round(at - r.startedAt)),
          shown: r.shown.id,
          skip,
          // Only when set: a server from before reread (after a rollback) refuses keys it doesn't know.
          ...(reread ? { reread: true } : {}),
        },
        controller.signal,
      );
    } catch {
      response = null;
    }
    // Timed out or stopped meanwhile: this answer is older than what has happened since.
    if (r.call?.seq !== seq) return;
    clearTimeout(timer);
    r.call = null;
    if (response === null || response.status === "error" || response.degraded) stillOwed();
    if (active(r)) answer(r, response, asked, skip);
  }

  function answer(r: Run, response: CoachResponse | null, asked: ReadAsked, skip: number | null) {
    // A read that heard more came back with nothing to weigh (failed, or turned away): the offer
    // waiting from an earlier read may be about what they have just covered, so it goes too. Not
    // for a read that renews a question lined up to show: that one stays as it was.
    if (skip === null && !asked.renews && (response === null || response.status === "error")) r.pending = null;
    if (response === null) return failed(r);
    if (response.status === "error") {
      // Too soon after the last call: a "Different question" waits a moment and goes again.
      if (response.code === "too_soon") {
        if (skip !== null && r.skipWanted === null && r.shown.id === skip) r.skipWanted = skip;
        return;
      }
      if (FINAL.includes(response.code)) return fallback(r, "final_code");
      return failed(r);
    }
    const touchedNow = !sameTouched(r.touched, response.touched);
    if (touchedNow) r.touched = response.touched;
    // Claude's read failed: the offer comes from what was known before, so only "Different question"
    // takes it (below).
    if (response.degraded) {
      failed(r);
      if (!active(r)) return;
    } else {
      r.failures = 0;
    }
    // A read that renewed a question which has shown since: its answer is about the question before.
    if (skip === null && asked.requestedAt < r.shownAt) {
      if (touchedNow) publish(r, r.status);
      return;
    }
    const offer = response.offer && response.offer.id !== r.shown.id ? response.offer : null;
    // A server from before it doesn't say: then more may always come.
    const more = response.more !== false;
    // They asked for a different question: it replaces the one on screen straight away.
    if (skip !== null && offer && r.shown.id === skip) return show(r, offer, more);
    // Nothing new: what may still come is said for the offer on screen. (With an offer, it is said for
    // that one, and holds once it shows.)
    if (offer === null) r.more = more;
    // A "Different question" waiting to be sent answers instead of this. A degraded read never heard
    // the newest speech: its offer, like the one held back for it, may be about what they have just
    // covered, so neither waits to be shown; but a degraded read that renews a question lined up
    // to show leaves it as it was.
    if (skip === null && !(asked.renews && response.degraded)) {
      r.pending = offer && !response.degraded && r.skipWanted === null ? { offer, more, ...asked } : null;
    }
    // The line moves on at the next tick, once a question that may show at once has: it never says
    // one will show just before it does.
    if (touchedNow) publish(r, r.status);
  }

  function tick(r: Run) {
    if (!active(r)) return;
    const at = deps.now();
    if (!r.sampled) {
      if (at - r.startedAt >= METER_WAIT_MS) fallback(r, "meter");
      return;
    }
    const { connection, pacing } = r;
    if (!connection || !pacing) return;
    const silence = silenceMs(r.voice, at);
    const spoken = spokenMs(r.voice, at);
    const { pending } = r;
    // What they said since the read behind the waiting offer came back as no words at all (a cough,
    // an "mm"): nothing since the last commit, every turn ended is back, and none failed since the
    // read. The read missed nothing, so that speech no longer holds the offer.
    if (
      pending !== null &&
      spoken > pending.spokenAt &&
      spoken === r.spokenAtCommit &&
      r.words <= pending.words &&
      r.turnsBack >= r.commits &&
      r.turnsLost === pending.lost
    ) {
      pending.spokenAt = spoken;
    }
    // They have said more since that read was asked for (heard): the offer isn't shown until a read
    // that has heard it answers (held). Only once: an offer from that read is shown at the next
    // pause it may, even if they have said more, so a member whose pauses are shorter than a read
    // still gets follow-ups. With no read left to ask (MAX_READS), it shows at the pause, as before
    // offers were held: a question that may come a little late beats none at all.
    const { heard, held } = pending === null ? { heard: false, held: false } : holding(r, pending, at);
    const onOpening = r.shown.id === OPENING_OFFER_ID;

    if (
      shouldCommit({
        now: at,
        silenceMs: silence,
        speechSinceCommitMs: spoken - r.spokenAtCommit,
        lastCommitAt: r.lastCommitAt,
        offerWaiting: r.call !== null || pending !== null,
      })
    ) {
      connection.commit();
      r.commits += 1;
      r.lastCommitAt = at;
      r.spokenAtCommit = spoken;
    }
    // They have been talking and nothing has come back: live transcription isn't working.
    if (spoken - r.spokenAtText >= NO_TEXT_WHILE_SPEAKING_MS) return fallback(r, "no_text");

    // The question they wanted replaced has gone from the screen meanwhile.
    if (r.skipWanted !== null && r.skipWanted !== r.shown.id) r.skipWanted = null;
    if (!r.call && (r.lastAskAt === null || at - r.lastAskAt >= MIN_ASK_GAP_MS)) {
      if (r.skipWanted !== null) {
        void ask(r, r.skipWanted);
      } else {
        const hadItsTime = questionHadItsTime({
          now: at,
          pacing,
          shownAt: r.shownAt,
          wordsSinceShown: r.words - r.wordsAtShown,
          elapsedMs: at - r.startedAt,
          onOpening,
        });
        const reread = rereadDue({ held, hadItsTime, silenceMs: silence, pacing });
        // An offer waits that will show as it is at the next pause it may (one a read has confirmed,
        // even if they have said more since): no read until it has. A newer read would hold it back
        // (shouldShow), and should its answer come once they talk again, that offer would be held in
        // turn, again and again, and nothing would show. Only once the read behind it is
        // RENEW_AFTER_MS old, so it isn't about what they said long ago, a read that renews it:
        // that one holds nothing back, and its offer, should it answer first, replaces it as it is.
        const showsAsItIs = pending !== null && pending.requestedAt >= r.shownAt && !held;
        const renew = showsAsItIs && at - pending.requestedAt >= RENEW_AFTER_MS;
        if (
          (!showsAsItIs || renew) &&
          shouldRead({
            now: at,
            silenceMs: silence,
            words: r.words,
            // New words since the question on screen appeared, too: a read of only what they said to
            // the one before would bring an offer that, once they have clearly stopped, shows straight
            // after this one, while they think about it.
            wordsAtLastRead: Math.max(r.wordsAtLastRead, r.wordsAtShown),
            lastReadAt: r.lastReadAt,
            inFlight: false,
            reads: r.reads,
            ended: false,
            reread,
            textOwed: r.commits > r.turnsBack && at - r.lastCommitAt < TEXT_WAIT_MS,
          })
        ) {
          void ask(r, null, { reread: heard || r.rereadOwed, confirms: reread || renew, renews: renew });
        }
      }
    }

    if (!pending || r.skipWanted !== null) return;
    // They spoke after its read, and by the time they have clearly stopped its text still hasn't
    // come back, or a turn's transcription failed: what they said is lost, and may have answered
    // it, so the offer goes rather than shows. Should the text still come, the next read has Claude
    // read it (rereadOwed).
    if (held && r.words <= pending.words && silence >= pacing.stoppedSilenceMs) {
      r.pending = null;
      r.rereadOwed = true;
      return;
    }
    if (
      shouldShow({
        now: at,
        speaking: r.voice.speaking,
        silenceMs: silence,
        pacing,
        shownAt: r.shownAt,
        wordsSinceShown: r.words - r.wordsAtShown,
        elapsedMs: at - r.startedAt,
        onOpening,
        offerRequestedAt: pending.requestedAt,
        // Any read still out was asked for after the pending offer's, which has answered. One that
        // renews it holds it back no longer than it takes to answer first.
        newerReadOut: r.call !== null && !r.call.renews,
        heardSinceOffer: held,
      })
    ) {
      show(r, pending.offer, pending.more);
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
      r.ticker = setInterval(() => {
        tick(r);
        refresh(r);
      }, TICK_MS);
      armDeadline(r);
      connect(r);
    },

    skip() {
      const r = run;
      if (!r || !active(r) || r.skipWanted !== null) return;
      if (r.shown.kind !== "question" || r.shown.id === OPENING_OFFER_ID) return;
      // Pressed again while the first press is on its way: it is already being replaced.
      if (r.call?.skip === r.shown.id) return;
      r.skipWanted = r.shown.id;
      r.skippedAt = deps.now();
      r.pending = null;
      // At once, unless a call is already on its way (then as soon as it answers).
      if (!r.call && (r.lastAskAt === null || deps.now() - r.lastAskAt >= MIN_ASK_GAP_MS)) void ask(r, r.skipWanted);
    },

    stop,
  };
}

// The end call's reason, only when live coaching was given up: a server from before it (after a
// rollback) refuses keys it doesn't know.
function fellBack(r: Run): { fallback?: FallbackReason } {
  return r.fallenWhy ? { fallback: r.fallenWhy } : {};
}

const isBusy = (status: FollowUpStatus): status is BusyStatus => status === "checking" || status === "ready";

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
