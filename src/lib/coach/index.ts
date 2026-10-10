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
import type { ThinkingConfigParam } from "@anthropic-ai/sdk/resources/messages";
import { RubricError } from "@/lib/rubrics/markdown";
import { coachJsonSchema, parseCoachOutput } from "./output";
import { coachInstructions, coachMessage } from "./prompt";
import { CoachError, type CoachRead } from "./types";

export * from "./types";

// The live coach's model, read from COACH_MODEL when it is called (never at import time). It is not
// ANTHROPIC_MODEL: grading can move to a bigger model without slowing the live questions, which have
// to come back within a couple of seconds.
export const DEFAULT_COACH_MODEL = "claude-haiku-5-5";

export function coachModel(env: Record<string, string | undefined> = process.env): string {
  return env.COACH_MODEL?.trim() || DEFAULT_COACH_MODEL;
}

// The fastest thinking setting each model accepts. Haiku 5.5 can turn thinking off (at effort high or
// below); Sonnet 5.5 turns it off with between_tools; Opus 5.5 can't, so it gets none set, which runs
// adaptive thinking at the effort below.
function thinkingFor(model: string): ThinkingConfigParam | undefined {
  if (model.startsWith("claude-haiku-5")) return { type: "disabled" };
  if (model === "claude-sonnet-5-5") return { type: "between_tools" };
  return undefined;
}

// A reply that takes longer than this is no use to someone mid-sentence: the whole call, its one
// retry included, gets this long. Each try gets ATTEMPT_MS.
export const COACH_DEADLINE_MS = 6_000;
const ATTEMPT_MS = 4_000;
// About 150 tokens of JSON with thinking off; room for some thinking on models that can't turn it off.
const MAX_TOKENS = 2_000;

export type CoachUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type CoachReadResult = { read: CoachRead; model: string; usage: CoachUsage; latencyMs: number };

// Reads the transcript so far with Claude: which topics are covered and how far, the mood, and
// Claude's suggestion for the next question. Only the transcript and the ids of topics already asked
// are sent. Throws CoachError: "rubric" (rubrics/coach.md is broken; nothing is sent), "refusal",
// "invalid_output" or "api".
export async function readTranscript(input: {
  transcript: string;
  alreadyAsked: readonly string[];
  signal?: AbortSignal;
}): Promise<CoachReadResult> {
  let instructions;
  try {
    instructions = coachInstructions();
  } catch (error) {
    if (!(error instanceof RubricError)) throw error;
    throw new CoachError("rubrics/coach.md can't be used; fix it and redeploy", { reason: "rubric", retryable: false, cause: error });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new CoachError("Missing ANTHROPIC_API_KEY (server-only).", { reason: "api", retryable: false });
  }
  const model = coachModel();
  const thinking = thinkingFor(model);
  const client = new Anthropic({ apiKey, authToken: null, timeout: ATTEMPT_MS, maxRetries: 1 });
  const deadline = AbortSignal.timeout(COACH_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const started = performance.now();

  let response;
  try {
    response = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        ...(thinking && { thinking }),
        output_config: { effort: "low", format: { type: "json_schema", schema: coachJsonSchema(instructions.rubric) } },
        // The same text on every call, over the 512-token minimum, so calls a few seconds apart read
        // it from the cache. Nothing that varies goes in it.
        system: [{ type: "text", text: instructions.prompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: coachMessage(input.transcript, input.alreadyAsked) }],
      },
      { signal },
    );
  } catch (error) {
    throw apiFailure(error, deadline, input.signal);
  }
  const latencyMs = Math.round(performance.now() - started);

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new CoachError(`Claude declined to read this transcript${category ? ` (${category})` : ""}`, {
      reason: "refusal",
      retryable: false,
    });
  }
  if (response.stop_reason !== "end_turn") {
    throw new CoachError(`The coach's reply ended early (stop_reason ${response.stop_reason})`, {
      reason: "invalid_output",
      retryable: true,
    });
  }
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const usage = response.usage;
  return {
    read: parseCoachOutput(text, instructions.rubric),
    model: response.model,
    latencyMs,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

// As the grader's: the SDK's abort and network errors are subclasses of APIError, so they come first.
function apiFailure(error: unknown, deadline: AbortSignal, callerSignal?: AbortSignal): CoachError {
  const wrap = (message: string, retryable: boolean) => new CoachError(message, { reason: "api", retryable, cause: error });
  if (error instanceof APIUserAbortError) {
    if (deadline.aborted) return wrap(`No reply from the Anthropic API within ${COACH_DEADLINE_MS / 1000} s`, true);
    return wrap(callerSignal?.aborted ? "The coach call was cancelled" : "The coach call was stopped", true);
  }
  if (error instanceof APIConnectionTimeoutError) return wrap("Timed out waiting for the Anthropic API", true);
  if (error instanceof APIConnectionError) return wrap("Couldn't reach the Anthropic API", true);
  if (error instanceof APIError) {
    const retryable =
      error instanceof RateLimitError || error instanceof InternalServerError || error instanceof ConflictError || error.status === 408;
    const detail = [error.type, error.requestID && `request ${error.requestID}`].filter(Boolean).join(", ");
    return wrap(`Anthropic API error ${error.status ?? "(no status)"}${detail ? ` (${detail})` : ""}`, retryable);
  }
  if (error instanceof AnthropicError) return wrap(`The Anthropic SDK rejected the request: ${error.message}`, false);
  return wrap("The coach call failed", false);
}
