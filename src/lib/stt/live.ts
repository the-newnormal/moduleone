import "server-only";
import OpenAI from "openai";
import type { ClientSecretCreateParams } from "openai/resources/realtime/client-secrets";
import { liveSttModel } from "@/lib/checkin/live-config";

// Live transcription while the member records, used only to pick follow-up questions: the uploaded
// recording is still transcribed by transcribe() after submit, and that is the transcript graded.
// The audio goes from the browser straight to OpenAI over WebRTC (Vercel functions can't hold a
// connection open), but the connection is opened here: the browser sends its WebRTC offer to the
// connect route, which calls openLiveTranscription once per live session and hands back OpenAI's
// answer. So no key, not even a short-lived one, ever reaches the browser, and a member can't open
// more transcription sessions than the server starts (#34).

// OpenAI's endpoint that takes a WebRTC offer and opens a realtime session.
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// The short-lived key is used here at once, for the one offer, and thrown away.
const KEY_TTL_SECONDS = 30;
const TIMEOUT_MS = 10_000;
// An SDP answer is a few kilobytes; anything far bigger isn't one.
const MAX_ANSWER_CHARS = 64 * 1024;

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

// Opens the one transcription session for a live recording: a short-lived key for a
// transcription-only session (as configured above), then the browser's WebRTC offer sent to OpenAI
// with it, server to server. Returns OpenAI's SDP answer for the browser. Throws
// LiveTranscriptionError; nothing here logs the offer or the answer.
export async function openLiveTranscription(offer: string, signal?: AbortSignal): Promise<string> {
  const key = await mintLiveTranscriptionKey(signal);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(REALTIME_CALLS_URL, {
      method: "POST",
      body: offer,
      headers: { Authorization: `Bearer ${key.value}`, "Content-Type": "application/sdp", Accept: "application/sdp" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
  } catch (error) {
    throw new LiveTranscriptionError("Couldn't reach OpenAI to connect live transcription.", { config: false, cause: error });
  }
  if (!response.ok) {
    // 400: an offer it won't take (or a session it won't open); 401/403: the key or the model.
    const config = response.status === 401 || response.status === 403 || response.status === 404;
    throw new LiveTranscriptionError(`Couldn't connect live transcription (${response.status}).`, { config });
  }
  const answer = await response.text();
  if (!answer.startsWith("v=0") || answer.length > MAX_ANSWER_CHARS) {
    throw new LiveTranscriptionError("OpenAI's answer to the offer wasn't an SDP answer.", { config: false });
  }
  return answer;
}
