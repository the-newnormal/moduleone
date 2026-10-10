import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS } from "./pacing";
import { connectLiveTranscription, REALTIME_CALLS_URL, toTranscriptEvent } from "./transport";

// The SDK's WebRTC connection is replaced by a fake that behaves like it where this module relies on
// it: events go to subscribers, close() reports a local close once, a failed setup reports a close
// and rejects. No network, no WebRTC.
const { FakeRtc } = vi.hoisted(() => {
  type Handler = (event: { type: string; [key: string]: unknown }) => void;
  type ConnectOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    exchangeSdp: (offer: string, options: { signal: AbortSignal }) => Promise<string>;
  };

  class FakeRtc {
    static instances: FakeRtc[] = [];
    // Runs after the SDP exchange; a test can make the connection drop during setup.
    static duringSetup: ((rtc: FakeRtc) => void) | null = null;

    peerConnection = { addTrack: vi.fn() };
    options: ConnectOptions | null = null;
    answer: string | null = null;
    sent: unknown[] = [];
    sendError: Error | null = null;
    closed = false;
    private events: Handler[] = [];
    private connection: Handler[] = [];

    constructor() {
      FakeRtc.instances.push(this);
    }
    onEvent(handler: Handler) {
      this.events.push(handler);
      return () => {};
    }
    onConnectionEvent(handler: Handler) {
      this.connection.push(handler);
      return () => {};
    }
    async connect(options: ConnectOptions) {
      this.options = options;
      try {
        this.answer = await options.exchangeSdp("v=0 offer", { signal: new AbortController().signal });
      } catch (error) {
        this.finish("failed");
        throw error;
      }
      FakeRtc.duringSetup?.(this);
    }
    send(event: unknown) {
      if (this.sendError) throw this.sendError;
      this.sent.push(event);
    }
    close = vi.fn(() => this.finish("local"));
    finish(reason: string) {
      if (this.closed) return;
      this.closed = true;
      this.connectionEvent({ type: "closed", reason });
    }
    serverEvent(event: { type: string; [key: string]: unknown }) {
      for (const handler of this.events) handler(event);
    }
    connectionEvent(event: { type: string; [key: string]: unknown }) {
      for (const handler of this.connection) handler(event);
    }
  }
  return { FakeRtc };
});

vi.mock("openai/realtime/webrtc", () => ({ OpenAIRealtimeWebRTC: FakeRtc }));

const fetchMock = vi.fn();

function microphone() {
  const clone = { stop: vi.fn() };
  const original = { readyState: "live", stop: vi.fn(), clone: vi.fn(() => clone) };
  const stream = { getAudioTracks: () => [original] } as unknown as MediaStream;
  return { stream, original, clone };
}

async function connected(extra: { signal?: AbortSignal } = {}) {
  const mic = microphone();
  const onEvent = vi.fn();
  const onFailure = vi.fn();
  const connection = await connectLiveTranscription({ stream: mic.stream, clientSecret: "ek_test", onEvent, onFailure, ...extra });
  const rtc = FakeRtc.instances.at(-1)!;
  return { ...mic, onEvent, onFailure, connection, rtc };
}

beforeEach(() => {
  FakeRtc.instances = [];
  FakeRtc.duringSetup = null;
  fetchMock.mockResolvedValue(new Response("v=0 answer", { status: 201, headers: { "content-type": "application/sdp" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectLiveTranscription", () => {
  it("sends a copy of the microphone track and exchanges the offer with the short-lived key", async () => {
    const { rtc, clone, original } = await connected();
    expect(original.clone).toHaveBeenCalledTimes(1);
    expect(rtc.peerConnection.addTrack).toHaveBeenCalledWith(clone);
    expect(rtc.options?.timeoutMs).toBe(CONNECT_TIMEOUT_MS);
    expect(rtc.answer).toBe("v=0 answer");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REALTIME_CALLS_URL);
    expect(init).toMatchObject({
      method: "POST",
      body: "v=0 offer",
      headers: { Authorization: "Bearer ek_test", "Content-Type": "application/sdp" },
      credentials: "omit",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes on transcription events and nothing else", async () => {
    const { rtc, onEvent } = await connected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rtc.serverEvent({ type: "session.created", session: {} });
    rtc.serverEvent({ type: "input_audio_buffer.committed", event_id: "e1", item_id: "item_1", previous_item_id: null });
    rtc.serverEvent({ type: "conversation.item.input_audio_transcription.delta", event_id: "e2", item_id: "item_1", delta: "Shipped the " });
    rtc.serverEvent({ type: "conversation.item.input_audio_transcription.completed", event_id: "e3", item_id: "item_1", content_index: 0, transcript: "Shipped the login page." });
    rtc.serverEvent({ type: "conversation.item.input_audio_transcription.failed", event_id: "e4", item_id: "item_2", content_index: 0, error: {} });
    rtc.serverEvent({ type: "error", event_id: "e5", error: { type: "invalid_request_error", code: "input_audio_buffer_commit_empty", message: "Buffer too small." } });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "committed", itemId: "item_1", previousItemId: null },
      { type: "delta", itemId: "item_1", delta: "Shipped the " },
      { type: "completed", itemId: "item_1", transcript: "Shipped the login page." },
      { type: "failed", itemId: "item_2" },
    ]);
    // An empty commit is expected and not worth a warning.
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a server error by its code only", async () => {
    const { rtc, onEvent, onFailure } = await connected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rtc.serverEvent({ type: "error", error: { type: "invalid_request_error", code: "rate_limited", message: "Something about 'Wei Ling shipped the page'" } });
    expect(warn).toHaveBeenCalledWith("live transcription: server error", { code: "rate_limited" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Wei Ling");
    expect(onEvent).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("commits the turn, and shrugs off a commit that can't be sent", async () => {
    const { rtc, connection } = await connected();
    connection.commit();
    expect(rtc.sent).toEqual([{ type: "input_audio_buffer.commit" }]);
    rtc.sendError = new Error("The WebRTC data channel is not open.");
    expect(() => connection.commit()).not.toThrow();
  });

  it("closes the connection and stops only the copied track", async () => {
    const { rtc, connection, clone, original, onFailure, onEvent } = await connected();
    connection.close();
    connection.close();
    expect(rtc.close).toHaveBeenCalledTimes(1);
    expect(clone.stop).toHaveBeenCalledTimes(1);
    expect(original.stop).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    rtc.serverEvent({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_9", delta: "late" });
    connection.commit();
    expect(onEvent).not.toHaveBeenCalled();
    expect(rtc.sent).toEqual([]);
  });

  it("reports a lost connection once, and lets it go", async () => {
    const { rtc, clone, original, onFailure } = await connected();
    rtc.connectionEvent({ type: "error", fatal: false, error: new Error("invalid message") });
    expect(onFailure).not.toHaveBeenCalled();
    rtc.connectionEvent({ type: "error", fatal: true, error: new Error("transport failed") });
    rtc.finish("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(rtc.close).toHaveBeenCalled();
    expect(clone.stop).toHaveBeenCalled();
    expect(original.stop).not.toHaveBeenCalled();
  });

  it("reports the far end closing", async () => {
    const { rtc, onFailure } = await connected();
    rtc.finish("remote");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("closes when the signal aborts after connecting, without reporting a failure", async () => {
    const controller = new AbortController();
    const { rtc, clone, onFailure } = await connected({ signal: controller.signal });
    expect(rtc.options?.signal).toBe(controller.signal);
    controller.abort();
    expect(rtc.close).toHaveBeenCalled();
    expect(clone.stop).toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("rejects, and lets the copy go, when the key is refused", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorised", { status: 401 }));
    const mic = microphone();
    const onFailure = vi.fn();
    await expect(
      connectLiveTranscription({ stream: mic.stream, clientSecret: "ek_old", onEvent: vi.fn(), onFailure }),
    ).rejects.toThrow("(401)");
    expect(mic.clone.stop).toHaveBeenCalled();
    expect(mic.original.stop).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("rejects when the connection drops while it is being set up", async () => {
    FakeRtc.duringSetup = (rtc) => rtc.finish("remote");
    const mic = microphone();
    const onFailure = vi.fn();
    await expect(
      connectLiveTranscription({ stream: mic.stream, clientSecret: "ek_test", onEvent: vi.fn(), onFailure }),
    ).rejects.toThrow();
    expect(mic.clone.stop).toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("rejects without connecting when there is no live microphone track", async () => {
    const ended = { getAudioTracks: () => [{ readyState: "ended", clone: vi.fn() }] } as unknown as MediaStream;
    const none = { getAudioTracks: () => [] } as unknown as MediaStream;
    for (const stream of [ended, none]) {
      await expect(connectLiveTranscription({ stream, clientSecret: "ek_test", onEvent: vi.fn(), onFailure: vi.fn() })).rejects.toThrow();
    }
    expect(FakeRtc.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("toTranscriptEvent", () => {
  it("fills in what the server left out, and drops what it can't place", () => {
    expect(toTranscriptEvent({ type: "input_audio_buffer.committed", item_id: "a" } as { type: string })).toEqual({
      type: "committed",
      itemId: "a",
      previousItemId: null,
    });
    expect(toTranscriptEvent({ type: "conversation.item.input_audio_transcription.delta", item_id: "a" } as { type: string })).toEqual({
      type: "delta",
      itemId: "a",
      delta: "",
    });
    expect(toTranscriptEvent({ type: "conversation.item.input_audio_transcription.completed" })).toBeNull();
    expect(toTranscriptEvent({ type: "response.done", item_id: "a" } as { type: string })).toBeNull();
  });
});
