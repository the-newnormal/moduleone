import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCosts, type CostEntry, type Usage } from "./record";

const CHECKIN = "d1000000-0000-4000-8000-000000000001";
const LIVE = "1f5e0000-0000-4000-8000-000000000001";
const USAGE: Usage = { inputTokens: 1200, outputTokens: 95, cacheReadTokens: 2400, cacheWriteTokens: 0 };

// A stand-in for the service-role client's processing_costs insert: records what was inserted and
// the abort signal it was given, and is awaitable after .abortSignal().
type Insert = { table: string; rows: unknown[]; signal: AbortSignal | null };
let inserts: Insert[];
let insertResult: { error: { code: string; message: string } | null } | Error;
const from = vi.fn((table: string) => ({
  insert(rows: unknown[]) {
    const entry: Insert = { table, rows, signal: null };
    inserts.push(entry);
    return {
      abortSignal(signal: AbortSignal) {
        entry.signal = signal;
        return insertResult instanceof Error ? Promise.reject(insertResult) : Promise.resolve(insertResult);
      },
    };
  },
}));
const admin = { from } as unknown as Parameters<typeof recordCosts>[0];

beforeEach(() => {
  inserts = [];
  insertResult = { error: null };
  from.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordCosts", () => {
  it.each<[string, CostEntry, Record<string, unknown>]>([
    [
      "a check-in's transcription",
      { step: "transcription", checkinId: CHECKIN, model: "openai:gpt-transcribe", audioMs: 95_000 },
      { checkin_id: CHECKIN, step: "transcription", model: "openai:gpt-transcribe", audio_ms: 95_000 },
    ],
    [
      "a transcription of unknown length",
      { step: "transcription", checkinId: CHECKIN, model: "local:parakeet", audioMs: null },
      { checkin_id: CHECKIN, step: "transcription", model: "local:parakeet", audio_ms: null },
    ],
    [
      "a check-in's grading",
      { step: "grading", checkinId: CHECKIN, model: "claude-haiku-5-5", usage: USAGE },
      {
        checkin_id: CHECKIN,
        step: "grading",
        model: "claude-haiku-5-5",
        input_tokens: 1200,
        output_tokens: 95,
        cache_read_tokens: 2400,
        cache_write_tokens: 0,
      },
    ],
    [
      "a live session's transcription",
      { step: "live_transcription", liveSessionId: LIVE, model: "openai:gpt-live-transcribe", audioMs: 182_000 },
      { live_session_id: LIVE, step: "live_transcription", model: "openai:gpt-live-transcribe", audio_ms: 182_000 },
    ],
    [
      "a live session's coaching",
      { step: "coaching", liveSessionId: LIVE, model: "claude-haiku-5-5", usage: USAGE },
      {
        live_session_id: LIVE,
        step: "coaching",
        model: "claude-haiku-5-5",
        input_tokens: 1200,
        output_tokens: 95,
        cache_read_tokens: 2400,
        cache_write_tokens: 0,
      },
    ],
  ])("logs %s as one processing_costs row", async (_label, entry, row) => {
    await recordCosts(admin, [entry]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("processing_costs");
    // Exactly these columns: a check-in's row never has a live session, and the other way round.
    expect(inserts[0].rows).toEqual([row]);
  });

  it("logs several entries in one insert, in order, with a time limit", async () => {
    await recordCosts(admin, [
      { step: "live_transcription", liveSessionId: LIVE, model: "openai:gpt-live-transcribe", audioMs: 60_000 },
      { step: "coaching", liveSessionId: LIVE, model: "claude-haiku-5-5", usage: USAGE },
    ]);
    expect(from).toHaveBeenCalledOnce();
    expect(inserts[0].rows).toMatchObject([{ step: "live_transcription" }, { step: "coaching" }]);
    expect(inserts[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("makes no call for an empty list", async () => {
    await recordCosts(admin, []);
    expect(from).not.toHaveBeenCalled();
  });

  it("logs a failed insert with the step and code only, and never throws", async () => {
    insertResult = { error: { code: "23503", message: `insert on processing_costs violates foreign key for ${LIVE}` } };
    await expect(
      recordCosts(admin, [{ step: "coaching", liveSessionId: LIVE, model: "claude-haiku-5-5", usage: USAGE }]),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("costs: could not record the cost", { step: "coaching", code: "23503" });
  });

  it("logs a thrown error by its name only, and never throws", async () => {
    insertResult = Object.assign(new Error(`fetch failed for ${CHECKIN}`), { name: "AbortError" });
    await expect(
      recordCosts(admin, [{ step: "grading", checkinId: CHECKIN, model: "claude-haiku-5-5", usage: USAGE }]),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("costs: could not record the cost", { step: "grading", error: "AbortError" });
  });

  it("survives a client that throws before the insert is sent", async () => {
    from.mockImplementationOnce(() => {
      throw new TypeError("from is not a function");
    });
    await expect(
      recordCosts(admin, [{ step: "transcription", checkinId: CHECKIN, model: "openai:gpt-transcribe", audioMs: 1 }]),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("costs: could not record the cost", { step: "transcription", error: "TypeError" });
  });

  it("never logs ids or model names", async () => {
    insertResult = { error: { code: "42501", message: "denied" } };
    await recordCosts(admin, [{ step: "coaching", liveSessionId: LIVE, model: "claude-haiku-5-5", usage: USAGE }]);
    insertResult = new Error("boom");
    await recordCosts(admin, [{ step: "grading", checkinId: CHECKIN, model: "claude-haiku-5-5", usage: USAGE }]);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(LIVE);
    expect(logged).not.toContain(CHECKIN);
    expect(logged).not.toContain("claude-haiku");
  });
});
