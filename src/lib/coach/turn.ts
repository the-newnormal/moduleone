// One coach request from the recorder, start to finish: note what the screen shows now (or that the
// member asked for a different question), read the transcript with Claude if enough new words have
// come in, then decide what to show next. Claude's read is passed in, so this runs in tests without
// the API; the route (src/app/portal/checkin/live/coach/route.ts) passes readTranscript.

import { countWords } from "@/lib/grader/prompt";
import { acknowledge, mergeRead, nextOffer, skip, touched, type CoachState } from "./policy";
import { CoachError, type CoachRead, type CoachRubric, type Offer, type Touched } from "./types";

// Claude reads the transcript only once there is something new to read: the first time at this many
// words, then after this many more. A call with fewer just re-decides from what is known.
export const FIRST_READ_WORDS = 12;
export const NEW_READ_WORDS = 8;

export type TurnRead = { read: CoachRead; model: string; usage: unknown; latencyMs: number };

export type TurnResult<R extends TurnRead> = {
  state: CoachState;
  offer: Offer | null;
  touched: Touched;
  // The read this turn made, if any (its usage is logged as a cost), and why it failed, if it did.
  result: R | null;
  failure: CoachError | null;
};

export async function coachTurn<R extends TurnRead>(input: {
  state: CoachState;
  rubric: CoachRubric;
  transcript: string;
  elapsedS: number;
  // The offer on screen now, and the one the member asked to replace ("Different question").
  shown: number | null;
  skip: number | null;
  read: (alreadyAsked: string[]) => Promise<R>;
}): Promise<TurnResult<R>> {
  const { rubric, transcript, elapsedS } = input;
  let state = input.state;
  if (input.shown !== null) state = acknowledge(state, input.shown, rubric);
  const skipping = input.skip !== null && input.skip === state.current;
  if (skipping && input.skip !== null) state = skip(state, input.skip);

  const ended = state.tone === "distress" || state.linesShown.some((l) => l !== "beforeYouFinish");
  const words = countWords(transcript);
  const enough = state.counts.reads === 0 ? words >= FIRST_READ_WORDS : words >= state.wordsRead + NEW_READ_WORDS;
  let result: R | null = null;
  let failure: CoachError | null = null;
  // A skip wants a new question straight away, from what is already known.
  if (!skipping && !ended && enough) {
    try {
      result = await input.read([...state.asked, ...state.skipped]);
      state = mergeRead(state, result.read, rubric);
      state = {
        ...state,
        wordsRead: words,
        counts: {
          ...state.counts,
          reads: state.counts.reads + 1,
          latencyMs: state.counts.latencyMs + result.latencyMs,
          slowestMs: Math.max(state.counts.slowestMs, result.latencyMs),
        },
      };
    } catch (error) {
      if (!(error instanceof CoachError)) throw error;
      failure = error;
      state = { ...state, counts: { ...state.counts, failures: state.counts.failures + 1 } };
    }
  }

  const decision = nextOffer(state, { rubric, elapsedS, read: result?.read ?? null, transcript });
  return { state: decision.state, offer: decision.offer, touched: touched(decision.state, rubric), result, failure };
}
