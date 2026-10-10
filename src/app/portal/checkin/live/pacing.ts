// When the recorder ends a transcription turn, asks the coach for a read, and shows the next
// question; and when it gives up on live coaching and goes back to the three fixed questions. Pure
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
// saying something, or every 20 seconds of unbroken talk so text keeps arriving.
export const COMMIT_SILENCE_MS = 700;
export const MIN_TURN_SPEECH_MS = 1000;
export const FORCE_COMMIT_MS = 20_000;

export function shouldCommit({
  now,
  silenceMs,
  speechSinceCommitMs,
  lastCommitAt,
}: {
  now: number;
  silenceMs: number;
  speechSinceCommitMs: number;
  lastCommitAt: number;
}): boolean {
  if (silenceMs >= COMMIT_SILENCE_MS && speechSinceCommitMs >= MIN_TURN_SPEECH_MS) return true;
  return now - lastCommitAt >= FORCE_COMMIT_MS && speechSinceCommitMs > 0;
}

// --- Asking the coach ---------------------------------------------------------------------------
// A read when they pause after enough new words, or after a longer pause with any new words at
// all; never more often than every 5 seconds, one at a time, and at most 40 a recording (the
// server has its own, firmer cap).
export const READ_SILENCE_MS = 1200;
export const STALL_SILENCE_MS = 4000;
export const FIRST_READ_WORDS = 20;
export const NEW_READ_WORDS = 15;
export const MIN_READ_GAP_MS = 5000;
export const MAX_READS = 40;

export function shouldRead({
  now,
  silenceMs,
  words,
  wordsAtLastRead,
  lastReadAt,
  inFlight,
  reads,
  ended,
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
}): boolean {
  if (inFlight || ended || reads >= MAX_READS) return false;
  if (lastReadAt !== null && now - lastReadAt < MIN_READ_GAP_MS) return false;
  const newWords = words - wordsAtLastRead;
  if (silenceMs >= READ_SILENCE_MS && newWords >= (reads === 0 ? FIRST_READ_WORDS : NEW_READ_WORDS)) return true;
  return silenceMs >= STALL_SILENCE_MS && newWords > 0;
}

// --- Showing the next question ------------------------------------------------------------------
// Never while they speak. The offer waiting to be shown must come from a read asked for after the
// question on screen appeared (an older one answers a question they have moved past). Then it shows
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
}): boolean {
  if (speaking || offerRequestedAt === null || offerRequestedAt < shownAt) return false;
  if (silenceMs >= pacing.stoppedSilenceMs) return true;
  return (
    silenceMs >= pacing.showAfterSilenceMs &&
    now - shownAt >= pacing.minQuestionMs &&
    wordsSinceShown >= pacing.minWordsPerQuestion &&
    (!onOpening || elapsedMs >= pacing.firstFollowUpAfterMs)
  );
}

// --- Falling back to the fixed questions --------------------------------------------------------
// Live transcription must connect within this long.
export const CONNECT_TIMEOUT_MS = 8000;
// This many coach calls failing one after another (no answer, or an error) ends live coaching.
export const MAX_COACH_FAILURES_IN_A_ROW = 2;
// They have been speaking this long and no text has come back: transcription isn't working.
export const NO_TEXT_WHILE_SPEAKING_MS = 25_000;
