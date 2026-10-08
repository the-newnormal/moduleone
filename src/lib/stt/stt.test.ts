import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sttConfig } from "./config";
import { transcribe, TranscriptionError, type AudioInput } from "./index";
import { transcriptWarnings } from "./warnings";

// The OpenAI SDK calls the global fetch, so each test answers its requests here: no network.
type Call = { url: string; headers: Headers; form: FormData };
let calls: Call[];
let respond: (call: Call, index: number) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    // x-should-retry: false keeps the SDK from retrying on its own, so each test counts requests.
    headers: { "content-type": "application/json", "x-should-retry": "false", ...headers },
  });
const apiError = (status: number, code: string | null = null) =>
  json(status, { error: { message: "boom", type: "error", code, param: null } });

const AUDIO: AudioInput = {
  data: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/webm;codecs=opus",
  filename: "2026-10-05-take.webm",
};

beforeEach(() => {
  calls = [];
  respond = () => json(200, { text: "  I shipped the login page.  " });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers), form: init?.body as FormData };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  // The SDK checks that fetch can send FormData using fetch.Response, or else by fetching a data:
  // URL; this keeps that probe out of the recorded calls.
  vi.stubGlobal("fetch", Object.assign(fetch, { Response }));
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("STT_PROVIDER", "");
  vi.stubEnv("STT_MODEL", "");
  vi.stubEnv("STT_FALLBACK", undefined);
  vi.stubEnv("STT_LOCAL_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sttConfig", () => {
  it("defaults to OpenAI gpt-transcribe with whisper-1 as the fallback", () => {
    expect(sttConfig({})).toEqual({
      primary: { provider: "openai", model: "gpt-transcribe" },
      fallback: { provider: "openai", model: "whisper-1" },
    });
  });

  it("takes the model and fallback from the environment", () => {
    expect(sttConfig({ STT_MODEL: "gpt-4o-transcribe", STT_FALLBACK: "openai:gpt-4o-mini-transcribe" })).toEqual({
      primary: { provider: "openai", model: "gpt-4o-transcribe" },
      fallback: { provider: "openai", model: "gpt-4o-mini-transcribe" },
    });
  });

  it.each([["none"], ["NONE"], [""]])("turns the fallback off with STT_FALLBACK=%j", (value) => {
    expect(sttConfig({ STT_FALLBACK: value }).fallback).toBeNull();
  });

  it("drops a fallback that is the same model as the main one", () => {
    expect(sttConfig({ STT_MODEL: "whisper-1" }).fallback).toBeNull();
  });

  it("uses the local server's default model, and the provider default for a bare fallback", () => {
    expect(sttConfig({ STT_PROVIDER: "local", STT_FALLBACK: "openai" })).toEqual({
      primary: { provider: "local", model: "parakeet" },
      fallback: { provider: "openai", model: "gpt-transcribe" },
    });
  });

  it.each([["web"], ["assemblyai"]])("rejects an unknown STT_PROVIDER %j", (value) => {
    expect(() => sttConfig({ STT_PROVIDER: value })).toThrow(/Unknown STT_PROVIDER/);
  });

  it("rejects an unknown fallback provider", () => {
    expect(() => sttConfig({ STT_FALLBACK: "acme:fast" })).toThrow(/Unknown STT_FALLBACK/);
  });
});

describe("transcriptWarnings", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  it.each([[""], ["   "]])("flags an empty transcript %j", (text) => {
    expect(transcriptWarnings(text, 60)).toEqual(["empty_transcript"]);
  });

  it("passes ordinary speech", () => {
    expect(transcriptWarnings(words(130), 60)).toEqual([]);
  });

  it("flags far too few words for the recording's length", () => {
    expect(transcriptWarnings(words(20), 60)).toEqual(["low_words_per_minute"]);
  });

  it("doesn't judge the rate of a very short or untimed recording", () => {
    expect(transcriptWarnings(words(3), 20)).toEqual([]);
    expect(transcriptWarnings(words(3))).toEqual([]);
  });

  it("flags a transcript mostly in a non-Latin script", () => {
    expect(transcriptWarnings("这个星期我们完成了登录页面，团队很好")).toEqual(["non_latin_script"]);
  });

  it("allows a few words from another script in an English answer", () => {
    expect(transcriptWarnings("We finished the login page this week and the team is 很好 overall")).toEqual([]);
  });
});

describe("transcribe", () => {
  it("sends the recording to OpenAI gpt-transcribe and returns the trimmed text", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");

    const result = await transcribe({ ...AUDIO, durationSeconds: 4 });

    expect(result).toEqual({ text: "I shipped the login page.", provider: "openai", model: "gpt-transcribe", warnings: [] });
    expect(calls).toHaveLength(1);
    const [{ url, headers, form }] = calls;
    // Never redirected by OPENAI_BASE_URL.
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.getAll("languages[]")).toEqual(["en"]);
    // gpt-transcribe takes a list of languages; sending both is rejected.
    expect(form.get("language")).toBeNull();
    const file = form.get("file") as File;
    expect(file.name).toBe("2026-10-05-take.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO.data);
  });

  it("sends a single language to models that take one", async () => {
    vi.stubEnv("STT_MODEL", "gpt-4o-transcribe");
    await transcribe(AUDIO, { languages: ["en-SG"] });
    expect(calls[0].form.get("language")).toBe("en");
    expect(calls[0].form.getAll("languages[]")).toEqual([]);
  });

  it("adds the checks to the result", async () => {
    respond = () => json(200, { text: "" });
    expect((await transcribe(AUDIO)).warnings).toEqual(["empty_transcript"]);

    respond = () => json(200, { text: "um yes" });
    expect((await transcribe({ ...AUDIO, durationSeconds: 120 })).warnings).toEqual(["low_words_per_minute"]);
  });

  it.each([
    ["a server error", () => apiError(500)],
    ["an overloaded service", () => apiError(503)],
    ["a rate limit", () => apiError(429, "rate_limit_exceeded")],
    ["no access to the model", () => apiError(404, "model_not_found")],
    ["a forbidden model", () => apiError(403)],
  ])("falls back to whisper-1 after %s, and says so", async (_label, failure) => {
    respond = (_call, index) => (index === 0 ? failure() : json(200, { text: "From the fallback." }));

    const result = await transcribe(AUDIO);

    expect(result).toEqual({
      text: "From the fallback.",
      provider: "openai",
      model: "whisper-1",
      warnings: ["used_fallback:openai:whisper-1"],
    });
    expect(calls.map((c) => c.form.get("model"))).toEqual(["gpt-transcribe", "whisper-1"]);
    expect(calls[1].form.get("language")).toBe("en");
  });

  it("falls back when OpenAI can't be reached", async () => {
    respond = (call) => {
      if (call.form.get("model") === "gpt-transcribe") throw new TypeError("fetch failed");
      return json(200, { text: "Fallback text." });
    };
    const result = await transcribe(AUDIO);
    expect(result.model).toBe("whisper-1");
    expect(result.warnings).toEqual(["used_fallback:openai:whisper-1"]);
  });

  it.each([
    ["bad audio", () => apiError(400, "invalid_value"), "Transcription failed (400)."],
    ["a wrong key", () => apiError(401, "invalid_api_key"), "Transcription failed (401)."],
    ["a body over the size limit", () => apiError(413), "Transcription failed (413)."],
    ["no credit left", () => apiError(429, "insufficient_quota"), "Rate-limited by the transcription service."],
  ])("doesn't fall back after %s, which would fail the same way", async (_label, failure, message) => {
    respond = failure;
    const error = await transcribe(AUDIO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error).toMatchObject({ message, provider: "openai", model: "gpt-transcribe", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("throws the main model's error when the fallback is off", async () => {
    vi.stubEnv("STT_FALLBACK", "none");
    respond = () => apiError(500);
    await expect(transcribe(AUDIO)).rejects.toMatchObject({ model: "gpt-transcribe", retryable: true });
    expect(calls).toHaveLength(1);
  });

  it("throws the fallback's error when both fail", async () => {
    respond = () => apiError(500);
    await expect(transcribe(AUDIO)).rejects.toMatchObject({ model: "whisper-1", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it("doesn't fall back once the caller has cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcribe(AUDIO, { signal: controller.signal })).rejects.toMatchObject({ retryable: false });
    expect(calls.map((c) => c.form.get("model"))).not.toContain("whisper-1");
  });

  it("refuses without an OpenAI key, before sending anything", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(transcribe(AUDIO)).rejects.toMatchObject({
      message: "Missing OPENAI_API_KEY (server-only).",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a recording over the upload limit, before sending anything", async () => {
    const big = { ...AUDIO, data: new Uint8Array(25 * 1024 * 1024) };
    await expect(transcribe(big)).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("reports a misconfigured provider as a transcription error", async () => {
    vi.stubEnv("STT_PROVIDER", "web");
    const error = await transcribe(AUDIO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error).toMatchObject({ retryable: false });
    expect(calls).toHaveLength(0);
  });

  describe("with a local OpenAI-compatible server", () => {
    beforeEach(() => {
      vi.stubEnv("STT_PROVIDER", "local");
      vi.stubEnv("STT_FALLBACK", "none");
    });

    it("sends the recording there with a single language and a placeholder key", async () => {
      vi.stubEnv("STT_LOCAL_URL", "http://127.0.0.1:8000/v1");

      const result = await transcribe(AUDIO);

      expect(result).toMatchObject({ provider: "local", model: "parakeet", text: "I shipped the login page." });
      expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
      expect(calls[0].headers.get("authorization")).toBe("Bearer local");
      expect(calls[0].form.get("language")).toBe("en");
      expect(calls[0].form.getAll("languages[]")).toEqual([]);
    });

    it("refuses when STT_LOCAL_URL isn't set", async () => {
      await expect(transcribe(AUDIO)).rejects.toMatchObject({
        message: "Local speech-to-text isn't configured (STT_LOCAL_URL).",
        provider: "local",
        retryable: false,
      });
      expect(calls).toHaveLength(0);
    });
  });
});
