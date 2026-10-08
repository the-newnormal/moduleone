import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gradeCheckin, GradingError } from "@/lib/grader";
import { transcribe, TranscriptionError } from "@/lib/stt";
import { createAdminClient } from "@/lib/supabase/admin";
import { processCheckin } from "./process";

// Mocked whole, so their `import "server-only"` never runs; the error classes are the real ones.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stt", async () => ({ ...(await vi.importActual("@/lib/stt/types")), transcribe: vi.fn() }));
vi.mock("@/lib/grader", async () => ({ ...(await vi.importActual("@/lib/grader/types")), gradeCheckin: vi.fn() }));

const CHECKIN = "d1000000-0000-4000-8000-000000000001";
const MEMBER = "c1000000-0000-4000-8000-000000000002";
const PATH = `${MEMBER}/2026-10-05-take.webm`;
const TRANSCRIPT = "I shipped the login page and helped Priya with the tests. The team feels good.";
const GRADE = {
  activity: 4,
  excellence: 3,
  morale: 4,
  category: "delivery",
  review: "Shipped the login page.",
  model: "claude-opus-5-5",
} as const;

type Update = { table: string; values: Record<string, unknown>; filters: [string, string, unknown][] };
let updates: Update[];
let updateError: { code: string; message: string } | null;
const rpc = vi.fn();
const download = vi.fn();
const storageFrom = vi.fn(() => ({ download }));

// A stand-in for supabase-js's update builder: records the call, and is awaitable after any
// number of filters.
function from(table: string) {
  return {
    update(values: Record<string, unknown>) {
      const entry: Update = { table, values, filters: [] };
      updates.push(entry);
      const builder = {
        eq: (column: string, value: unknown) => (entry.filters.push(["eq", column, value]), builder),
        is: (column: string, value: unknown) => (entry.filters.push(["is", column, value]), builder),
        then: (resolve: (r: { error: typeof updateError }) => void) => resolve({ error: updateError }),
      };
      return builder;
    },
  };
}

const claim = (overrides: Record<string, unknown> = {}) => ({
  data: [{ member_id: MEMBER, audio_path: PATH, audio_duration_ms: 95000, transcript: null, attempts: 1, ...overrides }],
  error: null,
});

beforeEach(() => {
  updates = [];
  updateError = null;
  vi.mocked(createAdminClient).mockReturnValue({ rpc, from, storage: { from: storageFrom } } as never);
  rpc.mockReset().mockResolvedValue(claim());
  download.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), error: null });
  vi.mocked(transcribe)
    .mockReset()
    .mockResolvedValue({ text: TRANSCRIPT, provider: "openai", model: "gpt-transcribe", warnings: [] });
  vi.mocked(gradeCheckin).mockReset().mockResolvedValue(GRADE);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processCheckin", () => {
  it("transcribes, saves the transcript, then grades and saves the grade", async () => {
    expect(await processCheckin(CHECKIN)).toBe("graded");

    expect(rpc).toHaveBeenCalledExactlyOnceWith("claim_checkin_processing", { p_checkin_id: CHECKIN });
    expect(storageFrom).toHaveBeenCalledWith("checkin-audio");
    expect(download).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(
      {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
        filename: "2026-10-05-take.webm",
        durationSeconds: 95,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(gradeCheckin).toHaveBeenCalledExactlyOnceWith({ transcript: TRANSCRIPT });
    expect(updates).toEqual([
      {
        table: "checkins",
        values: { transcript: TRANSCRIPT, transcript_model: "openai:gpt-transcribe", transcript_warnings: [] },
        filters: [["eq", "id", CHECKIN]],
      },
      {
        table: "checkins",
        values: {
          activity_score: 4,
          excellence_score: 3,
          morale_score: 4,
          category: "delivery",
          rubric_review: "Shipped the login page.",
          grader_model: "claude-opus-5-5",
          graded_at: expect.any(String),
          processing_error: null,
        },
        // Never overwrites a grade another attempt already saved.
        filters: [["eq", "id", CHECKIN], ["is", "graded_at", null]],
      },
    ]);
  });

  it("does nothing when there is nothing to claim", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await processCheckin(CHECKIN)).toBe("skipped");
    expect(download).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("reuses the transcript an earlier attempt saved instead of transcribing again", async () => {
    rpc.mockResolvedValue(claim({ transcript: TRANSCRIPT, attempts: 2 }));
    expect(await processCheckin(CHECKIN)).toBe("graded");
    expect(download).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(gradeCheckin).toHaveBeenCalledExactlyOnceWith({ transcript: TRANSCRIPT });
    expect(updates.map((u) => Object.keys(u.values))).toEqual([expect.arrayContaining(["activity_score", "graded_at"])]);
  });

  it("grades an empty saved transcript rather than transcribing again", async () => {
    rpc.mockResolvedValue(claim({ transcript: "" }));
    await processCheckin(CHECKIN);
    expect(transcribe).not.toHaveBeenCalled();
    expect(gradeCheckin).toHaveBeenCalledExactlyOnceWith({ transcript: "" });
  });

  it("works out the type from the file name when Storage doesn't say", async () => {
    rpc.mockResolvedValue(claim({ audio_path: `${MEMBER}/2026-10-05-take.m4a`, audio_duration_ms: null }));
    download.mockResolvedValue({ data: new Blob([new Uint8Array([1])]), error: null });
    await processCheckin(CHECKIN);
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/mp4", filename: "2026-10-05-take.m4a", durationSeconds: undefined }),
      expect.anything(),
    );
  });

  it("records a failed download and stops", async () => {
    download.mockResolvedValue({ data: null, error: { name: "StorageError", message: "Object not found" } });
    expect(await processCheckin(CHECKIN)).toBe("failed");
    expect(transcribe).not.toHaveBeenCalled();
    expect(updates).toEqual([
      { table: "checkins", values: { processing_error: "download_failed: Object not found" }, filters: [["eq", "id", CHECKIN]] },
    ]);
  });

  it("gives transcription a deadline well inside the function's 300 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await processCheckin(CHECKIN);
    expect(timeout).toHaveBeenCalledOnce();
    const [budget] = timeout.mock.calls[0];
    expect(budget).toBeGreaterThanOrEqual(120_000);
    expect(budget).toBeLessThanOrEqual(240_000);
    expect(vi.mocked(transcribe).mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value);
  });

  it("records a transcription that ran out of time, so it is retried", async () => {
    vi.mocked(transcribe).mockRejectedValue(
      new TranscriptionError("Transcription was cancelled.", { provider: "openai", model: "gpt-transcribe", retryable: false }),
    );
    expect(await processCheckin(CHECKIN)).toBe("failed");
    expect(gradeCheckin).not.toHaveBeenCalled();
    expect(updates.at(-1)?.values).toEqual({
      processing_error: "transcription_failed: TranscriptionError: Transcription was cancelled.",
    });
  });

  it("records a failed transcription and doesn't grade", async () => {
    vi.mocked(transcribe).mockRejectedValue(
      new TranscriptionError("Transcription service error (503).", { provider: "openai", model: "whisper-1", retryable: true }),
    );
    expect(await processCheckin(CHECKIN)).toBe("failed");
    expect(gradeCheckin).not.toHaveBeenCalled();
    expect(updates).toEqual([
      {
        table: "checkins",
        values: { processing_error: "transcription_failed: TranscriptionError: Transcription service error (503)." },
        filters: [["eq", "id", CHECKIN]],
      },
    ]);
  });

  it("keeps the transcript when grading fails, so a retry only grades", async () => {
    vi.mocked(gradeCheckin).mockRejectedValue(new GradingError("Claude declined.", { reason: "refusal", retryable: false }));
    expect(await processCheckin(CHECKIN)).toBe("failed");
    expect(updates.map((u) => u.values)).toEqual([
      { transcript: TRANSCRIPT, transcript_model: "openai:gpt-transcribe", transcript_warnings: [] },
      { processing_error: "grading_refusal: GradingError: Claude declined." },
    ]);
  });

  describe("attempts", () => {
    // claim_checkin_processing (0004) in miniature: each claim counts an attempt, five at most, and
    // the row keeps what processCheckin writes back.
    let row: { attempts: number; transcript: string | null };
    const visit = async () => {
      updates = [];
      const outcome = await processCheckin(CHECKIN);
      for (const { values } of updates) {
        if (typeof values.processing_attempts === "number") row.attempts = values.processing_attempts;
        if (typeof values.transcript === "string") row.transcript = values.transcript;
      }
      return outcome;
    };

    beforeEach(() => {
      row = { attempts: 0, transcript: null };
      rpc.mockImplementation(async () => {
        if (row.attempts >= 5) return { data: [], error: null };
        row.attempts += 1;
        return claim({ attempts: row.attempts, transcript: row.transcript });
      });
    });

    it("doesn't use them up while the grader is misconfigured, so it grades once the key is fixed", async () => {
      vi.mocked(gradeCheckin).mockRejectedValue(
        new GradingError("Missing ANTHROPIC_API_KEY (server-only).", { reason: "api", retryable: false }),
      );
      for (let i = 0; i < 8; i++) expect(await visit()).toBe("failed");
      expect(row.attempts).toBe(0);
      expect(transcribe).toHaveBeenCalledOnce();
      expect(updates.at(-1)?.values).toEqual({
        processing_error: "grading_api: GradingError: Missing ANTHROPIC_API_KEY (server-only).",
        processing_attempts: 0,
      });

      vi.mocked(gradeCheckin).mockResolvedValue(GRADE);
      expect(await visit()).toBe("graded");
    });

    it.each([
      ["a rate limit", new GradingError("Rate limited.", { reason: "api", retryable: true })],
      ["a refusal", new GradingError("Claude declined.", { reason: "refusal", retryable: false })],
      ["invalid output", new GradingError("Bad output.", { reason: "invalid_output", retryable: true })],
    ])("counts %s, and stops after five", async (_label, thrown) => {
      vi.mocked(gradeCheckin).mockRejectedValue(thrown);
      for (let i = 0; i < 5; i++) expect(await visit()).toBe("failed");
      expect(row.attempts).toBe(5);
      expect(await visit()).toBe("skipped");
      expect(gradeCheckin).toHaveBeenCalledTimes(5);
    });
  });

  it("records a failure to save the transcript and doesn't grade", async () => {
    updateError = { code: "PGRST000", message: "connection lost" };
    expect(await processCheckin(CHECKIN)).toBe("failed");
    expect(gradeCheckin).not.toHaveBeenCalled();
    expect(updates.at(-1)?.values).toEqual({ processing_error: "save_transcript_failed: connection lost" });
  });

  it("fails quietly when the claim errors or there's no service-role key", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST301", message: "JWT expired" } });
    expect(await processCheckin(CHECKIN)).toBe("failed");

    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (server-only).");
    });
    expect(await processCheckin(CHECKIN)).toBe("failed");
    expect(updates).toEqual([]);
  });

  it("never writes the transcript to the logs", async () => {
    vi.mocked(gradeCheckin).mockRejectedValue(new GradingError("Bad output.", { reason: "invalid_output", retryable: true }));
    await processCheckin(CHECKIN);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("grading_invalid_output");
    expect(logged).not.toContain("login page");
  });
});
