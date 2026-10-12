// When the recorder ends a transcription turn, asks the coach for a read, and shows the next
// question; what the member is told is coming; and when it gives up on live coaching and carries on
// without follow-ups. Pure decisions over plain numbers, all in milliseconds on one clock
// (liveClock), so they can be tested without a browser. The coach's own pacing (how long to wait
// before showing a question, and when new questions stop) comes from rubrics/coach.md through the
// start response; the rest is fixed here.

import type { Pacing } from "@/lib/coach/types";

// The clock every time here is measured on: monotonic, so a change to the computer's clock can't
// end a turn or hold a question back. The level meter (voice.ts) stamps samples with it too.
export function liveClock(): number {
  return performance.now();
}

// --- Ending turns -------------------------------------------------------------------------------
// The live model has no voice detection, so the browser ends each turn: once they pause after
// saying something, or every 20 seconds of unbroken talk so text keeps arriving. While a read is out
// or its offer waits to be shown (offerWaiting), a pause ends even a short turn: a sub-second "team
// ok lah" may answer what that offer asks, and the read confirming it needs to hear it.
export const COMMIT_SILENCE_MS = 700;
export const MIN_TURN_SPEECH_MS = 1000;
export const FORCE_COMMIT_MS = 20_000;

export function shouldCommit({
  now,
  silenceMs,
  speechSinceCommitMs,
  lastCommitAt,
  offerWaiting,
}: {
  now: number;
  silenceMs: number;
  speechSinceCommitMs: number;
  lastCommitAt: number;
  offerWaiting: boolean;
}): boolean {
  const turn = offerWaiting ? speechSinceCommitMs > 0 : speechSinceCommitMs >= MIN_TURN_SPEECH_MS;
  if (silenceMs >= COMMIT_SILENCE_MS && turn) return true;
  return now - lastCommitAt >= FORCE_COMMIT_MS && speechSinceCommitMs > 0;
}

// --- Asking the coach ---------------------------------------------------------------------------
// A read when they pause after enough new words, or after a longer pause with any new words at
// all; never more often than every 5 seconds, one at a time, and at most 40 a recording (the
// server has its own, firmer cap). An offer held for what they said after its read gets one read to
// confirm or replace it (reread), at the first pause with any new words, without the 5 seconds (the
// server's own minimum gap still applies), once the offer could otherwise be shown (rereadDue). A
// read waits, up to 1.5 seconds after the last turn ended, for the text of turns they have ended
// (textOwed), so it hears all they said before it: text landing just after it would otherwise hold
// its offer for nothing. While a question lined up to show waits for their next pause, no read goes
// until it has shown, however long they talk, except, once the read behind it is RENEW_AFTER_MS old,
// a read that renews it: that one never holds it back, and its offer, should it answer before the
// pause, takes the waiting question's place as it is (or none waits, should they have covered it).
export const READ_SILENCE_MS = 1200;
export const STALL_SILENCE_MS = 4000;
export const FIRST_READ_WORDS = 20;
export const NEW_READ_WORDS = 15;
export const MIN_READ_GAP_MS = 5000;
export const MAX_READS = 40;
export const TEXT_WAIT_MS = 1500;
export const RENEW_AFTER_MS = 30_000;

export function shouldRead({
  now,
  silenceMs,
  words,
  wordsAtLastRead,
  lastReadAt,
  inFlight,
  reads,
  ended,
  reread,
  textOwed,
}: {
  now: number;
  silenceMs: number;
  words: number;
  wordsAtLastRead: number;
  // null before the first read.
  lastReadAt: number | null;
  inFlight: boolean;
  reads: number;
  ended: boolean;
  // A held offer's one read to confirm it is due (rereadDue).
  reread: boolean;
  // A turn they have ended hasn't come back as text yet, and TEXT_WAIT_MS hasn't passed.
  textOwed: boolean;
}): boolean {
  if (inFlight || ended || textOwed || reads >= MAX_READS) return false;
  if (!reread && lastReadAt !== null && now - lastReadAt < MIN_READ_GAP_MS) return false;
  const newWords = words - wordsAtLastRead;
  if (silenceMs >= READ_SILENCE_MS && newWords >= (reads === 0 ? FIRST_READ_WORDS : NEW_READ_WORDS)) return true;
  if (reread && silenceMs >= READ_SILENCE_MS && newWords > 0) return true;
  return silenceMs >= STALL_SILENCE_MS && newWords > 0;
}

// --- Showing the next question ------------------------------------------------------------------
// Speech this much longer than when a read was asked for is words it never heard, not a breath or
// a click.
export const HEARD_SINCE_READ_MS = 300;

// Whether they have said more since the read behind the waiting offer was asked for: new text, or
// speech whose text hasn't come back yet. That read may have missed them covering what it asks
// about ("team ok lah"), so the offer is held (shouldShow) until a read that heard it answers:
// once, as that read's own offer shows at the next pause it may, even if they have said more.
export function heardSinceRead({
  words,
  wordsAtRead,
  spokenMs,
  spokenAtRead,
}: {
  words: number;
  wordsAtRead: number;
  // How long they have spoken in all, now and when the read was asked for.
  spokenMs: number;
  spokenAtRead: number;
}): boolean {
  return words > wordsAtRead || spokenMs - spokenAtRead > HEARD_SINCE_READ_MS;
}

// Whether the question on screen has had its time and enough words (the opening question longer
// still), so a follow-up may replace it at a short pause.
export function questionHadItsTime({
  now,
  pacing,
  shownAt,
  wordsSinceShown,
  elapsedMs,
  onOpening,
}: {
  now: number;
  pacing: Pacing;
  // When the question on screen appeared.
  shownAt: number;
  wordsSinceShown: number;
  // How far into the recording.
  elapsedMs: number;
  onOpening: boolean;
}): boolean {
  return (
    now - shownAt >= pacing.minQuestionMs &&
    wordsSinceShown >= pacing.minWordsPerQuestion &&
    (!onOpening || elapsedMs >= pacing.firstFollowUpAfterMs)
  );
}

// Whether a held offer's one read to confirm it (shouldRead's reread) is due: only once the offer
// could otherwise be shown, so no read is spent on an offer that would wait anyway. Until then the
// usual reads go on, and their offers replace it.
export function rereadDue({
  held,
  hadItsTime,
  silenceMs,
  pacing,
}: {
  // An offer waits that is held for what they have said since its read.
  held: boolean;
  // questionHadItsTime.
  hadItsTime: boolean;
  silenceMs: number;
  pacing: Pacing;
}): boolean {
  return held && (hadItsTime || silenceMs >= pacing.stoppedSilenceMs);
}

// Never while they speak. The offer waiting to be shown must come from a read asked for after the
// question on screen appeared (an older one answers a question they have moved past), no newer
// read may still be out (that one has heard more, and its answer replaces the offer or drops it),
// and it mustn't be held for what they have said since its read was asked for, so they aren't
// asked about something they have just covered. Then it shows
// once they have clearly stopped, or after a shorter pause once the current question has had its
// time and enough words, and the opening question has had longer still.
export function shouldShow({
  now,
  speaking,
  silenceMs,
  pacing,
  shownAt,
  wordsSinceShown,
  elapsedMs,
  onOpening,
  offerRequestedAt,
  newerReadOut,
  heardSinceOffer,
}: {
  now: number;
  speaking: boolean;
  silenceMs: number;
  pacing: Pacing;
  // When the question on screen appeared.
  shownAt: number;
  wordsSinceShown: number;
  // How far into the recording.
  elapsedMs: number;
  onOpening: boolean;
  // When the read behind the offer waiting to be shown was asked for; null when none is waiting.
  offerRequestedAt: number | null;
  // A coach read asked for after that one hasn't answered yet.
  newerReadOut: boolean;
  // They have said more since that read was asked for (heardSinceRead), and the offer is held for it
  // until a read that heard it answers. An offer from that read isn't held again.
  heardSinceOffer: boolean;
}): boolean {
  if (speaking || newerReadOut || heardSinceOffer || offerRequestedAt === null || offerRequestedAt < shownAt) return false;
  if (silenceMs >= pacing.stoppedSilenceMs) return true;
  return silenceMs >= pacing.showAfterSilenceMs && questionHadItsTime({ now, pacing, shownAt, wordsSinceShown, elapsedMs, onOpening });
}

// --- No new questions after ----------------------------------------------------------------------
// The server asks nothing new once the recording is "No new questions after" in (coach.md). It takes
// the lesser of the recorder's time and the time since it started the session, which it did after
// the recording started and before the start answered. So by the recorder's own clock that time is
// surely still to come before then ("open"), and surely past only once that long has gone by since
// the start answered ("over"), give or take the server's and the database's clocks (LIMIT_SLACK_MS);
// in between, it may be either ("unsure").
export const LIMIT_SLACK_MS = 2000;
export type QuestionTime = "open" | "unsure" | "over";

export function questionTime({
  now,
  startedAt,
  startAnsweredAt,
  limitMs,
}: {
  now: number;
  // When the recording started, and when the start answered (null until it has).
  startedAt: number;
  startAnsweredAt: number | null;
  // From the start's pacing; undefined from a server from before it, which is then never over.
  limitMs: number | undefined;
}): QuestionTime {
  if (limitMs === undefined || now - startedAt < limitMs) return "open";
  return startAnsweredAt !== null && now - startAnsweredAt >= limitMs + LIMIT_SLACK_MS ? "over" : "unsure";
}

// --- Telling them what's coming ---------------------------------------------------------------
// The line under the question (live-prompt.tsx). It promises a follow-up only once one is lined up:
// "ready" while a question waits that will show, as it is, at their next pause (the question on
// screen has had its time, or they have paused long enough that it shows once they have clearly
// stopped). A question held for what they said after its read, or with a newer read out, isn't
// lined up: that read may bring another question, a closing line or nothing. A coach call out a
// while says "checking", which promises nothing either, and only when it could bring a question that
// could show at their next pause: earlier ones would only flash for questions that never show. "No
// more" once nothing but "Different question" can bring a follow-up (moreToCome); that only swaps
// the question on screen, so the line keeps saying it while one is on its way. A call that answers
// within CHECKING_AFTER_MS never makes it say checking, so a quick read or a quick "Different
// question" doesn't flicker, except that "Different question" says checking at once when the line
// already says checking or ready (it never goes back to listening before the new question); and
// once it says checking or ready, it says so for MIN_BUSY_MS at least (ready only while the question
// still waits, lined up or not), unless a question or closing line shows meanwhile, so talk resumed,
// or a read that finds nothing, just after it appeared doesn't flash it either.
export const CHECKING_AFTER_MS = 1000;
export const MIN_BUSY_MS = 1000;
export type FollowUpStatus = "starting" | "listening" | "checking" | "ready" | "no_more";
export type BusyStatus = Extract<FollowUpStatus, "checking" | "ready">;

export function followUpStatus({
  connected,
  closingShown,
  waiting,
  call,
  busy,
  due,
  paused,
  moreToCome,
}: {
  connected: boolean;
  closingShown: boolean;
  // What waits to be shown, from a read asked for since the question on screen appeared: a question
  // lined up (it shows as it is at their next pause it may), a question a read must confirm first,
  // or that a newer read out will replace or drop (held), or a closing line. A held question that
  // can only give way to a closing line counts as nothing.
  waiting: "question" | "held" | "closing" | null;
  // The coach call out, if it could bring a question back: how long it has been out (a "Different
  // question" from when it was pressed, even while it waits to be sent), and whether it is one.
  call: { ms: number; skip: boolean } | null;
  // What the line says now, if checking or ready, and how long it has said either.
  busy: { status: BusyStatus; ms: number } | null;
  // questionHadItsTime, kept until the next question shows.
  due: boolean;
  // Quiet for showAfterSilenceMs or more.
  paused: boolean;
  // A later read could still bring a follow-up question: the server hasn't said none can, reads are
  // left, and it isn't surely past "No new questions after" (questionTime).
  moreToCome: boolean;
}): FollowUpStatus {
  if (closingShown) return "no_more";
  if (!connected) return "starting";
  // While they stay quiet after the line said checking, the question is about to show: it keeps
  // saying checking rather than flash ready just before.
  if (waiting === "question" && (due || paused)) return paused && busy?.status === "checking" ? "checking" : "ready";
  if (call?.skip && moreToCome && (call.ms >= CHECKING_AFTER_MS || busy)) return "checking";
  if (call && !call.skip && (waiting === null || waiting === "held") && (due || paused) && call.ms >= CHECKING_AFTER_MS) return "checking";
  const questionWaits = waiting === "question" || waiting === "held";
  if (busy && busy.ms < MIN_BUSY_MS && (busy.status === "checking" || questionWaits)) return busy.status;
  if (!moreToCome && !questionWaits && (call === null || call.skip)) return "no_more";
  return "listening";
}

// --- Giving up on follow-ups --------------------------------------------------------------------
// Live transcription must connect within this long.
export const CONNECT_TIMEOUT_MS = 8000;
// This many coach calls failing one after another (no answer, or an error) ends live coaching.
export const MAX_COACH_FAILURES_IN_A_ROW = 2;
// They have been speaking this long and no text has come back: transcription isn't working.
export const NO_TEXT_WHILE_SPEAKING_MS = 25_000;
