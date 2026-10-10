import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCosts, type Usage } from "@/lib/costs/record";
import { createServiceRoleClient, MissingServiceKeyError } from "@/lib/supabase/admin";
import {
  claimCoachCall,
  endLiveSession,
  linkLiveCheckin,
  linkLiveTake,
  MAX_COACH_CALLS,
  MIN_COACH_INTERVAL_MS,
  readOpenSession,
  recordCoachCost,
  saveCoachState,
  startLiveSession,
  tidyLiveSessions,
} from "./live-sessions";

// Mocked whole, so their `import "server-only"` never runs; record.test.ts covers the cost rows.
vi.mock("@/lib/supabase/admin", () => ({
  createServiceRoleClient: vi.fn(),
  MissingServiceKeyError: class MissingServiceKeyError extends Error {
    name = "MissingServiceKeyError";
  },
}));
vi.mock("@/lib/costs/record", () => ({ recordCosts: vi.fn() }));

const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000002";
const SESSION = "1f5e0000-0000-4000-8000-000000000001";
const CHECKIN = "d1000000-0000-4000-8000-000000000009";
const PATH = `${MEMBER}/2026-10-05-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`;
const USAGE: Usage = { inputTokens: 1800, outputTokens: 120, cacheReadTokens: 3000, cacheWriteTokens: 0 };

type Result = { data: unknown; error: unknown };
type Query = {
  table: string;
  op: "select" | "update";
  values: unknown;
  filters: [string, string, unknown][];
  signal: AbortSignal | null;
};

// The service-role client: rpc(...).abortSignal(...) answers with rpcResult, and from() records
// each select or update with its filters. A select ends in maybeSingle() (reads[table], which
// rejects when it is an Error); an update is awaitable after any number of filters (updateResult).
let rpcResult: Result;
let rpcSignal: AbortSignal | null;
let reads: Record<string, Result | Error>;
let updateResult: Result | Error;
let queries: Query[];
const rpc = vi.fn<(name: string, args: Record<string, unknown>) => { abortSignal: (signal: AbortSignal) => Promise<Result> }>(
  () => ({
    abortSignal: async (signal) => {
      rpcSignal = signal;
      return rpcResult;
    },
  }),
);
function from(table: string) {
  const start = (op: Query["op"], values: unknown) => {
    const query: Query = { table, op, values, filters: [], signal: null };
    queries.push(query);
    const builder = {
      eq: (column: string, value: unknown) => (query.filters.push(["eq", column, value]), builder),
      is: (column: string, value: unknown) => (query.filters.push(["is", column, value]), builder),
      abortSignal: (signal: AbortSignal) => ((query.signal = signal), builder),
      maybeSingle: async () => {
        const result = reads[table] ?? { data: null, error: null };
        if (result instanceof Error) throw result;
        return result;
      },
      then: (resolve: (r: Result) => void, reject: (e: unknown) => void) =>
        updateResult instanceof Error ? reject(updateResult) : resolve(updateResult),
    };
    return builder;
  };
  return {
    select: (columns: string) => start("select", columns),
    update: (values: Record<string, unknown>) => start("update", values),
  };
}
const client = { rpc, from };

const raised = (message: string): Result => ({ data: null, error: { code: "P0001", message, details: null, hint: null } });
const logged = () => JSON.stringify(vi.mocked(console.error).mock.calls);

beforeEach(() => {
  rpcResult = { data: null, error: null };
  rpcSignal = null;
  reads = { live_checkin_sessions: { data: { stt_model: "openai:gpt-live-transcribe" }, error: null } };
  updateResult = { data: null, error: null };
  queries = [];
  rpc.mockClear();
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue(client as never);
  vi.mocked(recordCosts).mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startLiveSession", () => {
  const models = { stt: "openai:gpt-live-transcribe", coach: "claude-haiku-5-5", coachRubric: "3f9a1c0b7d2e" };

  it("starts a session for the member, 15 minutes long, at most 12 a day", async () => {
    rpcResult = { data: SESSION, error: null };
    expect(await startLiveSession(MEMBER, models)).toEqual({ id: SESSION });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("start_live_checkin_session", {
      p_member_id: MEMBER,
      p_stt_model: "openai:gpt-live-transcribe",
      p_coach_model: "claude-haiku-5-5",
      p_coach_rubric: "3f9a1c0b7d2e",
      p_ttl_seconds: 900,
      p_max_per_day: 12,
    });
    expect(rpcSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["already_submitted", "submitted"],
    ["too_many_sessions", "too_many_sessions"],
  ])("turns the database's %s into %s, logging nothing", async (message, problem) => {
    rpcResult = raised(message);
    expect(await startLiveSession(MEMBER, models)).toBe(problem);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is unavailable on any other error, logging only the code", async () => {
    rpcResult = { data: null, error: { code: "57014", message: `canceling statement for ${MEMBER}` } };
    expect(await startLiveSession(MEMBER, models)).toBe("unavailable");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: start failed", { code: "57014" });
  });

  it("is unavailable for a P0001 it doesn't know, without logging its message", async () => {
    rpcResult = raised("something_new");
    expect(await startLiveSession(MEMBER, models)).toBe("unavailable");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: start failed", { code: "P0001" });
  });

  it("is unavailable when no id comes back", async () => {
    rpcResult = { data: null, error: null };
    expect(await startLiveSession(MEMBER, models)).toBe("unavailable");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: start failed", { code: "no_id" });
  });
});

describe("claimCoachCall", () => {
  const row = { coach_state: { v: 1 }, started_at: "2026-10-08T04:00:00+00:00", call_number: 7 };

  it("claims the next call for the member's session, within the call limit and interval", async () => {
    rpcResult = { data: [row], error: null };
    expect(await claimCoachCall(SESSION, MEMBER)).toEqual({
      state: { v: 1 },
      startedAt: "2026-10-08T04:00:00+00:00",
      callNumber: 7,
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("claim_live_coach_call", {
      p_session_id: SESSION,
      p_member_id: MEMBER,
      p_max_calls: MAX_COACH_CALLS,
      p_min_interval_ms: MIN_COACH_INTERVAL_MS,
    });
    expect(MAX_COACH_CALLS).toBe(120);
    expect(MIN_COACH_INTERVAL_MS).toBe(1_000);
    expect(rpcSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["no_session", "no_session"],
    ["session_over", "session_over"],
    ["too_many_calls", "too_many_calls"],
    ["too_soon", "too_soon"],
  ])("turns the database's %s into %s, logging nothing", async (message, problem) => {
    rpcResult = raised(message);
    expect(await claimCoachCall(SESSION, MEMBER)).toBe(problem);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty list", []],
    ["nothing", null],
  ])("is unavailable when %s comes back", async (_label, data) => {
    rpcResult = { data, error: null };
    expect(await claimCoachCall(SESSION, MEMBER)).toBe("unavailable");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: claim failed", { code: "no_row" });
  });

  it("is unavailable on any other error, logging only the code", async () => {
    rpcResult = { data: null, error: { code: "PGRST301", message: "JWT expired" } };
    expect(await claimCoachCall(SESSION, MEMBER)).toBe("unavailable");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: claim failed", { code: "PGRST301" });
  });
});

describe("saveCoachState", () => {
  const state = { v: 1, coverage: { activity_work: "clear" } };

  it("saves the call's state and how far the recording has got, in whole ms", async () => {
    rpcResult = { data: true, error: null };
    expect(await saveCoachState(SESSION, MEMBER, 7, state, 42_500.6)).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("save_live_coach_state", {
      p_session_id: SESSION,
      p_member_id: MEMBER,
      p_call_number: 7,
      p_coach_state: state,
      p_recorded_ms: 42_501,
    });
  });

  it("is false when a later call was claimed since", async () => {
    rpcResult = { data: false, error: null };
    expect(await saveCoachState(SESSION, MEMBER, 7, state, 1000)).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is false when the session is over, logging nothing", async () => {
    rpcResult = raised("session_over");
    expect(await saveCoachState(SESSION, MEMBER, 7, state, 1000)).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is false on an error, logging only the code", async () => {
    rpcResult = { data: null, error: { code: "57014", message: "timeout" } };
    expect(await saveCoachState(SESSION, MEMBER, 7, state, 1000)).toBe(false);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: save failed", { code: "57014" });
  });
});

describe("readOpenSession", () => {
  const state = { v: 1, coverage: { activity_work: "clear" } };

  it("reads the state and latest call number of the member's session, while it is open", async () => {
    reads.live_checkin_sessions = { data: { coach_state: state, coach_calls: 9 }, error: null };
    expect(await readOpenSession(SESSION, MEMBER)).toEqual({ state, callNumber: 9 });
    expect(queries).toEqual([
      {
        table: "live_checkin_sessions",
        op: "select",
        values: "coach_state, coach_calls",
        filters: [
          ["eq", "id", SESSION],
          ["eq", "member_id", MEMBER],
          ["is", "ended_at", null],
        ],
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is null when no open session of theirs matches (ended, or another member's), logging nothing", async () => {
    reads.live_checkin_sessions = { data: null, error: null };
    expect(await readOpenSession(SESSION, MEMBER)).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is null on an error, logging only the code", async () => {
    reads.live_checkin_sessions = { data: null, error: { code: "57014", message: `canceling statement for ${SESSION}` } };
    expect(await readOpenSession(SESSION, MEMBER)).toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: read failed", { code: "57014" });
  });

  it("is null when the read rejects, logging only the error's name", async () => {
    reads.live_checkin_sessions = Object.assign(new Error(`timed out reading ${SESSION}`), { name: "TimeoutError" });
    await expect(readOpenSession(SESSION, MEMBER)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: read failed", { error: "TimeoutError" });
  });

  it("is null when the client can't be made, logging only the error's name", async () => {
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    await expect(readOpenSession(SESSION, MEMBER)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: read failed", { error: "MissingServiceKeyError" });
  });
});

describe("recordCoachCost", () => {
  it("logs one coaching cost against the session", async () => {
    await recordCoachCost(SESSION, "claude-haiku-5-5", USAGE);
    expect(recordCosts).toHaveBeenCalledExactlyOnceWith(client, [
      { step: "coaching", liveSessionId: SESSION, model: "claude-haiku-5-5", usage: USAGE },
    ]);
  });
});

describe("endLiveSession", () => {
  it("ends the member's session and logs its live transcription once, with the session's model", async () => {
    rpcResult = { data: 182_000, error: null };
    expect(await endLiveSession(SESSION, MEMBER, 181_999.7)).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("end_live_checkin_session", {
      p_session_id: SESSION,
      p_member_id: MEMBER,
      p_recorded_ms: 182_000,
    });
    expect(queries).toEqual([
      { table: "live_checkin_sessions", op: "select", values: "stt_model", filters: [["eq", "id", SESSION]], signal: null },
    ]);
    expect(recordCosts).toHaveBeenCalledExactlyOnceWith(client, [
      { step: "live_transcription", liveSessionId: SESSION, model: "openai:gpt-live-transcribe", audioMs: 182_000 },
    ]);
  });

  // The database returns the ms it recorded, which may differ from what the browser sent.
  it("logs the time the database recorded", async () => {
    rpcResult = { data: 60_000, error: null };
    await endLiveSession(SESSION, MEMBER, 3_600_000);
    expect(vi.mocked(recordCosts).mock.calls[0][1]).toEqual([expect.objectContaining({ audioMs: 60_000 })]);
  });

  it("names the model unknown when the session's can't be read", async () => {
    rpcResult = { data: 5_000, error: null };
    reads.live_checkin_sessions = { data: null, error: { code: "57014", message: "timeout" } };
    expect(await endLiveSession(SESSION, MEMBER, 5_000)).toBe(true);
    expect(vi.mocked(recordCosts).mock.calls[0][1]).toEqual([expect.objectContaining({ model: "openai:unknown" })]);
  });

  it("logs nothing twice: a session already ended (or not theirs) returns null", async () => {
    rpcResult = { data: null, error: null };
    expect(await endLiveSession(SESSION, MEMBER, 5_000)).toBe(false);
    expect(queries).toEqual([]);
    expect(recordCosts).not.toHaveBeenCalled();
  });

  it("logs no cost when nothing was transcribed", async () => {
    rpcResult = { data: 0, error: null };
    expect(await endLiveSession(SESSION, MEMBER, 0)).toBe(true);
    expect(recordCosts).not.toHaveBeenCalled();
  });

  it("is false on an error, logging only the code", async () => {
    rpcResult = { data: null, error: { code: "PGRST000", message: `connection refused for ${SESSION}` } };
    expect(await endLiveSession(SESSION, MEMBER, 5_000)).toBe(false);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: end failed", { code: "PGRST000" });
    expect(recordCosts).not.toHaveBeenCalled();
  });
});

describe("linkLiveTake", () => {
  it("remembers the take on the member's own session, until it has a check-in", async () => {
    await linkLiveTake(SESSION, MEMBER, PATH);
    expect(queries).toEqual([
      {
        table: "live_checkin_sessions",
        op: "update",
        values: { audio_path: PATH },
        filters: [
          ["eq", "id", SESSION],
          ["eq", "member_id", MEMBER],
          ["is", "checkin_id", null],
        ],
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it.each([
    ["another member's folder", `${OTHER}/2026-10-05-take.webm`],
    ["a '..' traversal", `${MEMBER}/../${OTHER}/2026-10-05-take.webm`],
    ["a nested folder", `${MEMBER}/2026-10-05-x/take.webm`],
    ["an empty path", ""],
  ])("refuses a path in %s without touching the database", async (_label, path) => {
    await linkLiveTake(SESSION, MEMBER, path);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it("logs a failed update by its code, and never throws", async () => {
    updateResult = { data: null, error: { code: "22P02", message: `invalid input syntax for ${PATH}` } };
    await expect(linkLiveTake(SESSION, MEMBER, PATH)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: linking the take failed", { code: "22P02" });
  });

  it("swallows a thrown error, logging only its name", async () => {
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    await expect(linkLiveTake(SESSION, MEMBER, PATH)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: linking the take failed", { error: "MissingServiceKeyError" });
  });

  it("swallows a rejected update", async () => {
    updateResult = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    await expect(linkLiveTake(SESSION, MEMBER, PATH)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: linking the take failed", { error: "TimeoutError" });
    expect(logged()).not.toContain(PATH);
  });
});

describe("linkLiveCheckin", () => {
  it("links the member's session that recorded the take to the check-in, and lets go of the path", async () => {
    await linkLiveCheckin(MEMBER, PATH, CHECKIN);
    expect(queries).toEqual([
      {
        table: "live_checkin_sessions",
        op: "update",
        values: { checkin_id: CHECKIN, audio_path: null },
        filters: [
          ["eq", "member_id", MEMBER],
          ["eq", "audio_path", PATH],
        ],
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("logs a failed update by its code, and never throws", async () => {
    updateResult = { data: null, error: { code: "23503", message: "violates foreign key" } };
    await expect(linkLiveCheckin(MEMBER, PATH, CHECKIN)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: linking the check-in failed", { code: "23503" });
  });

  it("swallows a thrown error, logging only its name", async () => {
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    await expect(linkLiveCheckin(MEMBER, PATH, CHECKIN)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: linking the check-in failed", {
      error: "MissingServiceKeyError",
    });
  });
});

describe("tidyLiveSessions", () => {
  const A = "1f5e0000-0000-4000-8000-00000000000a";
  const B = "1f5e0000-0000-4000-8000-00000000000b";
  const C = "1f5e0000-0000-4000-8000-00000000000c";

  it("ends abandoned sessions, logging live transcription only for those that transcribed something", async () => {
    rpcResult = {
      data: [
        { session_id: A, stt_model: "openai:gpt-live-transcribe", recorded_ms: 240_000 },
        { session_id: B, stt_model: "openai:gpt-live-transcribe", recorded_ms: 0 },
        { session_id: C, stt_model: "openai:gpt-4o-transcribe", recorded_ms: 15_000 },
      ],
      error: null,
    };
    expect(await tidyLiveSessions()).toEqual({ ended: 3 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("tidy_live_checkin_sessions", { p_limit: 500 });
    expect(recordCosts).toHaveBeenCalledExactlyOnceWith(client, [
      { step: "live_transcription", liveSessionId: A, model: "openai:gpt-live-transcribe", audioMs: 240_000 },
      { step: "live_transcription", liveSessionId: C, model: "openai:gpt-4o-transcribe", audioMs: 15_000 },
    ]);
  });

  it("logs no costs when nothing was ended", async () => {
    rpcResult = { data: [], error: null };
    expect(await tidyLiveSessions()).toEqual({ ended: 0 });
    expect(vi.mocked(recordCosts).mock.calls.flatMap(([, entries]) => entries)).toEqual([]);
  });

  it("treats nothing back as nothing ended", async () => {
    rpcResult = { data: null, error: null };
    expect(await tidyLiveSessions()).toEqual({ ended: 0 });
  });

  it("is null on an error, logging only the code", async () => {
    rpcResult = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    expect(await tidyLiveSessions()).toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("live session: tidying failed", { code: "57014" });
    expect(recordCosts).not.toHaveBeenCalled();
  });
});

describe("logs", () => {
  it("never carry member ids, session ids or paths", async () => {
    rpcResult = { data: null, error: { code: "XX000", message: `${MEMBER} ${SESSION} ${PATH}` } };
    await startLiveSession(MEMBER, { stt: "openai:gpt-live-transcribe", coach: "claude-haiku-5-5", coachRubric: "3f9a1c0b7d2e" });
    await claimCoachCall(SESSION, MEMBER);
    await saveCoachState(SESSION, MEMBER, 1, {}, 0);
    reads.live_checkin_sessions = { data: null, error: { code: "XX000", message: `${MEMBER} ${SESSION}` } };
    await readOpenSession(SESSION, MEMBER);
    await endLiveSession(SESSION, MEMBER, 0);
    await tidyLiveSessions();
    updateResult = { data: null, error: { code: "XX000", message: `${MEMBER} ${PATH}` } };
    await linkLiveTake(SESSION, MEMBER, PATH);
    await linkLiveCheckin(MEMBER, PATH, CHECKIN);
    expect(console.error).toHaveBeenCalledTimes(8);
    for (const secret of [MEMBER, SESSION, PATH, CHECKIN]) expect(logged()).not.toContain(secret);
  });
});
