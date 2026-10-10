// The live coach's contract: what rubrics/coach.md says (CoachRubric), what Claude reports about the
// transcript so far (CoachRead), what the server keeps between calls (CoachState, policy.ts) and
// what the browser is shown (Offer). Safe to import anywhere: no server code, no file reading.

import { QUESTIONS, type QuestionId } from "@/lib/checkin/week";

// The coach's areas are the grader's three dimensions, in the same order.
export type Area = QuestionId;
export const AREAS: readonly Area[] = QUESTIONS.map((q) => q.id);

// How much the member has said about a topic so far. "declined" (nothing to say, or rather not)
// is final: the topic is never asked about again.
export const LEVELS = ["none", "brief", "clear", "declined"] as const;
export type Level = (typeof LEVELS)[number];

// "distress" stops all questions; "hard_week" asks fewer, more gently.
export const TONES = ["neutral", "hard_week", "distress"] as const;
export type Tone = (typeof TONES)[number];

export type Topic = {
  id: string;
  label: string;
  area: Area;
  weight: number;
  // The topic that has to be covered for its area to count as touched (one per area).
  key: boolean;
  // Asked only once this other topic has come up (at least brief).
  needs: string | null;
  // The question shown whenever Claude's own wording isn't used.
  ask: string;
  askHardWeek: string | null;
  // Whether Claude's own wording may be used for this topic (never for morale).
  tailor: boolean;
  // Whether a brief answer counts as answered (never followed up).
  briefIsEnough: boolean;
  // How Claude decides whether it has been covered, sent word for word.
  rules: string;
};

export type CoachSettings = {
  maxFollowUps: number;
  maxPerArea: number;
  briefNeed: number;
  untouchedBonus: number;
  flowBonus: number;
  tailorSlack: number;
  minScore: number;
  minScoreAfterKeys: number;
  minScoreHardWeek: number;
  keysOnlyAfterS: number;
  noNewQuestionsAfterS: number;
  showAfterSilenceS: number;
  stoppedSilenceS: number;
  minQuestionS: number;
  minWordsPerQuestion: number;
  firstFollowUpAfterS: number;
  maxQuestionChars: number;
};

export type CoachLines = { covered: string; late: string; closing: string; beforeYouFinish: string };

export type CoachRubric = {
  opening: string;
  coverageLevels: string;
  mood: string;
  topics: Topic[];
  questionStyle: string;
  lines: CoachLines;
  settings: CoachSettings;
};

// What Claude reports for one read of the transcript so far (output.ts checks it).
export type CoachRead = {
  coverage: Record<string, Level>;
  tone: Tone;
  wrappingUp: boolean;
  instructionsInTranscript: boolean;
  // Claude's pick of the next topic, and its wording for it ("" when it has none).
  target: string | null;
  quote: string;
  question: string;
};

// What the browser shows next. "question" asks about a topic; the others are closing lines.
export const OFFER_KINDS = ["question", "covered", "late", "closing"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];
export type OfferSource = "tailored" | "bank" | "line";
export type Offer = { id: number; kind: OfferKind; topic: string | null; source: OfferSource; text: string };

// Pacing for the browser, from the rubric's settings, in milliseconds.
export type Pacing = {
  showAfterSilenceMs: number;
  stoppedSilenceMs: number;
  minQuestionMs: number;
  minWordsPerQuestion: number;
  firstFollowUpAfterMs: number;
};

// Which areas the member has touched on (their key topic has come up): the only coverage the
// browser ever sees.
export type Touched = Record<Area, boolean>;

export type CoachFailure = "invalid_output" | "refusal" | "api" | "rubric";

export class CoachError extends Error {
  readonly reason: CoachFailure;
  readonly retryable: boolean;

  constructor(message: string, details: { reason: CoachFailure; retryable: boolean; cause?: unknown }) {
    super(message, { cause: details.cause });
    this.name = "CoachError";
    this.reason = details.reason;
    this.retryable = details.retryable;
  }
}
