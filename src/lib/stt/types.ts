// The transcribe() contract. Every provider (OpenAI, AssemblyAI, a local Parakeet/OruKey server)
// sits behind it, so the check-in pipeline never knows which one ran.

export type SttProvider = "openai" | "assemblyai" | "local";

export type AudioInput = {
  /** The recording's bytes. */
  data: Uint8Array;
  /** As stored, e.g. 'audio/webm' or 'audio/mp4'. */
  mimeType: string;
  /** A file name with the right extension (providers sniff it), e.g. '2026-10-05-<uuid>.webm'. */
  filename: string;
  /** From the recorder, if known. Only used for the words-per-minute warning. */
  durationSeconds?: number;
};

export type TranscribeOptions = {
  /** BCP-47 language hints. Default ['en'] (Singapore English). */
  languages?: string[];
  /** Names and terms the speaker is likely to use (team names, products). */
  keyterms?: string[];
  signal?: AbortSignal;
};

export type TranscriptResult = {
  text: string;
  provider: SttProvider;
  model: string;
  /** Stable codes, e.g. 'empty_transcript', 'low_words_per_minute', 'used_fallback:openai:whisper-1'. */
  warnings: string[];
};

export class TranscriptionError extends Error {
  readonly provider: SttProvider;
  readonly model: string;
  /** True when trying again later (or on the fallback) might work. */
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
