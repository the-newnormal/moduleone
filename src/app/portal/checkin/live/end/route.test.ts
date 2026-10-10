import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endLiveSession } from "@/lib/checkin/live-sessions";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import { POST } from "./route";

vi.mock("@/lib/checkin/session", () => ({ sessionMember: vi.fn(), noticeAccepted: vi.fn() }));
vi.mock("@/lib/checkin/live-sessions", () => ({ endLiveSession: vi.fn() }));

const ORIGIN = "http://localhost:3000";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000002";
const SESSION_ID = "1f5e0000-0000-4000-8000-000000000001";
const SESSION = {
  supabase: {},
  authUserId: "5eed0000-0000-4000-8000-000000000003",
  member: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" },
} as unknown as Session;
const BODY = { sessionId: SESSION_ID, recordedMs: 182_000 };

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /portal/checkin/live/end", () => {
  it("ends the session for the session's member, with how long it recorded", async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ended" });
    expect(endLiveSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID, MEMBER, 182_000);
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
  });

  it.each([
    ["a session id that isn't a uuid", { ...BODY, sessionId: "not-a-session" }],
    ["a negative time", { ...BODY, recordedMs: -1 }],
    ["a time over an hour", { ...BODY, recordedMs: 3_600_001 }],
    ["a time as a string", { ...BODY, recordedMs: "182000" }],
    ["no time", { sessionId: SESSION_ID }],
    ["no session id", { recordedMs: 182_000 }],
    ["a member id", { ...BODY, memberId: OTHER }],
    ["something that isn't an object", [SESSION_ID, 182_000]],
  ])("refuses %s", async (_label, body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "bad_request" });
    expect(sessionMember).not.toHaveBeenCalled();
    expect(endLiveSession).not.toHaveBeenCalled();
  });

  it("refuses another site's request", async () => {
    const response = await POST(post(BODY, { origin: "https://evil.example" }));
    expect(response.status).toBe(400);
    expect(endLiveSession).not.toHaveBeenCalled();
  });

  it.each([
    ["signed_out", 401, "signed_out"],
    ["no_member", 403, "no_member"],
    ["failed", 503, "unavailable"],
  ] as const)("refuses a session that is %s", async (problem, status, code) => {
    vi.mocked(sessionMember).mockResolvedValue(problem);
    const response = await POST(post());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "error", code });
    expect(endLiveSession).not.toHaveBeenCalled();
  });
});
