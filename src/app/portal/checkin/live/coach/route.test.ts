import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimCoachCall, recordCoachCost, saveCoachState, type Claim } from "@/lib/checkin/live-sessions";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import { CoachError, readTranscript, type CoachRead, type CoachReadResult } from "@/lib/coach";
import { initialState, type CoachState } from "@/lib/coach/policy";
import { coachRubric } from "@/lib/coach/rubric";
import { MAX_TRANSCRIPT_CHARS } from "../contract";
import { POST } from "./route";

// The coach's rubric, prompt, policy and turn are the real ones; only Claude's read is mocked. The
// error classes are the real ones too, so the route tells a CoachError from a bug as it would live.
vi.mock("@/lib/checkin/session", () => ({ sessionMember: vi.fn(), noticeAccepted: vi.fn() }));
vi.mock("@/lib/checkin/live-sessions", () => ({
  claimCoachCall: vi.fn(),
  saveCoachState: vi.fn(),
  recordCoachCost: vi.fn(),
}));
vi.mock("@/lib/coach", async () => ({ ...(await vi.importActual("@/lib/coach/types")), readTranscript: vi.fn() }));

// Thursday 8 October 2026, noon in Singapore.
const NOW = new Date("2026-10-08T04:00:00Z");
const ORIGIN = "http://localhost:3000";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const SESSION_ID = "1f5e0000-0000-4000-8000-000000000001";
const SESSION = {
  supabase: {},
  authUserId: "5eed0000-0000-4000-8000-000000000003",
  member: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" },
} as unknown as Session;
const TRANSCRIPT =
  "This week I settled the vendor onboarding for the Jurong site, sent the contract to the client on Friday. Team ok lah, everyone helping each other.";
const USAGE = { inputTokens: 1800, outputTokens: 120, cacheReadTokens: 3000, cacheWriteTokens: 0 };
const RUBRIC = coachRubric();

const READ: CoachRead = {
  coverage: { activity_work: "clear", activity_outcome: "clear", morale_feeling: "clear" },
  tone: "neutral",
  wrappingUp: false,
  instructionsInTranscript: false,
  target: "excellence_moment",
  quote: "",
  question: "",
};
const result = (read: CoachRead = READ): CoachReadResult => ({ read, model: "claude-haiku-5-5", usage: USAGE, latencyMs: 850 });
const claim = (overrides: Partial<Claim> = {}): Claim => ({
  state: null,
  startedAt: new Date(NOW.getTime() - 120_000).toISOString(),
  callNumber: 7,
  ...overrides,
});

type Body = { sessionId: unknown; transcript: unknown; elapsedMs: unknown; shown: unknown; skip: unknown } & Record<string, unknown>;
const BODY: Body = { sessionId: SESSION_ID, transcript: TRANSCRIPT, elapsedMs: 30_000, shown: 0, skip: null };

function post(body: Partial<Body> & Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/portal/checkin/live/coach`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3000", "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...BODY, ...body }),
  });
}

const saved = () => vi.mocked(saveCoachState).mock.calls[0];
const savedState = () => saved()[3] as CoachState;
const asks = () => RUBRIC.topics.flatMap((t) => [t.ask, t.askHardWeek].filter((a): a is string => a !== null));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.stubEnv("LIVE_CHECKIN", "on");
  vi.mocked(sessionMember).mockReset().mockResolvedValue(SESSION);
  vi.mocked(noticeAccepted).mockReset().mockResolvedValue(true);
  vi.mocked(claimCoachCall).mockReset().mockResolvedValue(claim());
  vi.mocked(saveCoachState).mockReset().mockResolvedValue(true);
  vi.mocked(recordCoachCost).mockReset().mockResolvedValue(undefined);
  vi.mocked(readTranscript).mockReset().mockResolvedValue(result());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /portal/checkin/live/coach", () => {
  it("reads the transcript, saves the coach's state under the claimed call and shows the next question", async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      offer: { id: 1, kind: "question", text: expect.any(String) },
      touched: { activity: true, excellence: false, morale: true },
      degraded: false,
    });
    // A question from rubrics/coach.md (Claude offered no wording of its own).
    expect(asks()).toContain(body.offer.text);

    expect(claimCoachCall).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER);
    expect(readTranscript).toHaveBeenCalledExactlyOnceWith({
      transcript: TRANSCRIPT,
      alreadyAsked: [],
      signal: expect.any(AbortSignal),
    });
    expect(saveCoachState).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER, 7, expect.any(Object), 30_000);
    expect(savedState()).toMatchObject({
      v: 1,
      coverage: { activity_work: "clear", activity_outcome: "clear", morale_feeling: "clear" },
      counts: { reads: 1, failures: 0, latencyMs: 850 },
    });
    expect(recordCoachCost).toHaveBeenCalledExactlyOnceWith(SESSION_ID, "claude-haiku-5-5", USAGE);
  });

  it("checks who is calling, not the notice again (checked when the session started)", async () => {
    await POST(post());
    expect(sessionMember).toHaveBeenCalledOnce();
    expect(noticeAccepted).not.toHaveBeenCalled();
  });

  it("never keeps the member's words in the coach's state", async () => {
    await POST(post());
    const state = JSON.stringify(savedState());
    for (const word of ["Jurong", "vendor", "contract", "lah"]) expect(state).not.toContain(word);
  });

  it("sends back only the offer's id, kind and text, and which areas are touched", async () => {
    const body = await (await POST(post())).json();
    expect(Object.keys(body).sort()).toEqual(["degraded", "offer", "status", "touched"]);
    expect(Object.keys(body.offer).sort()).toEqual(["id", "kind", "text"]);
    expect(body.touched).toEqual({ activity: expect.any(Boolean), excellence: expect.any(Boolean), morale: expect.any(Boolean) });
    const text = JSON.stringify(body);
    for (const topic of RUBRIC.topics) expect(text).not.toContain(`"${topic.id}"`);
    for (const level of ["none", "brief", "clear", "declined"]) expect(text).not.toContain(`"${level}"`);
    for (const tone of ["neutral", "hard_week", "distress"]) expect(text).not.toContain(`"${tone}"`);
    for (const key of ["coverage", "tone", "topic", "source", "state"]) expect(text).not.toContain(`"${key}"`);
  });

  it("shows nothing new when a later call has moved on and its state wasn't saved", async () => {
    vi.mocked(saveCoachState).mockResolvedValue(false);
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      offer: null,
      touched: { activity: true, excellence: false, morale: true },
      degraded: false,
    });
  });

  it("carries on from what was known when Claude's read fails, and says so", async () => {
    vi.mocked(readTranscript).mockRejectedValue(
      new CoachError(`No reply from the Anthropic API within 6 s for "${TRANSCRIPT}"`, { reason: "api", retryable: true }),
    );
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", degraded: true });
    expect(savedState().counts).toMatchObject({ reads: 0, failures: 1 });
    expect(recordCoachCost).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live coach: reading the transcript failed", {
      reason: "api",
      retryable: true,
    });
  });

  it("logs the cost of a reply that came back but couldn't be used", async () => {
    vi.mocked(readTranscript).mockRejectedValue(
      new CoachError("The coach's reply was not valid JSON", {
        reason: "invalid_output",
        retryable: true,
        billed: { model: "claude-haiku-5-5", usage: USAGE },
      }),
    );
    const response = await POST(post());
    expect(await response.json()).toMatchObject({ status: "ok", degraded: true });
    expect(savedState().counts).toMatchObject({ reads: 0, failures: 1 });
    expect(recordCoachCost).toHaveBeenCalledExactlyOnceWith(SESSION_ID, "claude-haiku-5-5", USAGE);
  });

  it.each([
    ["refusal", false],
    ["invalid_output", true],
    ["rubric", false],
  ] as const)("is degraded, never failed, when the read ends in %s", async (reason, retryable) => {
    vi.mocked(readTranscript).mockRejectedValue(new CoachError("no", { reason, retryable }));
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", degraded: true });
  });

  it("never logs the transcript", async () => {
    vi.mocked(readTranscript).mockRejectedValue(
      new CoachError(`Claude declined to read "${TRANSCRIPT}"`, { reason: "refusal", retryable: false, cause: new Error(TRANSCRIPT) }),
    );
    await POST(post());
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("Jurong");
    expect(logged).not.toContain(MEMBER);
    expect(logged).not.toContain(SESSION_ID);
  });

  it("lets a bug through rather than passing it off as a failed read", async () => {
    vi.mocked(readTranscript).mockRejectedValue(new TypeError("cannot read properties of undefined"));
    await expect(POST(post())).rejects.toThrow(TypeError);
    expect(saveCoachState).not.toHaveBeenCalled();
  });

  it("waits for enough words before asking Claude, and logs no cost", async () => {
    const response = await POST(post({ transcript: "Ya this week quite busy" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", degraded: false });
    expect(readTranscript).not.toHaveBeenCalled();
    expect(recordCoachCost).not.toHaveBeenCalled();
    expect(saveCoachState).toHaveBeenCalledOnce();
  });

  it("goes on from the state the claim returned", async () => {
    const state: CoachState = {
      ...initialState(),
      coverage: { activity_work: "clear" },
      asked: ["activity_outcome"],
      followUps: 1,
      perArea: { activity: 1 },
      wordsRead: 20,
      nextOfferId: 3,
      counts: { ...initialState().counts, reads: 2 },
    };
    vi.mocked(claimCoachCall).mockResolvedValue(claim({ state }));
    const transcript = `${TRANSCRIPT} Also we cleared the backlog of tickets from last month, quite shiok.`;
    await POST(post({ transcript }));
    expect(readTranscript).toHaveBeenCalledWith(expect.objectContaining({ alreadyAsked: ["activity_outcome"] }));
    expect(savedState()).toMatchObject({ counts: { reads: 3 }, asked: ["activity_outcome"] });
  });

  it("counts the question on screen as asked, and a skipped one as skipped", async () => {
    const offered: CoachState = {
      ...initialState(),
      offers: [
        ...initialState().offers,
        { id: 1, kind: "question", topic: "excellence_moment", source: "bank", beforeYouFinish: false, rejected: false },
      ],
      nextOfferId: 2,
    };
    vi.mocked(claimCoachCall).mockResolvedValue(claim({ state: offered }));
    await POST(post({ shown: 1 }));
    expect(savedState()).toMatchObject({ current: 1, asked: ["excellence_moment"], skipped: [] });

    vi.mocked(saveCoachState).mockClear();
    vi.mocked(readTranscript).mockClear();
    await POST(post({ shown: 1, skip: 1 }));
    expect(savedState()).toMatchObject({ asked: [], skipped: ["excellence_moment"] });
    // A skip wants a new question at once, from what is known: no read.
    expect(readTranscript).not.toHaveBeenCalled();
  });

  describe("how far into the recording", () => {
    it("takes the recorder's clock when it is within the time the session has been open", async () => {
      await POST(post({ elapsedMs: 45_500 }));
      expect(saved()[4]).toBe(45_500);
    });

    it("is never further than the session has been open", async () => {
      vi.mocked(claimCoachCall).mockResolvedValue(claim({ startedAt: new Date(NOW.getTime() - 20_000).toISOString() }));
      const body = await (await POST(post({ elapsedMs: 3_600_000 }))).json();
      expect(saved()[4]).toBe(20_000);
      // So a recorder claiming an hour can't hurry the coach to "Time is nearly up".
      expect(body.offer).toMatchObject({ kind: "question" });
    });

    it("reaches the closing line once the session really has been open that long", async () => {
      vi.mocked(claimCoachCall).mockResolvedValue(claim({ startedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }));
      const body = await (await POST(post({ elapsedMs: 3_600_000 }))).json();
      expect(body.offer).toEqual({ id: 1, kind: "late", text: RUBRIC.lines.late });
    });

    it("is zero for a session that seems to start in the future", async () => {
      vi.mocked(claimCoachCall).mockResolvedValue(claim({ startedAt: new Date(NOW.getTime() + 5_000).toISOString() }));
      await POST(post({ elapsedMs: 30_000 }));
      expect(saved()[4]).toBe(0);
    });

    it("falls back on the recorder's clock when the start time can't be read", async () => {
      vi.mocked(claimCoachCall).mockResolvedValue(claim({ startedAt: "not a time" }));
      await POST(post({ elapsedMs: 30_000 }));
      expect(saved()[4]).toBe(30_000);
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a session id that isn't a uuid", { sessionId: "1f5e0000" }],
    ["a session id that isn't a string", { sessionId: 42 }],
    ["a transcript over the limit", { transcript: "a".repeat(MAX_TRANSCRIPT_CHARS + 1) }],
    ["a transcript that isn't a string", { transcript: ["ok"] }],
    ["a negative elapsed time", { elapsedMs: -1 }],
    ["an elapsed time over an hour", { elapsedMs: 3_600_001 }],
    ["an elapsed time as a string", { elapsedMs: "30000" }],
    ["a shown offer that isn't a whole number", { shown: 1.5 }],
    ["a negative skip", { skip: -1 }],
    ["a member id", { memberId: MEMBER }],
    ["any other extra key", { state: { tone: "neutral" } }],
  ])("refuses %s", async (_label, change) => {
    const response = await POST(post(change));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "bad_request" });
    expect(sessionMember).not.toHaveBeenCalled();
    expect(claimCoachCall).not.toHaveBeenCalled();
  });

  it.each(["sessionId", "transcript", "elapsedMs", "shown", "skip"])("refuses a body without %s", async (key) => {
    const body: Record<string, unknown> = { ...BODY };
    delete body[key];
    const request = new Request(`${ORIGIN}/portal/checkin/live/coach`, {
      method: "POST",
      headers: { origin: ORIGIN, host: "localhost:3000", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await POST(request)).status).toBe(400);
  });

  it("takes a transcript right at the limit", async () => {
    const response = await POST(post({ transcript: "ok ".repeat(MAX_TRANSCRIPT_CHARS / 3) }));
    expect(response.status).toBe(200);
  });

  it("refuses another site's request", async () => {
    const response = await POST(post({}, { origin: "https://evil.example" }));
    expect(response.status).toBe(400);
    expect(sessionMember).not.toHaveBeenCalled();
  });

  it("says the session is over when live check-ins have been switched off", async () => {
    vi.stubEnv("LIVE_CHECKIN", "off");
    const response = await POST(post());
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ status: "error", code: "session_over" });
    expect(claimCoachCall).not.toHaveBeenCalled();
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ["signed_out", 401, "signed_out"],
    ["no_member", 403, "no_member"],
    ["failed", 503, "unavailable"],
  ] as const)("refuses a session that is %s", async (problem, status, code) => {
    vi.mocked(sessionMember).mockResolvedValue(problem);
    const response = await POST(post());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ status: "error", code });
    expect(claimCoachCall).not.toHaveBeenCalled();
  });

  it.each([
    ["too_soon", 429],
    ["no_session", 404],
    ["session_over", 410],
    ["too_many_calls", 429],
    ["unavailable", 503],
  ] as const)("refuses when the call can't be claimed (%s)", async (problem, status) => {
    vi.mocked(claimCoachCall).mockResolvedValue(problem);
    const response = await POST(post());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "error", code: problem });
    expect(readTranscript).not.toHaveBeenCalled();
    expect(saveCoachState).not.toHaveBeenCalled();
    expect(recordCoachCost).not.toHaveBeenCalled();
  });
});
