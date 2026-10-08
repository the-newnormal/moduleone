import "server-only";
import OpenAI, { toFile } from "openai";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio/transcriptions";
import { TranscriptionError, type AudioInput, type SttTarget, type TranscribeOptions } from "./types";

// OpenAI rejects a request body over 25 MiB with a 413. The bucket allows up to 25 MiB per file,
// so anything at the limit can't fit with the form fields; the recorder stops at 10 minutes
// (about 2.5 MB), well below it.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

// A local Parakeet/OruKey server speaks the same API, so one function serves both; only the
// client and the request fields differ.
function createClient(target: SttTarget): OpenAI {
  if (target.provider === "local") {
    const baseURL = process.env.STT_LOCAL_URL?.trim();
    if (!baseURL) {
      throw new TranscriptionError("Local speech-to-text isn't configured (STT_LOCAL_URL).", {
        ...target,
        retryable: false,
      });
    }
    // Local servers usually ignore the key, but the SDK insists on one.
    return new OpenAI({ apiKey: process.env.STT_LOCAL_API_KEY || "local", baseURL, timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new TranscriptionError("Missing OPENAI_API_KEY (server-only).", { ...target, retryable: false });
  }
  // baseURL is explicit so a stray OPENAI_BASE_URL can't send recordings somewhere else.
  return new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1", timeout: TIMEOUT_MS, maxRetries: 1 });
}

function isoLanguages(tags: readonly string[]): string[] {
  const codes = tags.map((t) => t.split("-")[0].trim().toLowerCase()).filter((t) => /^[a-z]{2}$/.test(t));
  return [...new Set(codes)];
}

function requestFor(target: SttTarget, file: File, languages: string[]): TranscriptionCreateParamsNonStreaming<"json"> {
  // JSON is the one response format every model here supports.
  const base = { file, model: target.model, response_format: "json" as const };
  // gpt-transcribe takes a list of possible languages; the others (and local servers) a single
  // one. Never send both: OpenAI rejects that.
  if (target.provider === "openai" && target.model === "gpt-transcribe") {
    return languages.length ? { ...base, languages } : base;
  }
  return languages.length === 1 ? { ...base, language: languages[0] } : base;
}

export async function transcribeWithOpenAI(
  target: SttTarget,
  audio: AudioInput,
  opts: TranscribeOptions = {},
): Promise<string> {
  if (audio.data.byteLength >= MAX_UPLOAD_BYTES) {
    throw new TranscriptionError("The recording is over the 25 MiB upload limit.", { ...target, retryable: false });
  }
  const client = createClient(target);
  const file = await toFile(audio.data, audio.filename, { type: audio.mimeType.split(";")[0].trim() });
  try {
    const result = await client.audio.transcriptions.create(
      requestFor(target, file, isoLanguages(opts.languages ?? ["en"])),
      { signal: opts.signal },
    );
    return result.text;
  } catch (error) {
    throw toTranscriptionError(target, error);
  }
}

// The SDK's network errors are subclasses of APIError, so they're checked first.
function toTranscriptionError(target: SttTarget, error: unknown): TranscriptionError {
  const wrap = (message: string, retryable: boolean) =>
    new TranscriptionError(message, { ...target, retryable, cause: error });
  if (error instanceof OpenAI.APIUserAbortError) return wrap("Transcription was cancelled.", false);
  if (error instanceof OpenAI.APIConnectionError) return wrap("Couldn't reach the transcription service.", true);
  // Out of credit is a rate-limit status too, but waiting won't fix it.
  if (error instanceof OpenAI.RateLimitError) return wrap("Rate-limited by the transcription service.", error.code !== "insufficient_quota");
  if (error instanceof OpenAI.InternalServerError) return wrap(`Transcription service error (${error.status}).`, true);
  // 403/404: no access to this model, which the fallback model may have. 400 (bad audio), 401
  // (wrong key) and 413 (too big) fail the same way on any model.
  if (error instanceof OpenAI.APIError) {
    return wrap(`Transcription failed (${error.status ?? "no status"}).`, error.status === 403 || error.status === 404);
  }
  return wrap("Transcription failed.", false);
}
