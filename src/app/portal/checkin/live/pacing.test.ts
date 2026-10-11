import { describe, expect, it } from "vitest";
import type { Pacing } from "@/lib/coach/types";
import {
  COMMIT_SILENCE_MS,
  FIRST_READ_WORDS,
  FORCE_COMMIT_MS,
  HEARD_SINCE_READ_MS,
  heardSinceRead,
  MAX_READS,
  MIN_READ_GAP_MS,
  MIN_TURN_SPEECH_MS,
  NEW_READ_WORDS,
  questionHadItsTime,
  READ_SILENCE_MS,
  rereadDue,
  shouldCommit,
  shouldRead,
  shouldShow,
  STALL_SILENCE_MS,
} from "./pacing";

describe("shouldCommit", () => {
  const base = { now: 10_000, silenceMs: 0, speechSinceCommitMs: 0, lastCommitAt: 5_000, offerWaiting: false };

  it.each([
    ["a pause after a full turn", { silenceMs: COMMIT_SILENCE_MS, speechSinceCommitMs: MIN_TURN_SPEECH_MS }, true],
    ["a pause just too short", { silenceMs: COMMIT_SILENCE_MS - 1, speechSinceCommitMs: 5_000 }, false],
    ["a pause after too little speech", { silenceMs: 5_000, speechSinceCommitMs: MIN_TURN_SPEECH_MS - 1 }, false],
    ["a long pause after nothing at all", { silenceMs: Infinity, speechSinceCommitMs: 0 }, false],
    ["unbroken talk reaching the limit", { now: 5_000 + FORCE_COMMIT_MS, speechSinceCommitMs: 300 }, true],
    ["unbroken talk just under the limit", { now: 5_000 + FORCE_COMMIT_MS - 1, speechSinceCommitMs: 19_000 }, false],
    ["the limit passing with no speech", { now: 5_000 + FORCE_COMMIT_MS * 3, speechSinceCommitMs: 0 }, false],
    // A sub-second "team ok lah" while a read is out or its offer waits: the read confirming it must hear it.
    ["a pause after a short turn, while an offer waits", { silenceMs: COMMIT_SILENCE_MS, speechSinceCommitMs: 400, offerWaiting: true }, true],
    ["a pause too short, while an offer waits", { silenceMs: COMMIT_SILENCE_MS - 1, speechSinceCommitMs: 400, offerWaiting: true }, false],
    ["a pause after nothing at all, while an offer waits", { silenceMs: Infinity, speechSinceCommitMs: 0, offerWaiting: true }, false],
  ])("%s", (_label, overrides, expected) => {
    expect(shouldCommit({ ...base, ...overrides })).toBe(expected);
  });
});

describe("shouldRead", () => {
  // A pause long enough, the first read's words in, nothing in the way.
  const base = {
    now: 60_000,
    silenceMs: READ_SILENCE_MS,
    words: FIRST_READ_WORDS,
    wordsAtLastRead: 0,
    lastReadAt: null as number | null,
    inFlight: false,
    reads: 0,
    ended: false,
    reread: false,
    textOwed: false,
  };
  // After a read: the next one needs fewer new words.
  const later = { ...base, reads: 3, wordsAtLastRead: 100, words: 100 + NEW_READ_WORDS, lastReadAt: 60_000 - MIN_READ_GAP_MS };

  it.each([
    ["the first read, once enough is said", base, true],
    ["the first read, one word short", { ...base, words: FIRST_READ_WORDS - 1 }, false],
    ["the first read, pause too short", { ...base, silenceMs: READ_SILENCE_MS - 1 }, false],
    ["while they are speaking", { ...base, silenceMs: 0 }, false],
    ["a later read with enough new words", later, true],
    ["a later read one new word short", { ...later, words: 100 + NEW_READ_WORDS - 1 }, false],
    ["a later read too soon after the last", { ...later, lastReadAt: 60_000 - MIN_READ_GAP_MS + 1 }, false],
    ["a stall with a few new words", { ...later, words: 101, silenceMs: STALL_SILENCE_MS }, true],
    ["a stall just too short", { ...later, words: 101, silenceMs: STALL_SILENCE_MS - 1 }, false],
    ["a stall with nothing new", { ...later, words: 100, silenceMs: Infinity }, false],
    ["a read already in flight", { ...later, inFlight: true }, false],
    ["after the recording ended", { ...later, ended: true }, false],
    ["the last read allowed", { ...later, reads: MAX_READS - 1 }, true],
    ["past the most reads", { ...later, reads: MAX_READS }, false],
    // A turn they have ended hasn't come back as text yet: the read waits to hear it.
    ["a turn's text still to come", { ...later, textOwed: true }, false],
    ["a stall, a turn's text still to come", { ...later, words: 101, silenceMs: Infinity, textOwed: true }, false],
    // A held offer's one read to confirm it: any new words are enough at the first pause.
    ["a reread due, one new word", { ...later, words: 101, reread: true }, true],
    ["a reread due, one new word, pause too short", { ...later, words: 101, reread: true, silenceMs: READ_SILENCE_MS - 1 }, false],
    ["a reread due, nothing new yet", { ...later, words: 100, reread: true, silenceMs: Infinity }, false],
    // It doesn't wait the usual 5 s (the recorder's gap between calls still applies).
    ["a reread due, soon after the last read", { ...later, words: 101, reread: true, lastReadAt: 60_000 - 1 }, true],
    ["a reread due, a turn's text still to come", { ...later, words: 101, reread: true, textOwed: true }, false],
    ["a reread due, a read already in flight", { ...later, words: 101, reread: true, inFlight: true }, false],
    ["a reread due, past the most reads", { ...later, words: 101, reread: true, reads: MAX_READS }, false],
  ])("%s", (_label, input, expected) => {
    expect(shouldRead(input)).toBe(expected);
  });
});

describe("heardSinceRead", () => {
  const base = { words: 40, wordsAtRead: 40, spokenMs: 20_000, spokenAtRead: 20_000 };

  it.each([
    ["nothing since", base, false],
    ["new text", { ...base, words: 41 }, true],
    ["speech whose text hasn't come back", { ...base, spokenMs: 20_000 + HEARD_SINCE_READ_MS + 1 }, true],
    ["a breath or a click", { ...base, spokenMs: 20_000 + HEARD_SINCE_READ_MS }, false],
  ])("%s", (_label, input, expected) => {
    expect(heardSinceRead(input)).toBe(expected);
  });
});

describe("questionHadItsTime", () => {
  const pacing: Pacing = {
    showAfterSilenceMs: 1500,
    stoppedSilenceMs: 5000,
    minQuestionMs: 20_000,
    minWordsPerQuestion: 25,
    firstFollowUpAfterMs: 45_000,
  };
  const base = { now: 100_000, pacing, shownAt: 80_000, wordsSinceShown: 25, elapsedMs: 100_000, onOpening: false };

  it.each([
    ["a follow-up up long enough, with enough said", base, true],
    ["up too briefly", { ...base, shownAt: 80_001 }, false],
    ["too few words", { ...base, wordsSinceShown: 24 }, false],
    ["the opening question, too early", { ...base, onOpening: true, elapsedMs: 44_999 }, false],
    ["the opening question, late enough", { ...base, onOpening: true, elapsedMs: 45_000 }, true],
  ])("%s", (_label, input, expected) => {
    expect(questionHadItsTime(input)).toBe(expected);
  });
});

describe("rereadDue", () => {
  const pacing: Pacing = {
    showAfterSilenceMs: 1500,
    stoppedSilenceMs: 5000,
    minQuestionMs: 20_000,
    minWordsPerQuestion: 25,
    firstFollowUpAfterMs: 45_000,
  };
  const base = { held: true, hadItsTime: true, silenceMs: READ_SILENCE_MS, pacing };

  it.each([
    ["a held offer that could otherwise be shown", base, true],
    ["no offer held", { ...base, held: false }, false],
    // No read is spent on an offer that would wait anyway; the usual reads go on.
    ["before the question on screen has had its time", { ...base, hadItsTime: false }, false],
    ["before then, once they have clearly stopped", { ...base, hadItsTime: false, silenceMs: 5000 }, true],
  ])("%s", (_label, input, expected) => {
    expect(rereadDue(input)).toBe(expected);
  });
});

describe("shouldShow", () => {
  const pacing: Pacing = {
    showAfterSilenceMs: 1500,
    stoppedSilenceMs: 5000,
    minQuestionMs: 20_000,
    minWordsPerQuestion: 25,
    firstFollowUpAfterMs: 45_000,
  };
  // A follow-up question, on screen long enough, with enough said, now a short pause.
  const base = {
    now: 100_000,
    speaking: false,
    silenceMs: 1500,
    pacing,
    shownAt: 80_000,
    wordsSinceShown: 25,
    elapsedMs: 100_000,
    onOpening: false,
    offerRequestedAt: 90_000 as number | null,
    newerReadOut: false,
    heardSinceOffer: false,
  };

  it.each([
    ["a short pause once the question has had its time", base, true],
    ["while they speak", { ...base, speaking: true, silenceMs: 0 }, false],
    ["while they speak, even after a long pause before", { ...base, speaking: true, silenceMs: 60_000 }, false],
    ["no offer waiting", { ...base, offerRequestedAt: null }, false],
    ["an offer from before this question appeared", { ...base, offerRequestedAt: 79_999 }, false],
    ["an offer asked for as this question appeared", { ...base, offerRequestedAt: 80_000 }, true],
    ["a pause too short", { ...base, silenceMs: 1499 }, false],
    ["the question up too briefly", { ...base, shownAt: 80_001 }, false],
    ["too few words for this question", { ...base, wordsSinceShown: 24 }, false],
    ["the opening question, too early", { ...base, onOpening: true, elapsedMs: 44_999 }, false],
    ["the opening question, late enough", { ...base, onOpening: true, elapsedMs: 45_000 }, true],
    ["they have stopped, however briefly the question was up", { ...base, silenceMs: 5000, shownAt: 99_000, wordsSinceShown: 0, onOpening: true, elapsedMs: 1000, offerRequestedAt: 99_500 }, true],
    ["nearly stopped, but too early", { ...base, silenceMs: 4999, shownAt: 99_000, offerRequestedAt: 99_500 }, false],
    ["a newer read still out, which has heard more", { ...base, newerReadOut: true }, false],
    ["a newer read still out, even once they have stopped", { ...base, silenceMs: 60_000, newerReadOut: true }, false],
    ["they have said more since its read was asked for", { ...base, heardSinceOffer: true }, false],
    ["they have said more since its read, even once they have stopped", { ...base, silenceMs: 60_000, heardSinceOffer: true }, false],
  ])("%s", (_label, input, expected) => {
    expect(shouldShow(input)).toBe(expected);
  });

  it("holds an offer while words arrive after its read was asked for, and shows a later read's once it answers", () => {
    // "Team ok lah" (3 words) came back as text after the read at 90 s was asked for.
    const held = heardSinceRead({ words: 43, wordsAtRead: 40, spokenMs: 21_000, spokenAtRead: 21_000 });
    expect(shouldShow({ ...base, heardSinceOffer: held })).toBe(false);
    expect(shouldShow({ ...base, silenceMs: 60_000, heardSinceOffer: held })).toBe(false);
    // The read asked for at 95 s heard it: its offer shows.
    const heard = heardSinceRead({ words: 43, wordsAtRead: 43, spokenMs: 21_000, spokenAtRead: 21_000 });
    expect(shouldShow({ ...base, offerRequestedAt: 95_000, heardSinceOffer: heard })).toBe(true);
  });
});
