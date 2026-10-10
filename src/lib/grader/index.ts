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
import { RubricError } from "@/lib/rubrics/markdown";
import { countWords, GRADER_EFFORT, graderRubricVersion, graderSystemPrompt, transcriptMessage } from "./prompt";
import { GradingError, type Grade, type GradeAttempt } from "./types";

export * from "./types";

// The grading model, read from ANTHROPIC_MODEL when a check-in is graded (never at import time),
// so it can be switched in the Vercel dashboard without a deploy of new code. Haiku is the cheap
// default; claude-sonnet-5-5 is the step up if Haiku's reviews turn out too thin.
export const DEFAULT_GRADER_MODEL = "claude-haiku-5-5";

export function graderModel(env: Record<string, string | undefined> = process.env): string {
  return env.ANTHROPIC_MODEL?.trim() || DEFAULT_GRADER_MODEL;
}

// Models that take the server-side refusal fallback ("default" form, Claude API). Claude Haiku 5.5
// has none: a refusal there is reported as one, and the next attempt tries again.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

// Below this many words there is nothing to grade, and asking Claude would only invent a grade.
export const MIN_TRANSCRIPT_WORDS = 5;

// Thinking is on by default for every model this runs on and counts towards max_tokens, so leave
// room for it as well as the short JSON reply.
const MAX_TOKENS = 16_000;

// One time limit for the whole grading call, the SDK's retries included. Four minutes leaves room
// for long thinking (most of MAX_TOKENS) and matches processCheckin's budget for one attempt, which
// grades with the whole budget whenever it doesn't also transcribe (src/lib/checkin/process.ts).
// A try that runs out of time is not asked for again.
export const GRADER_TIMEOUT_MS = 240_000;

// Claude's safety classifiers can occasionally decline a benign request. With fallbacks on (on the
// models in FALLBACK_MODELS), the API re-runs a declined request on the model Anthropic recommends
// instead of failing it; the grade then records which model answered. This header goes with the
// "default" form only.
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Grades one check-in transcript against the rubric with Claude, in one call that returns the
// scores, theme and review together. Only the transcript is sent. `model` overrides
// ANTHROPIC_MODEL (the side-by-side comparison uses it). `signal` lets the caller stop sooner than GRADER_TIMEOUT_MS (processCheckin keeps a whole attempt
// inside the time its function may run).
// Throws GradingError: "empty_transcript" (nothing to grade; the API is not called), "rubric"
// (rubrics/grading.md is broken; not called either), "refusal", "invalid_output" (the reply was cut
// off or didn't match the schema) or "api".
export async function gradeCheckin(input: { transcript: string; model?: string; signal?: AbortSignal }): Promise<Grade> {
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
  // The rubric file, checked before anything is sent: a broken edit stops grading with a clear
  // reason (and, like a missing key, doesn't use up the check-in's attempts) until it's fixed.
  let system: string;
  let rubricVersion: string;
  try {
    system = graderSystemPrompt();
    rubricVersion = graderRubricVersion();
  } catch (error) {
    if (!(error instanceof RubricError)) throw error;
    throw new GradingError("rubrics/grading.md can't be used; fix it and redeploy", {
      reason: "rubric",
      retryable: false,
      cause: error,
    });
  }
  const model = input.model?.trim() || graderModel();
  const fallback = FALLBACK_MODELS.has(model) ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: "default" as const } : {};
  const client = new Anthropic({ apiKey, authToken: null, timeout: GRADER_TIMEOUT_MS, maxRetries: 2 });
  // The SDK's timeout is per try; this bounds all the tries together.
  const deadline = AbortSignal.timeout(GRADER_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;

  let response;
  try {
    response = await client.beta.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        ...fallback,
        // No `thinking` field: thinking is on by default on these models and effort sets its depth
        // (default medium; grading is a judgement call, so high).
        output_config: {
          effort: GRADER_EFFORT,
          format: { type: "json_schema", schema: GRADE_JSON_SCHEMA },
        },
        // The rubric is the same on every call and long enough to cache (over the 512-token
        // minimum), so check-ins graded within a few minutes of each other read it at a fraction
        // of the price. Nothing that varies goes in the system prompt.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: transcriptMessage(transcript) }],
      },
      { signal },
    );
  } catch (error) {
    throw apiFailure(error, deadline, input.signal);
  }

  // A refusal or a cut-off reply still comes back as a 200 whose text needn't match the schema,
  // so check why the reply ended before reading it.
  if (response.stop_reason === "refusal") {
    // With fallbacks on, a refusal means the fallback model declined too, or couldn't run
    // (rate-limited or overloaded). Only the second sets recommended_model, and may pass later.
    const category = response.stop_details?.category;
    throw new GradingError(`Claude declined to grade this check-in${category ? ` (${category})` : ""}`, {
      reason: "refusal",
      retryable: Boolean(response.stop_details?.recommended_model),
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
  return {
    ...parseGradeOutput(text),
    model: response.model,
    rubricVersion,
    attempts: billedAttempts(response.usage, response.model),
  };
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
};

const toUsage = (usage: Usage) => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
});

// The top-level usage covers only the attempt that answered. When a refusal fallback ran,
// usage.iterations lists each model attempt (the declined one, as a `message` entry, and the
// fallback) with its own model and tokens, so each is priced at its own model's rates.
// A decline that came before any output (no output tokens) is billed only in the bio,
// frontier_llm and reasoning_extraction categories, and a fallback response doesn't say which
// category it was; none of those fits grading a check-in, so such an attempt is left out.
function billedAttempts(
  usage: Usage & { iterations?: ({ type: string; model?: string | null } & Partial<Usage>)[] | null },
  answeredBy: string,
): GradeAttempt[] {
  const iterations = usage.iterations ?? [];
  const fellBack = iterations.some((it) => it.type === "fallback_message");
  const attempts = iterations.flatMap((it) =>
    (it.type === "message" || it.type === "fallback_message") &&
    it.input_tokens !== undefined &&
    it.output_tokens !== undefined &&
    !(fellBack && it.type === "message" && it.output_tokens === 0)
      ? [
          {
            model: it.model ?? answeredBy,
            usage: toUsage({
              input_tokens: it.input_tokens,
              output_tokens: it.output_tokens,
              cache_read_input_tokens: it.cache_read_input_tokens ?? null,
              cache_creation_input_tokens: it.cache_creation_input_tokens ?? null,
            }),
          },
        ]
      : [],
  );
  return attempts.length ? attempts : [{ model: answeredBy, usage: toUsage(usage) }];
}

// The SDK's abort and network errors are subclasses of APIError, so they're checked first.
function apiFailure(error: unknown, deadline: AbortSignal, callerSignal?: AbortSignal): GradingError {
  const wrap = (message: string, retryable: boolean) =>
    new GradingError(message, { reason: "api", retryable, cause: error });
  if (error instanceof APIUserAbortError) {
    if (deadline.aborted) return wrap(`No grade from the Anthropic API within ${GRADER_TIMEOUT_MS / 1000} s`, true);
    return wrap(callerSignal?.aborted ? "Ran out of time for this attempt" : "The grading request was cancelled", true);
  }
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
