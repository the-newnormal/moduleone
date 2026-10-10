// The rubric grader's contract. Scores are whole numbers 1–5; `category` is the check-in's main
// theme. It is never a colour: heat-map colours come only from src/lib/health and scoring_settings.

export const CATEGORIES = ["delivery", "collaboration", "growth", "wellbeing", "blockers"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Score = 1 | 2 | 3 | 4 | 5;

export type Grade = {
  activity: Score;
  excellence: Score;
  morale: Score;
  category: Category;
  // 2–4 sentences for leaders and hq. Members never see it.
  review: string;
  // The model that actually produced the grade (after any refusal fallback).
  model: string;
  // Fingerprint of the grading instructions used (rubrics/grading.md and the rules around it).
  rubricVersion: string;
  // Every billed model attempt in the call, for the cost log: one, or more when a refusal fallback
  // took over (the declined attempt is billed too). Output includes thinking.
  attempts: GradeAttempt[];
};

export type GradeAttempt = { model: string; usage: GradeUsage };

export type GradeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// "rubric": rubrics/grading.md can't be used (a broken edit); nothing is sent until it's fixed.
export type GradingFailure = "empty_transcript" | "refusal" | "invalid_output" | "api" | "rubric";

export class GradingError extends Error {
  readonly reason: GradingFailure;
  // True when trying again later might work.
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { reason: GradingFailure; retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.name = "GradingError";
    this.reason = details.reason;
    this.retryable = details.retryable;
  }
}
