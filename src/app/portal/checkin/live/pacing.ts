// When the recorder ends a transcription turn, asks the coach for a read, and shows the next
// question; and when it gives up on live coaching and carries on without follow-ups. Pure
// decisions over plain numbers, all in milliseconds on one clock (liveClock), so they can be tested
// without a browser. The coach's own pacing (how long to wait before showing a question) comes from
// rubrics/coach.md through the start response; the rest is fixed here.

import type { Pacing } from "@/lib/coach/types";

// The clock every time here is measured on: monotonic, so a change to the computer's clock can't
// end a turn or hold a question back. The level meter (voice.ts) stamps samples with it too.
export function liveClock(): number {
  return performance.now();
}

// --- Ending turns -------------------------------------------------------------------------------
// The live model has no voice detection, so the browser ends each turn: once they pause after
// saying something, or every 20 seconds of unbroken talk so text keeps arriving. While an offer is
// held for what they said after its read (offerHeld), a pause ends even a short turn: a sub-second
// "team ok lah" is just what the read confirming that offer needs to hear.
export const COMMIT_SILENCE_MS = 700;
export const MIN_TURN_SPEECH_MS = 1000;
export const FORCE_COMMIT_MS = 20_000;

export function shouldCommit({
  now,
  silenceMs,
  speechSinceCommitMs,
  lastCommitAt,
  offerHeld,
}: {
  now: number;
  silenceMs: number;
  speechSinceCommitMs: number;
  lastCommitAt: number;
  offerHeld: boolean;
}): boolean {
  const turn = offerHeld ? speechSinceCommitMs > 0 : speechSinceCommitMs >= MIN_TURN_SPEECH_MS;
  if (silenceMs >= COMMIT_SILENCE_MS && turn) return true;
  return now - lastCommitAt >= FORCE_COMMIT_MS && speechSinceCommitMs > 0;
}

// --- Asking the coach ---------------------------------------------------------------------------
// A read when they pause after enough new words, or after a longer pause with any new words at
// all; never more often than every 5 seconds, one at a time, and at most 40 a recording (the
// server has its own, firmer cap). While an offer is held for what they said after its read, any
// new words are enough at the first pause, without the 5 seconds: that read confirms the offer or
// replaces it, and the server's own minimum gap still applies. A read waits, up to 1.5 seconds
// after the last turn ended, for the text of turns they have ended (textOwed), so it hears all
// they said before it: text landing just after it would otherwise hold its offer for nothing.
export const READ_SILENCE_MS = 1200;
export const STALL_SILENCE_MS = 4000;
export const FIRST_READ_WORDS = 20;
export const NEW_READ_WORDS = 15;
export const MIN_READ_GAP_MS = 5000;
export const MAX_READS = 40;
export const TEXT_WAIT_MS = 1500;

export function shouldRead({
  now,
  silenceMs,
  words,
  wordsAtLastRead,
  lastReadAt,
  inFlight,
  reads,
  ended,
  offerHeld,
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
  offerHeld: boolean;
  // A turn they have ended hasn't come back as text yet, and TEXT_WAIT_MS hasn't passed.
  textOwed: boolean;
}): boolean {
  if (inFlight || ended || textOwed || reads >= MAX_READS) return false;
  if (!offerHeld && lastReadAt !== null && now - lastReadAt < MIN_READ_GAP_MS) return false;
  const newWords = words - wordsAtLastRead;
  if (silenceMs >= READ_SILENCE_MS && newWords >= (reads === 0 ? FIRST_READ_WORDS : NEW_READ_WORDS)) return true;
  if (offerHeld && silenceMs >= READ_SILENCE_MS && newWords > 0) return true;
  return silenceMs >= STALL_SILENCE_MS && newWords > 0;
}

// --- Showing the next question ------------------------------------------------------------------
// Speech this much longer than when a read was asked for is words it never heard, not a breath or
// a click.
export const HEARD_SINCE_READ_MS = 300;

// Whether they have said more since the read behind the waiting offer was asked for: new text, or
// speech whose text hasn't come back yet. That read may have missed them covering what it asks
// about ("team ok lah"), so the offer is held (shouldShow) until a read that heard it answers.
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

// Never while they speak. The offer waiting to be shown must come from a read asked for after the
// question on screen appeared (an older one answers a question they have moved past), no newer
// read may still be out (that one has heard more, and its answer replaces the offer or drops it),
// and they mustn't have said more since its read was asked for, so they aren't asked about
// something they have just covered. Then it shows
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
  // They have said more since that read was asked for (heardSinceRead).
  heardSinceOffer: boolean;
}): boolean {
  if (speaking || newerReadOut || heardSinceOffer || offerRequestedAt === null || offerRequestedAt < shownAt) return false;
  if (silenceMs >= pacing.stoppedSilenceMs) return true;
  return (
    silenceMs >= pacing.showAfterSilenceMs &&
    now - shownAt >= pacing.minQuestionMs &&
    wordsSinceShown >= pacing.minWordsPerQuestion &&
    (!onOpening || elapsedMs >= pacing.firstFollowUpAfterMs)
  );
}

// --- Giving up on follow-ups --------------------------------------------------------------------
// Live transcription must connect within this long.
export const CONNECT_TIMEOUT_MS = 8000;
// This many coach calls failing one after another (no answer, or an error) ends live coaching.
export const MAX_COACH_FAILURES_IN_A_ROW = 2;
// They have been speaking this long and no text has come back: transcription isn't working.
export const NO_TEXT_WHILE_SPEAKING_MS = 25_000;
