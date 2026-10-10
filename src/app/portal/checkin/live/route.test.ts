import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLiveSession } from "@/lib/checkin/live-sessions";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import { parseCoachRubric } from "@/lib/coach/rubric";
import { mintLiveTranscriptionKey, openLiveTranscription } from "@/lib/stt/live";
import { POST } from "./route";

// The coach's prompt and rubric are the real ones, read from rubrics/coach.md.
vi.mock("@/lib/checkin/session", () => ({ sessionMember: vi.fn(), noticeAccepted: vi.fn() }));
vi.mock("@/lib/checkin/live-sessions", () => ({ startLiveSession: vi.fn() }));
// Watched only to show the start route never touches OpenAI: the connect route opens the transcription.
vi.mock("@/lib/stt/live", () => ({ mintLiveTranscriptionKey: vi.fn(), openLiveTranscription: vi.fn() }));

const ORIGIN = "http://localhost:3000";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000002";
const SESSION_ID = "1f5e0000-0000-4000-8000-000000000001";
const SESSION = {
  supabase: {},
  authUserId: "5eed0000-0000-4000-8000-000000000003",
  member: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" },
} as unknown as Session;

const RUBRIC = parseCoachRubric(readFileSync(new URL("../../../../../rubrics/coach.md", import.meta.url), "utf8"));

// A header given as "" is left out.
function post(body: unknown = {}, headers: Record<string, string> = {}): Request {
  const all = { origin: ORIGIN, host: "localhost:3000", "content-type": "application/json", ...headers };
  return new Request(`${ORIGIN}/portal/checkin/live`, {
    method: "POST",
    headers: Object.fromEntries(Object.entries(all).filter(([, value]) => value !== "")),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("LIVE_CHECKIN", "on");
  vi.stubEnv("STT_LIVE_MODEL", "");
  vi.stubEnv("COACH_MODEL", "");
  vi.mocked(sessionMember).mockReset().mockResolvedValue(SESSION);
  vi.mocked(noticeAccepted).mockReset().mockResolvedValue(true);
  vi.mocked(startLiveSession).mockReset().mockResolvedValue({ id: SESSION_ID });
  vi.mocked(mintLiveTranscriptionKey).mockReset();
  vi.mocked(openLiveTranscription).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /portal/checkin/live", () => {
  it("starts a session and hands the browser its id, the opening question and the pacing: no key", async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ready",
      sessionId: SESSION_ID,
      sttModel: "gpt-live-transcribe",
      opening: RUBRIC.opening,
      pacing: {
        showAfterSilenceMs: RUBRIC.settings.showAfterSilenceS * 1000,
        stoppedSilenceMs: RUBRIC.settings.stoppedSilenceS * 1000,
        minQuestionMs: RUBRIC.settings.minQuestionS * 1000,
        minWordsPerQuestion: RUBRIC.settings.minWordsPerQuestion,
        firstFollowUpAfterMs: RUBRIC.settings.firstFollowUpAfterS * 1000,
      },
    });
    expect(RUBRIC.opening).not.toBe("");
  });

  it("records the models and the coach rubric's version with the session, for the session's member", async () => {
    await POST(post({ memberId: OTHER }));
    expect(startLiveSession).toHaveBeenCalledExactlyOnceWith(MEMBER, {
      stt: "openai:gpt-live-transcribe",
      coach: "claude-haiku-5-5",
      coachRubric: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("names the models the environment chose", async () => {
    vi.stubEnv("STT_LIVE_MODEL", "gpt-4o-transcribe");
    vi.stubEnv("COACH_MODEL", "claude-sonnet-5-5");
    await POST(post());
    expect(startLiveSession).toHaveBeenCalledWith(
      MEMBER,
      expect.objectContaining({ stt: "openai:gpt-4o-transcribe", coach: "claude-sonnet-5-5" }),
    );
  });

  it("never mints a key or opens a transcription (the connect route does, once per session)", async () => {
    await POST(post());
    expect(mintLiveTranscriptionKey).not.toHaveBeenCalled();
    expect(openLiveTranscription).not.toHaveBeenCalled();
  });

  it.each([
    ["no Origin", { origin: "" }],
    ["another site's Origin", { origin: "https://evil.example" }],
    ["a body that isn't JSON", { "content-type": "text/plain" }],
  ])("refuses a request with %s", async (_label, headers) => {
    const response = await POST(post({}, headers));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "bad_request" });
    expect(sessionMember).not.toHaveBeenCalled();
    expect(startLiveSession).not.toHaveBeenCalled();
  });

  it("says live check-ins are off when LIVE_CHECKIN isn't on, and starts nothing", async () => {
    vi.stubEnv("LIVE_CHECKIN", "off");
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "off" });
    expect(sessionMember).not.toHaveBeenCalled();
    expect(startLiveSession).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    vi.mocked(sessionMember).mockResolvedValue("signed_out");
    const response = await POST(post());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "error", code: "signed_out" });
    expect(startLiveSession).not.toHaveBeenCalled();
  });

  it("asks for the current privacy notice first, before starting anything", async () => {
    vi.mocked(noticeAccepted).mockResolvedValue(false);
    const response = await POST(post());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "error", code: "notice_required" });
    expect(noticeAccepted).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(startLiveSession).not.toHaveBeenCalled();
  });

  it.each([
    ["submitted", 409],
    ["too_many_sessions", 429],
    ["unavailable", 503],
  ] as const)("refuses when the session can't start (%s)", async (problem, status) => {
    vi.mocked(startLiveSession).mockResolvedValue(problem);
    const response = await POST(post());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "error", code: problem });
  });
});
