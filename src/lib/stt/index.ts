import "server-only";
import { sttConfig } from "./config";
import { transcribeWithOpenAI } from "./openai";
import { TranscriptionError, type AudioInput, type SttTarget, type TranscribeOptions, type TranscriptResult } from "./types";
import { transcriptWarnings } from "./warnings";

export * from "./types";

// Transcribes one check-in recording with the configured model (STT_PROVIDER, STT_MODEL). If that
// fails in a way another model might not, tries the fallback (STT_FALLBACK) once and says so in
// the warnings. Throws TranscriptionError when neither produced a transcript.
export async function transcribe(audio: AudioInput, opts: TranscribeOptions = {}): Promise<TranscriptResult> {
  let config;
  try {
    config = sttConfig();
  } catch (error) {
    throw new TranscriptionError(error instanceof Error ? error.message : "Speech-to-text is misconfigured.", {
      provider: "openai",
      model: "unknown",
      retryable: false,
      cause: error,
    });
  }

  try {
    return await run(config.primary, audio, opts, []);
  } catch (error) {
    if (!config.fallback || !(error instanceof TranscriptionError) || !error.retryable || opts.signal?.aborted) {
      throw error;
    }
    const { provider, model } = config.fallback;
    console.error("transcribe: falling back", { from: `${error.provider}:${error.model}`, to: `${provider}:${model}` });
    return run(config.fallback, audio, opts, [`used_fallback:${provider}:${model}`]);
  }
}

async function run(target: SttTarget, audio: AudioInput, opts: TranscribeOptions, extra: string[]): Promise<TranscriptResult> {
  const text = (await transcribeWithOpenAI(target, audio, opts)).trim();
  return { text, ...target, warnings: [...transcriptWarnings(text, audio.durationSeconds), ...extra] };
}
