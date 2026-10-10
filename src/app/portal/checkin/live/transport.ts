// The browser's connection to OpenAI's realtime transcription, over WebRTC. The offer goes to the
// server (exchange: the connect route), which opens the session with OpenAI and returns its answer,
// so the browser never holds a key; the audio then goes straight to OpenAI. It sends a copy of the
// microphone track (the recording keeps the original) and hands back transcript events
// (transcript.ts). Only "openai/realtime/webrtc" is imported: the
// rest of the OpenAI client is server code and shouldn't reach the browser bundle.
// Nothing here logs what was said: transcript text is passed on and never written anywhere.

import { OpenAIRealtimeWebRTC } from "openai/realtime/webrtc";
import { CONNECT_TIMEOUT_MS } from "./pacing";
import type { TranscriptEvent } from "./transcript";

export type LiveConnection = {
  // Ends the current turn: what they said since the last commit is transcribed as one item.
  commit(): void;
  // Closes the connection and stops the copied track. Safe to call twice.
  close(): void;
};

// A server event as transcript.ts needs it, or null for everything else.
// Fields are checked, not trusted: the server may send event types and shapes newer than this code.
export function toTranscriptEvent(event: { type: string }): TranscriptEvent | null {
  const fields = event as Record<string, unknown>;
  const itemId = fields.item_id;
  if (typeof itemId !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  switch (event.type) {
    case "input_audio_buffer.committed":
      return { type: "committed", itemId, previousItemId: typeof fields.previous_item_id === "string" ? fields.previous_item_id : null };
    case "conversation.item.input_audio_transcription.delta":
      return { type: "delta", itemId, delta: text(fields.delta) };
    case "conversation.item.input_audio_transcription.completed":
      return { type: "completed", itemId, transcript: text(fields.transcript) };
    case "conversation.item.input_audio_transcription.failed":
      return { type: "failed", itemId };
    default:
      return null;
  }
}

// Committing with nothing new in the buffer is answered with this error, and does no harm.
const EMPTY_COMMIT = "input_audio_buffer_commit_empty";

// Connects, or rejects (no microphone track, no WebRTC, the offer refused, CONNECT_TIMEOUT_MS passing,
// `signal` aborting). Once connected, onFailure is called at most once if the connection is lost;
// after that, or after close(), no more events arrive. Aborting `signal` later closes it too.
export async function connectLiveTranscription({
  stream,
  exchange,
  onEvent,
  onFailure,
  signal,
  timeoutMs = CONNECT_TIMEOUT_MS,
}: {
  stream: MediaStream;
  // Sends the WebRTC offer (SDP) on and resolves to the answer, or rejects.
  exchange: (offer: string, signal: AbortSignal) => Promise<string>;
  onEvent: (event: TranscriptEvent) => void;
  onFailure: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LiveConnection> {
  const original = stream.getAudioTracks()[0];
  if (!original || original.readyState === "ended") throw new Error("live transcription: no microphone track");
  signal?.throwIfAborted();
  // A copy, so closing this connection never stops the recording's microphone.
  const track = original.clone();

  let rtc: OpenAIRealtimeWebRTC;
  try {
    rtc = new OpenAIRealtimeWebRTC();
  } catch (error) {
    track.stop();
    throw error;
  }

  let state: "connecting" | "open" | "closed" = "connecting";
  // Lost between connecting and this function returning.
  let lostWhileConnecting = false;

  const shut = () => {
    if (state === "closed") return;
    state = "closed";
    signal?.removeEventListener("abort", shut);
    rtc.close();
    track.stop();
  };
  const lost = () => {
    if (state === "connecting") lostWhileConnecting = true;
    if (state !== "open") return;
    shut();
    onFailure();
  };

  // Subscribed before connecting, so nothing sent straight after is missed.
  rtc.onEvent((event) => {
    if (state !== "open") return;
    if (event.type === "error") {
      // Only the code: an error's message can quote what was sent.
      const code = event.error.code ?? event.error.type;
      if (code !== EMPTY_COMMIT) console.warn("live transcription: server error", { code });
      return;
    }
    const mapped = toTranscriptEvent(event);
    if (mapped) onEvent(mapped);
  });
  rtc.onConnectionEvent((event) => {
    if ((event.type === "error" && event.fatal) || (event.type === "closed" && event.reason !== "local")) lost();
  });

  try {
    rtc.peerConnection.addTrack(track);
    await rtc.connect({
      signal,
      timeoutMs,
      exchangeSdp: (offer, { signal: exchanging }) => exchange(offer, exchanging),
    });
  } catch (error) {
    shut();
    throw error;
  }
  if (lostWhileConnecting || signal?.aborted) {
    shut();
    throw new Error("live transcription: the connection closed while connecting");
  }

  state = "open";
  signal?.addEventListener("abort", shut, { once: true });
  return {
    commit() {
      if (state !== "open") return;
      try {
        rtc.send({ type: "input_audio_buffer.commit" });
      } catch {
        // The channel is closing; the connection events say so.
      }
    },
    close: shut,
  };
}
