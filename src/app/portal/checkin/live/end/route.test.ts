import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endLiveSession, readOpenSession, saveCoachState } from "@/lib/checkin/live-sessions";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import { initialState, parseState, type CoachState } from "@/lib/coach/policy";
import { coachInstructions } from "@/lib/coach/prompt";
import { RubricError } from "@/lib/rubrics/markdown";
import { FALLBACK_REASONS } from "../contract";
import { POST } from "./route";

// The coach's rubric and policy are the real ones; coachInstructions is only watched, so a test can
// make the rubric unreadable.
vi.mock("@/lib/checkin/session", () => ({ sessionMember: vi.fn(), noticeAccepted: vi.fn() }));
vi.mock("@/lib/checkin/live-sessions", () => ({ endLiveSession: vi.fn(), readOpenSession: vi.fn(), saveCoachState: vi.fn() }));
vi.mock("@/lib/coach/prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coach/prompt")>();
  return { ...actual, coachInstructions: vi.fn(actual.coachInstructions) };
});

const ORIGIN = "http://localhost:3000";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000002";
const SESSION_ID = "1f5e0000-0000-4000-8000-000000000001";
const SESSION = {
  supabase: {},
  authUserId: "5eed0000-0000-4000-8000-000000000003",
  member: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" },
} as unknown as Session;
const BODY = { sessionId: SESSION_ID, recordedMs: 182_000, shown: null };

// The coach offered a follow-up (1), the rubric's wording in place of Claude's turned-down one, then
// the covered line (2); the last coach call came before either reached the screen.
const OFFERED: CoachState = {
  ...initialState(),
  offers: [
    ...initialState().offers,
    { id: 1, kind: "question", topic: "excellence_moment", source: "bank", beforeYouFinish: false, rejected: true },
    { id: 2, kind: "covered", topic: null, source: "line", beforeYouFinish: false, rejected: false },
  ],
  nextOfferId: 3,
};
// As the database gives it back, under the session's latest call.
const open = (state: unknown = OFFERED) => ({ state: JSON.parse(JSON.stringify(state)) as unknown, callNumber: 9 });
const savedState = () => vi.mocked(saveCoachState).mock.calls[0][3] as CoachState;

function post(body: unknown = BODY, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/portal/checkin/live/end`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3000", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(sessionMember).mockReset().mockResolvedValue(SESSION);
  vi.mocked(noticeAccepted).mockReset().mockResolvedValue(true);
  vi.mocked(endLiveSession).mockReset().mockResolvedValue(true);
  vi.mocked(readOpenSession).mockReset().mockResolvedValue(open());
  vi.mocked(saveCoachState).mockReset().mockResolvedValue(true);
  vi.mocked(coachInstructions).mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectEnded(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ended" });
  expect(endLiveSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER, 182_000);
}

describe("POST /portal/checkin/live/end", () => {
  it("ends the session for the session's member, with how long it recorded", async () => {
    await expectEnded(await POST(post()));
  });

  it("counts nothing when no coach offer was on screen (shown is null), and reads the session only for the log", async () => {
    await expectEnded(await POST(post()));
    expect(readOpenSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER);
    expect(saveCoachState).not.toHaveBeenCalled();
  });

  it("doesn't check the notice: ending sends nothing anywhere", async () => {
    await POST(post());
    expect(noticeAccepted).not.toHaveBeenCalled();
  });

  // The page may send it twice (Finish, then keepalive as it goes away); the second does nothing.
  it("answers ended when the session had already ended", async () => {
    vi.mocked(endLiveSession).mockResolvedValue(false);
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ended" });
    expect(console.info).not.toHaveBeenCalled();
  });

  describe("the offer on screen as the take ends", () => {
    it("counts the question as shown, saved under the session's latest call, before the session ends", async () => {
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(readOpenSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER);
      expect(saveCoachState).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER, 9, expect.any(Object), 182_000);
      expect(savedState()).toMatchObject({
        current: 1,
        asked: ["excellence_moment"],
        followUps: 1,
        perArea: { excellence: 1 },
        counts: { tailored: 0, bank: 1, rejected: 1 },
      });
      // Saved in the shape the coach reads back.
      expect(parseState(JSON.parse(JSON.stringify(savedState())))).toEqual(savedState());
      // The session is still open while it saves: once ended, nothing more can be saved.
      expect(vi.mocked(saveCoachState).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(endLiveSession).mock.invocationCallOrder[0]);
    });

    it("counts a closing line as said", async () => {
      await expectEnded(await POST(post({ ...BODY, shown: 2 })));
      expect(savedState()).toMatchObject({ current: 2, linesShown: ["covered"], asked: [], followUps: 0 });
    });

    it("saves nothing when the offer was already counted (the last coach call said so)", async () => {
      vi.mocked(readOpenSession).mockResolvedValue(open({ ...OFFERED, current: 1, asked: ["excellence_moment"], followUps: 1 }));
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(readOpenSession).toHaveBeenCalledOnce();
      expect(saveCoachState).not.toHaveBeenCalled();
    });

    it("saves nothing for an offer the coach never made", async () => {
      await expectEnded(await POST(post({ ...BODY, shown: 7 })));
      expect(saveCoachState).not.toHaveBeenCalled();
    });

    it("saves nothing when the session isn't open (already ended, or not theirs), and still ends it", async () => {
      vi.mocked(readOpenSession).mockResolvedValue(null);
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(saveCoachState).not.toHaveBeenCalled();
    });

    it("never replaces a state it can't read with a fresh one", async () => {
      vi.mocked(readOpenSession).mockResolvedValue(open({ ...OFFERED, v: 0 }));
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      vi.mocked(endLiveSession).mockClear();
      await expectEnded(await POST(post({ ...BODY, shown: 0 })));
      expect(saveCoachState).not.toHaveBeenCalled();
    });

    it("still ends the session when the coach's rubric can't be read", async () => {
      vi.mocked(coachInstructions).mockImplementationOnce(() => {
        throw new RubricError("rubrics/coach.md", ["The settings are missing."]);
      });
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(saveCoachState).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", expect.objectContaining({ followUps: 0 }));
    });

    it("still ends the session when the save is turned away (a later call, say), and logs the counts it holds", async () => {
      vi.mocked(saveCoachState).mockResolvedValue(false);
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(saveCoachState).toHaveBeenCalledOnce();
      // The question on screen wasn't counted, so the log doesn't count it either.
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", expect.objectContaining({ followUps: 0, bank: 0, rejected: 0 }));
    });

    it("logs what a newer coach call saved when that call got there first", async () => {
      const newer: CoachState = { ...OFFERED, asked: ["activity_work"], followUps: 3, counts: { ...OFFERED.counts, reads: 5 } };
      vi.mocked(readOpenSession).mockResolvedValueOnce(open()).mockResolvedValueOnce(open(newer));
      vi.mocked(saveCoachState).mockResolvedValue(false);
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(readOpenSession).toHaveBeenCalledTimes(2);
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", expect.objectContaining({ followUps: 3, reads: 5 }));
    });

    it("logs no counts when the session can't be read again after a turned-away save", async () => {
      vi.mocked(readOpenSession).mockResolvedValueOnce(open()).mockResolvedValueOnce(null);
      vi.mocked(saveCoachState).mockResolvedValue(false);
      await expectEnded(await POST(post({ ...BODY, shown: 1, fallback: "no_text" })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", { fallback: "no_text" });
    });

    it("logs the counts with the question on screen once that is saved", async () => {
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", expect.objectContaining({ followUps: 1, bank: 1, rejected: 1 }));
    });

    it("still ends the session when counting throws, logging only the error's name", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(saveCoachState).mockRejectedValue(new TypeError(`fetch failed for ${SESSION_ID}`));
      await expectEnded(await POST(post({ ...BODY, shown: 1 })));
      expect(log).toHaveBeenCalledWith("live end: counting the last offer failed", { error: "TypeError" });
      expect(JSON.stringify(log.mock.calls)).not.toContain(SESSION_ID);
    });
  });

  describe("the log", () => {
    // A take that fell back after two failed reads, with one question in the file's wording shown in
    // place of Claude's (turned down as too personal), and the follow-up on screen as it ended.
    const PLAYED: CoachState = {
      ...OFFERED,
      coverage: { activity_work: "clear", activity_outcome: "brief", excellence_moment: "none" },
      tone: "hard_week",
      asked: ["activity_outcome"],
      followUps: 1,
      perArea: { activity: 1 },
      wordsRead: 140,
      counts: {
        ...initialState().counts,
        reads: 4,
        failures: 2,
        tailored: 1,
        latencyMs: 3400,
        slowestMs: 1200,
        rejectedWhy: { blocked: 1, quote_not_said: 1 },
        noRead: 1,
      },
    };

    it("says why live coaching stopped and how the take went, from the counts as it ends: codes and counts only", async () => {
      vi.mocked(readOpenSession).mockResolvedValue(open(PLAYED));
      await expectEnded(await POST(post({ ...BODY, shown: 1, fallback: "coach_failures" })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", {
        fallback: "coach_failures",
        reads: 4,
        failures: 2,
        tailored: 1,
        bank: 1,
        rejected: 1,
        noRead: 1,
        followUps: 2,
      });
      const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
      for (const id of [MEMBER, SESSION_ID]) expect(logged).not.toContain(id);
      // Why a question was turned down stays in the session: beside a time, it could point at a person.
      for (const reason of ["rejectedWhy", "blocked", "quote_not_said"]) expect(logged).not.toContain(reason);
      for (const topic of ["activity_work", "activity_outcome", "excellence_moment"]) expect(logged).not.toContain(topic);
      for (const level of ["brief", "clear", "none", "hard_week"]) expect(logged).not.toContain(`"${level}"`);
    });

    it("logs no reason for a take that kept its follow-ups to the end", async () => {
      await expectEnded(await POST(post({ ...BODY, shown: 0 })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", expect.objectContaining({ fallback: null, reads: 0 }));
    });

    // Nothing limits end calls, so one that ends no take would let anyone add fallbacks to the count.
    it("logs nothing when the call ends no session (already ended, or not theirs)", async () => {
      vi.mocked(readOpenSession).mockResolvedValue(null);
      vi.mocked(endLiveSession).mockResolvedValue(false);
      for (let call = 0; call < 3; call++) {
        const response = await POST(post({ ...BODY, fallback: "coach_failures" }));
        expect(await response.json()).toEqual({ status: "ended" });
      }
      expect(endLiveSession).toHaveBeenCalledTimes(3);
      expect(console.info).not.toHaveBeenCalled();
    });

    it("logs the reason alone when it ends the session but couldn't read its counts", async () => {
      vi.mocked(readOpenSession).mockResolvedValue(null);
      await expectEnded(await POST(post({ ...BODY, fallback: "final_code" })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", { fallback: "final_code" });
    });

    it("still logs, without counts, when counting throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(readOpenSession).mockRejectedValue(new TypeError("fetch failed"));
      await expectEnded(await POST(post({ ...BODY, fallback: "no_text" })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", { fallback: "no_text" });
    });

    it.each(FALLBACK_REASONS)("takes the reason %s", async (fallback) => {
      await expectEnded(await POST(post({ ...BODY, fallback })));
      expect(console.info).toHaveBeenCalledExactlyOnceWith("live end", expect.objectContaining({ fallback }));
    });
  });

  it.each([
    ["an unknown fallback reason", { ...BODY, fallback: "bored" }],
    ["a fallback reason that isn't text", { ...BODY, fallback: 3 }],
    ["a null fallback reason", { ...BODY, fallback: null }],
    ["a session id that isn't a uuid", { ...BODY, sessionId: "not-a-session" }],
    ["a negative time", { ...BODY, recordedMs: -1 }],
    ["a time over an hour", { ...BODY, recordedMs: 3_600_001 }],
    ["a time as a string", { ...BODY, recordedMs: "182000" }],
    ["no time", { sessionId: SESSION_ID, shown: null }],
    ["no session id", { recordedMs: 182_000, shown: null }],
    ["no shown (an older page)", { sessionId: SESSION_ID, recordedMs: 182_000 }],
    ["a negative shown", { ...BODY, shown: -1 }],
    ["a fractional shown", { ...BODY, shown: 1.5 }],
    ["shown as a string", { ...BODY, shown: "1" }],
    ["a member id", { ...BODY, memberId: OTHER }],
    ["something that isn't an object", [SESSION_ID, 182_000]],
  ])("refuses %s", async (_label, body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "bad_request" });
    expect(sessionMember).not.toHaveBeenCalled();
    expect(readOpenSession).not.toHaveBeenCalled();
    expect(endLiveSession).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it("refuses another site's request", async () => {
    const response = await POST(post({ ...BODY, shown: 1 }, { origin: "https://evil.example" }));
    expect(response.status).toBe(400);
    expect(readOpenSession).not.toHaveBeenCalled();
    expect(endLiveSession).not.toHaveBeenCalled();
  });

  it.each([
    ["signed_out", 401, "signed_out"],
    ["no_member", 403, "no_member"],
    ["failed", 503, "unavailable"],
  ] as const)("refuses a session that is %s", async (problem, status, code) => {
    vi.mocked(sessionMember).mockResolvedValue(problem);
    const response = await POST(post({ ...BODY, shown: 1 }));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "error", code });
    expect(readOpenSession).not.toHaveBeenCalled();
    expect(saveCoachState).not.toHaveBeenCalled();
    expect(endLiveSession).not.toHaveBeenCalled();
  });
});
