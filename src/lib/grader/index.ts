import "server-only";
import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  ConflictError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { GRADE_JSON_SCHEMA, parseGradeOutput } from "./output";
import { countWords, GRADER_SYSTEM_PROMPT, transcriptMessage } from "./prompt";
import { GradingError, type Grade } from "./types";

export * from "./types";

export const GRADER_MODEL = "claude-opus-5-5";

// Below this many words there is nothing to grade, and asking Claude would only invent a grade.
export const MIN_TRANSCRIPT_WORDS = 5;

// Thinking is always on for this model and counts towards max_tokens, so leave room for it as
// well as the short JSON reply.
const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 120_000;

// Claude's safety classifiers can occasionally decline a benign request. With fallbacks on, the
// API re-runs a declined request on the model Anthropic recommends instead of failing it; the
// grade then records which model answered. This header goes with the "default" form only.
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Grades one check-in transcript against the rubric with Claude. Only the transcript is sent.
// Throws GradingError: "empty_transcript" (nothing to grade; the API is not called), "refusal",
// "invalid_output" (the reply was cut off or didn't match the schema) or "api".
export async function gradeCheckin(input: { transcript: string }): Promise<Grade> {
  const transcript = input.transcript.trim();
  if (countWords(transcript) < MIN_TRANSCRIPT_WORDS) {
    throw new GradingError(`The transcript has fewer than ${MIN_TRANSCRIPT_WORDS} words`, {
      reason: "empty_transcript",
      retryable: false,
    });
  }

  // Read here, not at import time, so the app builds without it. The key is passed explicitly and
  // authToken switched off so the SDK never picks up other credentials it finds on the machine.
  // baseURL is left to the SDK, so ANTHROPIC_BASE_URL can point a local end-to-end run elsewhere.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new GradingError("Missing ANTHROPIC_API_KEY (server-only). Set it in .env.local and in Vercel.", {
      reason: "api",
      retryable: false,
    });
  }
  const client = new Anthropic({ apiKey, authToken: null, timeout: TIMEOUT_MS, maxRetries: 2 });

  let response;
  try {
    response = await client.beta.messages.create({
      model: GRADER_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [REFUSAL_FALLBACK_BETA],
      fallbacks: "default",
      // No `thinking` field: on this model thinking is always on and effort sets its depth
      // (default medium; grading is a judgement call, so high).
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: GRADE_JSON_SCHEMA },
      },
      system: GRADER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcriptMessage(transcript) }],
    });
  } catch (error) {
    throw apiFailure(error);
  }

  // A refusal or a cut-off reply still comes back as a 200 whose text needn't match the schema,
  // so check why the reply ended before reading it.
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new GradingError(`Claude declined to grade this check-in${category ? ` (${category})` : ""}`, {
      reason: "refusal",
      retryable: false,
    });
  }
  if (response.stop_reason !== "end_turn") {
    throw new GradingError(`The grader's reply ended early (stop_reason ${response.stop_reason})`, {
      reason: "invalid_output",
      retryable: true,
    });
  }

  // Read by block type: thinking blocks (and a fallback marker, if another model took over) come
  // before the text.
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  return { ...parseGradeOutput(text), model: response.model };
}

// The SDK's abort and network errors are subclasses of APIError, so they're checked first.
function apiFailure(error: unknown): GradingError {
  const wrap = (message: string, retryable: boolean) =>
    new GradingError(message, { reason: "api", retryable, cause: error });
  if (error instanceof APIUserAbortError) return wrap("The grading request was cancelled", true);
  if (error instanceof APIConnectionTimeoutError) return wrap("Timed out waiting for the Anthropic API", true);
  if (error instanceof APIConnectionError) return wrap("Couldn't reach the Anthropic API", true);
  if (error instanceof APIError) {
    // Rate limits, overload (529), server errors and conflicts pass; a bad request, key,
    // permission or model name won't fix itself.
    const retryable =
      error instanceof RateLimitError ||
      error instanceof InternalServerError ||
      error instanceof ConflictError ||
      error.status === 408;
    const detail = [error.type, error.requestID && `request ${error.requestID}`].filter(Boolean).join(", ");
    return wrap(`Anthropic API error ${error.status ?? "(no status)"}${detail ? ` (${detail})` : ""}`, retryable);
  }
  // Anything else was raised before a request went out (the SDK refusing the options, say), so
  // the same call would fail the same way again.
  if (error instanceof AnthropicError) return wrap(`The Anthropic SDK rejected the request: ${error.message}`, false);
  return wrap("The grading request failed", false);
}
