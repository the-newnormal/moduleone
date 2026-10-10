import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLiveSession } from "@/lib/checkin/live-sessions";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import { LiveTranscriptionError, openLiveTranscription } from "@/lib/stt/live";
import { MAX_OFFER_CHARS } from "../contract";
import { POST } from "./route";

vi.mock("@/lib/checkin/session", () => ({ sessionMember: vi.fn(), noticeAccepted: vi.fn() }));
vi.mock("@/lib/checkin/live-sessions", () => ({ connectLiveSession: vi.fn() }));
vi.mock("@/lib/stt/live", async () => ({
  ...(await vi.importActual<typeof import("@/lib/stt/live")>("@/lib/stt/live")),
  openLiveTranscription: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000002";
const SESSION_ID = "1f5e0000-0000-4000-8000-000000000001";
const SESSION = {
  supabase: {},
  authUserId: "5eed0000-0000-4000-8000-000000000003",
  member: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" },
} as unknown as Session;
const OFFER = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER = "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 3478 UDP/TLS/RTP/SAVPF 111\r\n";

// A header given as "" is left out.
function post(body: unknown = { sessionId: SESSION_ID, offer: OFFER }, headers: Record<string, string> = {}): Request {
  const all = { origin: ORIGIN, host: "localhost:3000", "content-type": "application/json", ...headers };
  return new Request(`${ORIGIN}/portal/checkin/live/connect`, {
    method: "POST",
    headers: Object.fromEntries(Object.entries(all).filter(([, value]) => value !== "")),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("LIVE_CHECKIN", "on");
  vi.mocked(sessionMember).mockReset().mockResolvedValue(SESSION);
  vi.mocked(noticeAccepted).mockReset().mockResolvedValue(true);
  vi.mocked(connectLiveSession).mockReset().mockResolvedValue(true);
  vi.mocked(openLiveTranscription).mockReset().mockResolvedValue(ANSWER);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /portal/checkin/live/connect", () => {
  it("claims the session's one connection, then opens the transcription and hands back OpenAI's answer", async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "connected", answer: ANSWER });
    expect(connectLiveSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER);
    expect(openLiveTranscription).toHaveBeenCalledExactlyOnceWith(OFFER, expect.any(AbortSignal));
    expect(vi.mocked(connectLiveSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(openLiveTranscription).mock.invocationCallOrder[0],
    );
  });

  it("takes the member from the session, never from the request", async () => {
    await POST(post({ sessionId: SESSION_ID, offer: OFFER, memberId: OTHER }));
    // A strict body: an extra field is refused outright.
    expect(connectLiveSession).not.toHaveBeenCalled();
    await POST(post());
    expect(connectLiveSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER);
  });

  it("checks who is calling, not the notice again (checked when the session started)", async () => {
    await POST(post());
    expect(sessionMember).toHaveBeenCalledOnce();
    expect(noticeAccepted).not.toHaveBeenCalled();
  });

  it.each([
    ["no Origin", { origin: "" }],
    ["another site's Origin", { origin: "https://evil.example" }],
    ["a body that isn't JSON", { "content-type": "text/plain" }],
  ])("refuses a request with %s, opening nothing", async (_label, headers) => {
    const response = await POST(post(undefined, headers));
    expect(response.status).toBe(400);
    expect(connectLiveSession).not.toHaveBeenCalled();
    expect(openLiveTranscription).not.toHaveBeenCalled();
  });

  it.each([
    ["no session id", { offer: OFFER }],
    ["a session id that isn't one", { sessionId: "1", offer: OFFER }],
    ["no offer", { sessionId: SESSION_ID }],
    ["an offer that isn't SDP", { sessionId: SESSION_ID, offer: "hello" }],
    ["an offer far too big", { sessionId: SESSION_ID, offer: `v=0\r\n${"a".repeat(MAX_OFFER_CHARS)}` }],
  ])("refuses %s, opening nothing", async (_label, body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "bad_request" });
    expect(connectLiveSession).not.toHaveBeenCalled();
    expect(openLiveTranscription).not.toHaveBeenCalled();
  });

  it("refuses when live check-ins have been switched off", async () => {
    vi.stubEnv("LIVE_CHECKIN", "off");
    const response = await POST(post());
    expect(response.status).toBe(410);
    expect(openLiveTranscription).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    vi.mocked(sessionMember).mockResolvedValue("signed_out");
    const response = await POST(post());
    expect(response.status).toBe(401);
    expect(connectLiveSession).not.toHaveBeenCalled();
    expect(openLiveTranscription).not.toHaveBeenCalled();
  });

  it.each([
    ["no_session", 404],
    ["unavailable", 503],
  ] as const)("opens nothing when the connection can't be claimed (%s): not theirs, over, or connected already", async (problem, status) => {
    vi.mocked(connectLiveSession).mockResolvedValue(problem);
    const response = await POST(post());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ status: "error", code: problem });
    expect(openLiveTranscription).not.toHaveBeenCalled();
  });

  it.each([
    ["a setup problem", true],
    ["a passing outage", false],
  ])("is unavailable when OpenAI won't connect it (%s), logging no offer, answer or key", async (_label, config) => {
    vi.mocked(openLiveTranscription).mockRejectedValue(
      new LiveTranscriptionError("Couldn't connect live transcription (401).", {
        config,
        cause: new Error("Incorrect API key provided: sk-proj-abc123"),
      }),
    );
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", code: "unavailable" });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live: connecting the transcription failed", {
      config,
      error: "Couldn't connect live transcription (401).",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/sk-proj|ek_|v=0|IN IP4/);
  });

  it("logs only the name of an error it didn't expect", async () => {
    vi.mocked(openLiveTranscription).mockRejectedValue(new TypeError(`bad offer ${OFFER}`));
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live: connecting the transcription failed", {
      config: false,
      error: "TypeError",
    });
  });
});
