// The transcribe() contract. OpenAI does the transcribing today; a local Parakeet/OruKey server
// (OpenAI-compatible) can take over behind the same interface, so the check-in pipeline never
// knows which one ran.

export type SttProvider = "openai" | "local";

export type SttTarget = { provider: SttProvider; model: string };

export type AudioInput = {
  data: Uint8Array;
  // As stored, e.g. "audio/webm" or "audio/mp4".
  mimeType: string;
  // With the right extension: the service works out the format from it.
  filename: string;
  // From the recorder, if known. Only used for the words-per-minute check.
  durationSeconds?: number;
};

export type TranscribeOptions = {
  // ISO 639-1 language hints. Default ["en"] (Singapore English).
  languages?: string[];
  signal?: AbortSignal;
};

export type TranscriptResult = {
  text: string;
  provider: SttProvider;
  model: string;
  // Stable codes stored with the transcript (see warnings.ts), plus
  // "used_fallback:<provider>:<model>" when the fallback model did the work.
  warnings: string[];
};

export class TranscriptionError extends Error {
  readonly provider: SttProvider;
  readonly model: string;
  // True when the same recording might go through later or on the fallback model (outage,
  // timeout, rate limit, no access to the model). False when it never will (bad or oversized
  // audio, a wrong key, nothing configured).
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { provider: SttProvider; model: string; retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.name = "TranscriptionError";
    this.provider = details.provider;
    this.model = details.model;
    this.retryable = details.retryable;
  }
}
