import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTranscriptionError, mintLiveTranscriptionKey } from "./live";

// The OpenAI SDK calls the global fetch, so each test answers its requests here: no network.
type Call = { url: string; method: string; headers: Headers; body: unknown; signal?: AbortSignal | null };
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    // x-should-retry: false keeps the SDK from retrying on its own, so each test counts requests.
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
const apiError = (status: number) => json(status, { error: { message: "boom", type: "invalid_request_error", code: null, param: null } });

const SECRET = { value: "ek_68af2d1c9e5b4a7f", expires_at: 1_791_432_060, session: { type: "transcription" } };

beforeEach(() => {
  calls = [];
  respond = () => json(200, SECRET);
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
  vi.stubGlobal("fetch", Object.assign(fetch, { Response }));
  vi.stubEnv("OPENAI_API_KEY", "sk-test-live");
  vi.stubEnv("STT_LIVE_MODEL", "");
  vi.stubEnv("OPENAI_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function failure(): Promise<LiveTranscriptionError> {
  const error = await mintLiveTranscriptionKey().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LiveTranscriptionError);
  return error as LiveTranscriptionError;
}

describe("mintLiveTranscriptionKey", () => {
  it("asks OpenAI for a one-minute transcription-only key for gpt-live-transcribe, in English", async () => {
    expect(await mintLiveTranscriptionKey()).toEqual({
      value: "ek_68af2d1c9e5b4a7f",
      expiresAt: 1_791_432_060,
      model: "gpt-live-transcribe",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(call.headers.get("authorization")).toBe("Bearer sk-test-live");
    expect(call.headers.get("content-type")).toMatch(/^application\/json/);
    expect(call.body).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: { model: "gpt-live-transcribe", languages: ["en"] },
            turn_detection: null,
          },
        },
      },
    });
  });

  it("uses STT_LIVE_MODEL when it is set", async () => {
    vi.stubEnv("STT_LIVE_MODEL", "gpt-4o-transcribe");
    expect(await mintLiveTranscriptionKey()).toMatchObject({ model: "gpt-4o-transcribe" });
    expect(calls[0].body).toMatchObject({
      session: { audio: { input: { transcription: { model: "gpt-4o-transcribe", languages: ["en"] } } } },
    });
  });

  // Members' audio must never go anywhere but OpenAI, whatever the environment says.
  it("ignores a stray OPENAI_BASE_URL", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example.sg/v1");
    await mintLiveTranscriptionKey();
    expect(calls[0].url).toBe("https://api.openai.com/v1/realtime/client_secrets");
  });

  it("passes the caller's signal on", async () => {
    const controller = new AbortController();
    respond = (call) =>
      new Promise((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
        controller.abort();
      });
    const error = await mintLiveTranscriptionKey(controller.signal).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LiveTranscriptionError);
    expect((error as LiveTranscriptionError).config).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([[""], ["   "]])("refuses, as a setup problem, without OPENAI_API_KEY (%j), sending nothing", async (value) => {
    vi.stubEnv("OPENAI_API_KEY", value);
    const error = await failure();
    expect(error.config).toBe(true);
    expect(error.message).toBe("Missing OPENAI_API_KEY (server-only).");
    expect(calls).toEqual([]);
  });

  it.each([
    [400, "a request it won't take"],
    [401, "a wrong key"],
    [403, "no access to the model"],
    [404, "no such model"],
  ])("treats %i (%s) as a setup problem", async (status) => {
    respond = () => apiError(status);
    const error = await failure();
    expect(error.config).toBe(true);
    expect(error.message).toBe(`Couldn't start live transcription (${status}).`);
    expect(calls).toHaveLength(1);
  });

  it.each([[500], [503], [429]])("treats %i as a passing outage", async (status) => {
    respond = () => apiError(status);
    const error = await failure();
    expect(error.config).toBe(false);
    expect(error.message).toBe(`Couldn't start live transcription (${status}).`);
  });

  it("never puts the API key in its error", async () => {
    respond = () => apiError(401);
    const error = await failure();
    expect(error.message).not.toContain("sk-test-live");
    expect(error.name).toBe("LiveTranscriptionError");
  });
});
