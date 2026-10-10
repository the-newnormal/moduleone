import "server-only";
import OpenAI from "openai";
import type { ClientSecretCreateParams } from "openai/resources/realtime/client-secrets";
import { liveSttModel } from "@/lib/checkin/live-config";

// Live transcription while the member records, used only to pick follow-up questions: the uploaded
// recording is still transcribed by transcribe() after submit, and that is the transcript graded.
// The browser connects to OpenAI's realtime API itself (Vercel functions can't hold a socket open),
// with a short-lived key minted here, so OPENAI_API_KEY never leaves the server.

// Long enough for the browser to connect (it gives up after 8 s; see pacing.ts), and no longer: until
// it expires the key can open more sessions than the one the recorder opens, on this account's bill
// (a member who dug it out of their browser could), and OpenAI can't limit a key to one session.
// A session that has started carries on after it (the recorder stops at 10 minutes).
const KEY_TTL_SECONDS = 30;
const TIMEOUT_MS = 10_000;

export type LiveTranscriptionKey = { value: string; expiresAt: number; model: string };

export class LiveTranscriptionError extends Error {
  // Set when the setup is at fault (no key, no access to the model), not a passing outage.
  readonly config: boolean;

  constructor(message: string, details: { config: boolean; cause?: unknown }) {
    super(message, { cause: details.cause });
    this.name = "LiveTranscriptionError";
    this.config = details.config;
  }
}

export async function mintLiveTranscriptionKey(signal?: AbortSignal): Promise<LiveTranscriptionKey> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new LiveTranscriptionError("Missing OPENAI_API_KEY (server-only).", { config: true });
  const model = liveSttModel();
  // baseURL is explicit so a stray OPENAI_BASE_URL can't send members' audio somewhere else.
  const client = new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1", timeout: TIMEOUT_MS, maxRetries: 1 });
  const params: ClientSecretCreateParams = {
    expires_after: { anchor: "created_at", seconds: KEY_TTL_SECONDS },
    session: {
      type: "transcription",
      audio: {
        input: {
          // gpt-live-transcribe takes a list of likely languages, like the batch model (openai.ts).
          transcription: { model, languages: ["en"] },
          // gpt-live-transcribe has no voice detection of its own: the recorder ends each turn when the
          // member pauses (input_audio_buffer.commit).
          turn_detection: null,
        },
      },
    },
  };
  try {
    const secret = await client.realtime.clientSecrets.create(params, { signal });
    return { value: secret.value, expiresAt: secret.expires_at, model };
  } catch (error) {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    // 401: a wrong key; 403/404: no access to the model; 400: a request it won't take. All need a fix.
    const config = status === 400 || status === 401 || status === 403 || status === 404;
    throw new LiveTranscriptionError(`Couldn't start live transcription (${status ?? "no status"}).`, { config, cause: error });
  }
}
