// The shape Claude must answer in, twice: as the JSON schema sent with the request (structured
// outputs constrain the reply to it) and as the zod schema that checks the reply anyway, since a
// cut-off reply or a fallback model can still return something else.
//
// Structured outputs reject numeric and string-length keywords (minimum, maxLength, ...), so the
// JSON schema uses enums and describes the review's length in words; zod enforces the limits.

import { z } from "zod";
import { CATEGORIES, GradingError, type Grade } from "./types";

export const REVIEW_MAX_CHARS = 1200;

const score = (description: string) => ({ type: "integer", enum: [1, 2, 3, 4, 5], description });

export const GRADE_JSON_SCHEMA = {
  type: "object",
  properties: {
    activity: score("What they got done this week, 1 to 5 by the rubric."),
    excellence: score("Use of their or their team's strengths (superpower), 1 to 5 by the rubric."),
    morale: score("How they feel about the team, 1 to 5 by the rubric."),
    category: {
      type: "string",
      enum: [...CATEGORIES],
      description: "The check-in's single main theme. Never a colour.",
    },
    review: {
      type: "string",
      description: `Two to four sentences for the team leader and HQ, at most ${REVIEW_MAX_CHARS} characters.`,
    },
  },
  required: ["activity", "excellence", "morale", "category", "review"],
  additionalProperties: false,
};

const Score = z.literal([1, 2, 3, 4, 5]);

const GradeOutput = z.strictObject({
  activity: Score,
  excellence: Score,
  morale: Score,
  category: z.enum(CATEGORIES),
  review: z.string().trim().min(1).max(REVIEW_MAX_CHARS),
});

// Parses Claude's reply into a grade, or throws GradingError('invalid_output'). The message names
// the fields that failed, never their values: the review can quote the transcript.
export function parseGradeOutput(text: string): Omit<Grade, "model"> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new GradingError("The grader's reply was not valid JSON", {
      reason: "invalid_output",
      retryable: true,
      cause: error,
    });
  }
  const result = GradeOutput.safeParse(json);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join(", ");
    throw new GradingError(`The grader's reply did not match the grade schema (${fields})`, {
      reason: "invalid_output",
      retryable: true,
      cause: result.error,
    });
  }
  return result.data;
}
