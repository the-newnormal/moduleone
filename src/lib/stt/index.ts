import "server-only";
import type { AudioInput, TranscribeOptions, TranscriptResult } from "./types";

export * from "./types";

/** Transcribe one check-in recording with the configured provider (STT_PROVIDER), with fallback. */
export async function transcribe(
  audio: AudioInput,
  opts?: TranscribeOptions,
): Promise<TranscriptResult> {
  void audio;
  void opts;
  throw new Error("transcribe() is not implemented yet");
}
