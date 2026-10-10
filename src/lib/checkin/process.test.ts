import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gradeCheckin, GradingError, type Grade } from "@/lib/grader";
import { transcribe, TranscriptionError } from "@/lib/stt";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { processCheckin } from "./process";

// Mocked whole, so their `import "server-only"` never runs; the error classes are the real ones.
vi.mock("@/lib/supabase/admin", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/stt", async () => ({ ...(await vi.importActual("@/lib/stt/types")), transcribe: vi.fn() }));
vi.mock("@/lib/grader", async () => ({ ...(await vi.importActual("@/lib/grader/types")), gradeCheckin: vi.fn() }));

const CHECKIN = "d1000000-0000-4000-8000-000000000001";
const MEMBER = "c1000000-0000-4000-8000-000000000002";
const PATH = `${MEMBER}/2026-10-05-take.webm`;
const TRANSCRIPT = "I shipped the login page and helped Priya with the tests. The team feels good.";
const GRADE: Grade = {
  activity: 4,
  excellence: 3,
  morale: 4,
  category: "delivery",
  review: "Shipped the login page.",
  model: "claude-haiku-5-5",
  rubricVersion: "3f9a1c0b7d2e",
  attempts: [{ model: "claude-haiku-5-5", usage: { inputTokens: 40, outputTokens: 300, cacheReadTokens: 1500, cacheWriteTokens: 0 } }],
};

type Update = { table: string; values: Record<string, unknown>; filters: [string, string, unknown][] };
type Insert = { table: string; values: Record<string, unknown>[] };
let updates: Update[];
let inserts: Insert[];
let updateError: { code: string; message: string } | null;
let insertError: { code: string; message: string } | null;
// The rows an update's .select() returns (the grade's update asks which row it changed).
let updatedRows: { id: string }[];
const rpc = vi.fn();
const download = vi.fn();
const storageFrom = vi.fn(() => ({ download }));

// A stand-in for supabase-js's update builder: records the call, and is awaitable after any
// number of filters.
function from(table: string) {
  return {
    insert(values: Record<string, unknown>[]) {
      inserts.push({ table, values });
      const builder = {
        abortSignal: () => builder,
        then: (resolve: (r: { error: typeof insertError }) => void) => resolve({ error: insertError }),
      };
      return builder;
    },
    update(values: Record<string, unknown>) {
      const entry: Update = { table, values, filters: [] };
      updates.push(entry);
      const builder = {
        eq: (column: string, value: unknown) => (entry.filters.push(["eq", column, value]), builder),
        is: (column: string, value: unknown) => (entry.filters.push(["is", column, value]), builder),
        select: () => builder,
        abortSignal: () => builder,
        then: (resolve: (r: { data: unknown; error: typeof updateError }) => void) =>
          resolve({ data: updateError ? null : updatedRows, error: updateError }),
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
  inserts = [];
  updateError = null;
  insertError = null;
  updatedRows = [{ id: CHECKIN }];
  vi.mocked(createServiceRoleClient).mockReturnValue({ rpc, from, storage: { from: storageFrom } } as never);
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
    expect(download).toHaveBeenCalledExactlyOnceWith(PATH, undefined, { signal: expect.any(AbortSignal) });
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(
      {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
        filename: "2026-10-05-take.webm",
        durationSeconds: 95,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(gradeCheckin).toHaveBeenCalledExactlyOnceWith({ transcript: TRANSCRIPT, signal: expect.any(AbortSignal) });
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
          grader_model: "claude-haiku-5-5",
          // Which version of rubrics/grading.md (and the rules around it) graded it.
          rubric_version: "3f9a1c0b7d2e",
          graded_at: expect.any(String),
          processing_error: null,
        },
        // Never overwrites a grade another attempt already saved.
        filters: [["eq", "id", CHECKIN], ["is", "graded_at", null]],
      },
    ]);
    // Each paid call is logged for the Costs page: numbers and model names only.
    expect(inserts).toEqual([
      {
        table: "processing_costs",
        values: [{ checkin_id: CHECKIN, step: "transcription", model: "openai:gpt-transcribe", audio_ms: 95000 }],
      },
      {
        table: "processing_costs",
        values: [
          {
          checkin_id: CHECKIN,
          step: "grading",
          model: "claude-haiku-5-5",
          input_tokens: 40,
          output_tokens: 300,
          cache_read_tokens: 1500,
          cache_write_tokens: 0,
          },
        ],
      },
    ]);
  });

  it("logs one grading row per billed attempt when a fallback model answered", async () => {
    const usage = (n: number) => ({ inputTokens: n, outputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0 });
    vi.mocked(gradeCheckin).mockResolvedValue({
      ...GRADE,
      model: "claude-opus-4-8",
      attempts: [
        { model: "claude-sonnet-5-5", usage: usage(10) },
        { model: "claude-opus-4-8", usage: usage(20) },
      ],
    });
    await processCheckin(CHECKIN);
    const grading = inserts.filter((i) => i.table === "processing_costs").flatMap((i) => i.values);
    expect(grading.filter((r) => r.step === "grading").map((r) => [r.model, r.input_tokens])).toEqual([
      ["claude-sonnet-5-5", 10],
      ["claude-opus-4-8", 20],
    ]);
  });

  it("still grades when the cost log can't be written", async () => {
    insertError = { code: "42501", message: "denied" };
    expect(await processCheckin(CHECKIN)).toBe("graded");
    expect(inserts).toHaveLength(2);
    // Logged by the shared cost recorder (src/lib/costs/record.ts): the step and the code only.
    expect(console.error).toHaveBeenCalledWith("costs: could not record the cost", { step: "transcription", code: "42501" });
    expect(console.error).toHaveBeenCalledWith("costs: could not record the cost", { step: "grading", code: "42501" });
  });

  it("still grades when the cost log request throws", async () => {
    // A cost log that rejects instead of returning an error must not escape processCheckin.
    const rejecting = { abortSignal: () => rejecting, then: (_: unknown, reject: (e: unknown) => void) => reject(new Error("network down")) };
    const client = vi.mocked(createServiceRoleClient)() as unknown as { from: (t: string) => Record<string, unknown> };
    vi.mocked(createServiceRoleClient).mockReturnValue({
      ...client,
      from: (table: string) => (table === "processing_costs" ? { insert: () => rejecting } : client.from(table)),
    } as never);
    expect(await processCheckin(CHECKIN)).toBe("graded");
    // The error's name only: a message could carry anything.
    expect(console.error).toHaveBeenCalledWith("costs: could not record the cost", { step: "grading", error: "Error" });
  });

  it("logs only the grading cost when it reuses a saved transcript", async () => {
    rpc.mockResolvedValue(claim({ transcript: TRANSCRIPT, attempts: 2 }));
    await processCheckin(CHECKIN);
    expect(inserts.flatMap((i) => i.values.map((v) => v.step))).toEqual(["grading"]);
  });

  it("reports skipped, not graded, when the check-in was reset while it was being graded", async () => {
    updatedRows = []; // a Master Admin deleted the row (0007), so the grade's update changes nothing
    expect(await processCheckin(CHECKIN)).toBe("skipped");
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
    expect(gradeCheckin).toHaveBeenCalledExactlyOnceWith({ transcript: TRANSCRIPT, signal: expect.any(AbortSignal) });
    expect(updates.map((u) => Object.keys(u.values))).toEqual([expect.arrayContaining(["activity_score", "graded_at"])]);
  });

  it("grades an empty saved transcript rather than transcribing again", async () => {
    rpc.mockResolvedValue(claim({ transcript: "" }));
    await processCheckin(CHECKIN);
    expect(transcribe).not.toHaveBeenCalled();
    expect(gradeCheckin).toHaveBeenCalledExactlyOnceWith({ transcript: "", signal: expect.any(AbortSignal) });
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

  it("keeps the whole attempt inside the function's 300 seconds", async () => {
    const made: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      made.push({ ms, controller });
      return controller.signal;
    });
    await processCheckin(CHECKIN);
    // In order: the attempt, the download, transcription, then one limit per database write (two
    // saves, each with its cost-log insert running alongside).
    const [attempt, downloadLimit, transcribeLimit, ...saves] = made;
    expect(saves).toHaveLength(4);
    // Even a write that starts as the attempt runs out finishes inside 300 seconds.
    expect(attempt.ms + Math.max(...saves.map((save) => save.ms))).toBeLessThanOrEqual(290_000);
    expect(downloadLimit.ms).toBeLessThanOrEqual(60_000);
    expect(transcribeLimit.ms).toBeLessThanOrEqual(150_000);
    // Grading gets what's left of the attempt: at least 90 seconds after the longest transcription.
    expect(attempt.ms - transcribeLimit.ms).toBeGreaterThanOrEqual(90_000);
    expect(vi.mocked(gradeCheckin).mock.calls[0][0].signal).toBe(attempt.controller.signal);
    // Running out of the attempt also stops the download and transcription.
    const downloadSignal = download.mock.calls[0][2]?.signal as AbortSignal;
    const transcribeSignal = vi.mocked(transcribe).mock.calls[0][1]?.signal;
    expect([downloadSignal.aborted, transcribeSignal?.aborted]).toEqual([false, false]);
    attempt.controller.abort();
    expect([downloadSignal.aborted, transcribeSignal?.aborted]).toEqual([true, true]);
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

    it("doesn't use them up while rubrics/grading.md is broken, so it grades once the file is fixed", async () => {
      vi.mocked(gradeCheckin).mockRejectedValue(
        new GradingError("rubrics/grading.md can't be used; fix it and redeploy", { reason: "rubric", retryable: false }),
      );
      for (let i = 0; i < 8; i++) expect(await visit()).toBe("failed");
      expect(row.attempts).toBe(0);
      // Transcribed once; every later visit only tries to grade the saved transcript.
      expect(transcribe).toHaveBeenCalledOnce();
      expect(updates.at(-1)?.values).toEqual({
        processing_error: "grading_rubric: GradingError: rubrics/grading.md can't be used; fix it and redeploy",
        processing_attempts: 0,
      });

      vi.mocked(gradeCheckin).mockResolvedValue(GRADE);
      expect(await visit()).toBe("graded");
    });

    it("doesn't use them up while transcription is misconfigured, so it goes through once fixed", async () => {
      vi.mocked(transcribe).mockRejectedValue(
        new TranscriptionError("The transcription account is out of credit.", {
          provider: "openai",
          model: "gpt-transcribe",
          retryable: false,
          config: true,
        }),
      );
      for (let i = 0; i < 8; i++) expect(await visit()).toBe("failed");
      expect(row.attempts).toBe(0);
      expect(updates.at(-1)?.values).toEqual({
        processing_error: "transcription_failed: TranscriptionError: The transcription account is out of credit.",
        processing_attempts: 0,
      });

      vi.mocked(transcribe).mockResolvedValue({ text: TRANSCRIPT, provider: "openai", model: "gpt-transcribe", warnings: [] });
      expect(await visit()).toBe("graded");
    });

    it("counts a recording that can't be transcribed, and stops after five", async () => {
      vi.mocked(transcribe).mockRejectedValue(
        new TranscriptionError("Transcription failed (400).", { provider: "openai", model: "gpt-transcribe", retryable: false }),
      );
      for (let i = 0; i < 5; i++) expect(await visit()).toBe("failed");
      expect(row.attempts).toBe(5);
      expect(await visit()).toBe("skipped");
    });

    it("leaves grading to the next attempt, without using one up, when transcribing took most of this one", async () => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      vi.mocked(transcribe).mockImplementation(async () => {
        now += 130_000;
        return { text: TRANSCRIPT, provider: "openai", model: "gpt-transcribe", warnings: [] };
      });

      expect(await visit()).toBe("failed");
      expect(gradeCheckin).not.toHaveBeenCalled();
      expect(row).toEqual({ attempts: 0, transcript: TRANSCRIPT });
      expect(updates.at(-1)?.values).toMatchObject({
        processing_error: expect.stringMatching(/^grading_deferred: /),
        processing_attempts: 0,
      });

      // The next attempt only grades, with the whole budget.
      expect(await visit()).toBe("graded");
      expect(transcribe).toHaveBeenCalledOnce();
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

    vi.mocked(createServiceRoleClient).mockImplementation(() => {
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
