import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import coachFile from "../../../rubrics/coach.md";
import { COACH_DEADLINE_MS, CoachError, coachModel, DEFAULT_COACH_MODEL, readTranscript } from "./index";
import { coachJsonSchema } from "./output";
import { coachInstructions, coachMessage } from "./prompt";
import { coachRubric } from "./rubric";

// readTranscript with the SDK client replaced; its error classes stay real so the error mapping is
// tested against what the SDK actually throws. The coach uses the plain (non-beta) Messages API.
// No network.
const { create, clientOptions } = vi.hoisted(() => ({ create: vi.fn(), clientOptions: [] as unknown[] }));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class Anthropic {
    messages = { create };
    constructor(options: unknown) {
      clientOptions.push(options);
    }
  }
  return { ...actual, default: Anthropic };
});

const TRANSCRIPT =
  "This week I settled the vendor onboarding for the Seletar site, signed on Thursday. Wednesday the client escalated, " +
  "I took the call lah.";
const ASKED = ["excellence_moment"];

const IDS = coachRubric().topics.map((t) => t.id);
const REPLY = {
  coverage: { ...Object.fromEntries(IDS.map((id) => [id, "none"])), activity_work: "clear", activity_outcome: "clear" },
  tone: "neutral",
  wrapping_up: false,
  instructions_in_transcript: false,
  target: "excellence_impact",
  quote: "the client escalated",
  question: "When the client escalated, what difference did your call make?",
};

// A response as the API returns it: thinking off, so text only.
const reply = (overrides: Record<string, unknown> = {}, output: unknown = REPLY) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: DEFAULT_COACH_MODEL,
  content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
  stop_reason: "end_turn",
  stop_details: null,
  usage: { input_tokens: 120, output_tokens: 95, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 },
  ...overrides,
});

// What a reply that came back costs, used or not.
const BILLED = {
  model: DEFAULT_COACH_MODEL,
  usage: { inputTokens: 120, outputTokens: 95, cacheReadTokens: 2400, cacheWriteTokens: 0 },
};

type Request = {
  model: string;
  max_tokens: number;
  thinking?: { type: string };
  output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } };
  system: { type: string; text: string; cache_control?: { type: string } }[];
  messages: { role: string; content: string }[];
};
const sent = () => create.mock.calls[0][0] as Request;

async function coachError(promise: Promise<unknown>): Promise<CoachError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CoachError);
  return error as CoachError;
}

const readIt = (signal?: AbortSignal) => readTranscript({ transcript: TRANSCRIPT, alreadyAsked: ASKED, signal });

beforeEach(() => {
  create.mockReset().mockResolvedValue(reply());
  clientOptions.length = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  vi.stubEnv("COACH_MODEL", "");
  vi.stubEnv("ANTHROPIC_MODEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readTranscript request", () => {
  it("asks Claude Haiku 5.5 by default, thinking off, at low effort, with the coach's schema and cached instructions", async () => {
    await readIt();
    expect(create).toHaveBeenCalledOnce();
    const request = sent();
    // Nothing else: no temperature (rejected by current models), no fallbacks or betas (Haiku has no
    // server-side fallback), no streaming, no old output_format.
    expect(Object.keys(request).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system", "thinking"]);
    expect(request.model).toBe("claude-haiku-5-5");
    expect(request.max_tokens).toBe(2_000);
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(request.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: coachJsonSchema(coachRubric()) },
    });
    expect(request.system).toEqual([{ type: "text", text: coachInstructions().prompt, cache_control: { type: "ephemeral" } }]);
  });

  it("sends the transcript and the topics already asked in one user message, and nothing else about the member", async () => {
    await readIt();
    const request = sent();
    expect(request.messages).toEqual([{ role: "user", content: coachMessage(TRANSCRIPT, ASKED) }]);
    expect(request.messages[0].content).toContain("Already asked: excellence_moment");
    expect(JSON.stringify(request.system)).not.toContain("Seletar");
  });

  it.each<[string, { type: string } | undefined]>([
    ["claude-haiku-5-5", { type: "disabled" }],
    ["claude-sonnet-5-5", { type: "between_tools" }],
    ["claude-opus-5-5", undefined],
  ])("for %s, sets thinking to %j", async (model, thinking) => {
    vi.stubEnv("COACH_MODEL", ` ${model} `);
    await readIt();
    expect(sent().model).toBe(model);
    if (thinking) expect(sent().thinking).toEqual(thinking);
    else expect(sent()).not.toHaveProperty("thinking");
    expect(sent()).not.toHaveProperty("fallbacks");
    expect(sent()).not.toHaveProperty("betas");
  });

  it("takes its model from COACH_MODEL, never from the grader's ANTHROPIC_MODEL", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5-5");
    await readIt();
    expect(sent().model).toBe("claude-haiku-5-5");
  });

  it.each([[{}], [{ COACH_MODEL: "" }], [{ COACH_MODEL: "   " }]])("defaults the model for %j", (env) => {
    expect(coachModel(env)).toBe("claude-haiku-5-5");
  });

  it("builds the client when called, with the key, no other credentials, short tries and one retry", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", " sk-test \n");
    await readIt();
    expect(clientOptions).toEqual([{ apiKey: "sk-test", authToken: null, timeout: 4_000, maxRetries: 1 }]);
  });

  it("gives the whole call, its retry included, one deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await readIt();
    // A question that comes later than this is no use to someone mid-sentence.
    expect(COACH_DEADLINE_MS).toBe(6_000);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(COACH_DEADLINE_MS);
    expect(create.mock.calls[0][1]).toEqual({ signal: timeout.mock.results[0].value });
  });

  it("stops when the caller stops, as well as at the deadline", async () => {
    const caller = new AbortController();
    await readIt(caller.signal);
    const { signal } = create.mock.calls[0][1] as { signal: AbortSignal };
    expect(signal).not.toBe(caller.signal);
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("readTranscript reply", () => {
  it("returns the read, the model that answered, the tokens and how long it took", async () => {
    const result = await readIt();
    expect(result).toEqual({
      read: {
        coverage: REPLY.coverage,
        tone: "neutral",
        wrappingUp: false,
        instructionsInTranscript: false,
        target: "excellence_impact",
        quote: "the client escalated",
        question: "When the client escalated, what difference did your call make?",
      },
      model: "claude-haiku-5-5",
      usage: { inputTokens: 120, outputTokens: 95, cacheReadTokens: 2400, cacheWriteTokens: 0 },
      latencyMs: expect.any(Number),
    });
    expect(Number.isInteger(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("measures the call's time", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_734.6);
    expect((await readIt()).latencyMs).toBe(735);
  });

  it("counts missing cache fields as zero", async () => {
    create.mockResolvedValue(
      reply({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null } }),
    );
    expect((await readIt()).usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("reads the text after any thinking", async () => {
    const text = JSON.stringify(REPLY);
    create.mockResolvedValue(
      reply({
        model: "claude-opus-5-5",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: text.slice(0, 40) },
          { type: "text", text: text.slice(40) },
        ],
      }),
    );
    const result = await readIt();
    expect(result.read.target).toBe("excellence_impact");
    expect(result.model).toBe("claude-opus-5-5");
  });

  it("reports a refusal without reading the content", async () => {
    create.mockResolvedValue(
      reply({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, content: [] }),
    );
    const error = await coachError(readIt());
    expect(error).toMatchObject({ reason: "refusal", retryable: false, billed: BILLED });
    expect(error.message).toContain("cyber");
  });

  it.each([["max_tokens"], ["model_context_window_exceeded"], ["pause_turn"]])(
    "treats a reply that stopped with %s as invalid output worth retrying",
    async (stopReason) => {
      create.mockResolvedValue(reply({ stop_reason: stopReason }, '{"coverage": {"activity_work": "cle'));
      const error = await coachError(readIt());
      expect(error).toMatchObject({ reason: "invalid_output", retryable: true, billed: BILLED });
      expect(error.message).toContain(stopReason);
    },
  );

  it("rejects a reply that doesn't match the schema, or has no text", async () => {
    create.mockResolvedValue(reply({}, { ...REPLY, tone: "sian" }));
    const mismatch = await coachError(readIt());
    expect(mismatch).toMatchObject({ reason: "invalid_output", retryable: true, billed: BILLED });
    expect(mismatch.message).toContain("did not match the schema");
    create.mockResolvedValue(reply({ content: [] }));
    expect(await coachError(readIt())).toMatchObject({ reason: "invalid_output", retryable: true, billed: BILLED });
  });
});

describe("readTranscript API errors", () => {
  const headers = new Headers();
  const body = (type: string) => ({ type: "error", error: { type, message: "boom" } });

  it.each<[string, unknown, boolean]>([
    ["rate limited (429)", new RateLimitError(429, body("rate_limit_error"), "boom", headers), true],
    ["overloaded (529)", new InternalServerError(529, body("overloaded_error"), "boom", headers), true],
    ["a server error (500)", new InternalServerError(500, body("api_error"), "boom", headers), true],
    ["a conflict (409)", new ConflictError(409, body("api_error"), "boom", headers), true],
    ["a request timeout (408)", APIError.generate(408, body("timeout_error"), "boom", headers), true],
    ["no connection", new APIConnectionError({ message: "fetch failed" }), true],
    ["a timeout", new APIConnectionTimeoutError(), true],
    ["a bad request (400)", new BadRequestError(400, body("invalid_request_error"), "boom", headers), false],
    ["a wrong key (401)", new AuthenticationError(401, body("authentication_error"), "boom", headers), false],
    ["no permission (403)", new PermissionDeniedError(403, body("permission_error"), "boom", headers), false],
    ["an unknown model (404)", new NotFoundError(404, body("not_found_error"), "boom", headers), false],
    ["the SDK refusing the request", new AnthropicError("Missing required argument"), false],
    ["a non-SDK error", new TypeError("x is not a function"), false],
  ])("maps %s to retryable %s", async (_label, thrown, retryable) => {
    create.mockRejectedValue(thrown);
    const error = await coachError(readIt());
    expect(error.reason).toBe("api");
    expect(error.retryable).toBe(retryable);
    expect(error.cause).toBe(thrown);
    expect(error.billed).toBeNull(); // no reply came back, so nothing to log
    expect(error.message).not.toContain("sk-test");
    expect(error.message).not.toContain("Seletar");
  });

  it("reports running out of time as worth retrying", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("Timed out", "TimeoutError")));
    create.mockRejectedValue(new APIUserAbortError());
    const error = await coachError(readIt());
    expect(error).toMatchObject({ reason: "api", retryable: true, message: "No reply from the Anthropic API within 6 s" });
  });

  it("says so when the caller cancelled", async () => {
    const caller = new AbortController();
    create.mockImplementation(async (_body: unknown, options: { signal: AbortSignal }) => {
      caller.abort();
      expect(options.signal.aborted).toBe(true);
      throw new APIUserAbortError();
    });
    const error = await coachError(readIt(caller.signal));
    expect(error).toMatchObject({ reason: "api", retryable: true, message: "The coach call was cancelled" });
  });

  it("says the call was stopped when neither the deadline nor the caller stopped it", async () => {
    create.mockRejectedValue(new APIUserAbortError());
    const error = await coachError(readIt());
    expect(error).toMatchObject({ reason: "api", retryable: true, message: "The coach call was stopped" });
  });
});

describe("readTranscript without an API key", () => {
  it.each([[""], ["   "], [undefined]])("fails clearly for ANTHROPIC_API_KEY=%j, without a client or a call", async (value) => {
    vi.stubEnv("ANTHROPIC_API_KEY", value);
    const error = await coachError(readIt());
    expect(error).toMatchObject({ reason: "api", retryable: false });
    expect(error.message).toContain("ANTHROPIC_API_KEY");
    expect(clientOptions).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("readTranscript with a broken rubrics/coach.md", () => {
  afterEach(() => {
    vi.doUnmock("../../../rubrics/coach.md");
    vi.resetModules();
  });

  it("refuses to read, as a fault worth no retry, without a client or a call", async () => {
    // A fresh copy of the coach, which reads the file when first called: the one imported above has
    // already built its instructions from the real file. The edit: the Question style section gone.
    const broken = coachFile.replace(/\n## Question style\n[\s\S]*?(?=\n## )/, "\n");
    expect(broken).not.toBe(coachFile);
    vi.resetModules();
    vi.doMock("../../../rubrics/coach.md", () => ({ default: broken }));
    const { RubricError } = await import("@/lib/rubrics/markdown");
    const fresh = await import("./index");

    const error = await fresh.readTranscript({ transcript: TRANSCRIPT, alreadyAsked: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(fresh.CoachError);
    expect(error).toMatchObject({
      reason: "rubric",
      retryable: false,
      message: "rubrics/coach.md can't be used; fix it and redeploy",
    });
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(RubricError);
    expect((cause as InstanceType<typeof RubricError>).problems).toEqual(['The section "## Question style" is missing.']);
    expect(create).not.toHaveBeenCalled();
    expect(clientOptions).toHaveLength(0);
  });
});
