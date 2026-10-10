import { describe, expect, it } from "vitest";
import { CLAUDE_USD_PER_MTOK, GRADING_USD_PER_MTOK, monthlyCosts, rowCostUsd, singaporeMonth, type CostRow } from "./costs";

const transcription = (overrides: Partial<CostRow> = {}): CostRow => ({
  checkin_id: "d1",
  live_session_id: null,
  step: "transcription",
  model: "openai:gpt-4o-transcribe",
  audio_ms: 600_000,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  created_at: "2026-10-06T02:00:00Z",
  ...overrides,
});

const grading = (overrides: Partial<CostRow> = {}): CostRow => ({
  checkin_id: "d1",
  live_session_id: null,
  step: "grading",
  model: "claude-haiku-5-5",
  audio_ms: null,
  input_tokens: 1_000,
  output_tokens: 2_000,
  cache_read_tokens: 1_000_000,
  cache_write_tokens: 0,
  created_at: "2026-10-06T02:01:00Z",
  ...overrides,
});

// A live session's rows name the session, never a check-in (0011).
const liveTranscription = (overrides: Partial<CostRow> = {}): CostRow => ({
  checkin_id: null,
  live_session_id: "l1",
  step: "live_transcription",
  model: "openai:gpt-live-transcribe",
  audio_ms: 300_000,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  created_at: "2026-10-06T01:59:00Z",
  ...overrides,
});

const coaching = (overrides: Partial<CostRow> = {}): CostRow => ({
  checkin_id: null,
  live_session_id: "l1",
  step: "coaching",
  model: "claude-haiku-5-5",
  audio_ms: null,
  input_tokens: 2_000,
  output_tokens: 100,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  created_at: "2026-10-06T01:58:00Z",
  ...overrides,
});

describe("rowCostUsd", () => {
  it("prices transcription by the minute", () => {
    expect(rowCostUsd(transcription())).toBeCloseTo(0.06);
    // The default model.
    expect(rowCostUsd(transcription({ model: "openai:gpt-transcribe" }))).toBeCloseTo(0.045);
  });

  it("counts a local server as free and an unknown model as not priced", () => {
    expect(rowCostUsd(transcription({ model: "local:parakeet" }))).toBe(0);
    expect(rowCostUsd(transcription({ model: "openai:gpt-unknown" }))).toBeNull();
    expect(rowCostUsd(grading({ model: "claude-unknown" }))).toBeNull();
  });

  it("prices cache reads at 0.05× input on Sonnet 5.5 and Opus 5.5", () => {
    const reads = (model: string) => rowCostUsd(grading({ model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000 }));
    expect(reads("claude-sonnet-5-5")).toBeCloseTo(0.1);
    expect(reads("claude-opus-5-5")).toBeCloseTo(0.2);
    expect(reads("claude-haiku-5-5")).toBeCloseTo(0.01);
  });

  it("prices grading tokens, with cache reads at the cache rate", () => {
    // 1,000 × $0.10 + 2,000 × $0.50 + 1,000,000 × $0.01, per million.
    expect(rowCostUsd(grading())).toBeCloseTo(0.0001 + 0.001 + 0.01);
  });

  it("prices live transcription by the minute of realtime audio", () => {
    // 5 minutes × $0.017.
    expect(rowCostUsd(liveTranscription())).toBeCloseTo(0.085);
    expect(rowCostUsd(liveTranscription({ audio_ms: 0 }))).toBe(0);
  });

  it("doesn't price live transcription it has no streaming price or length for", () => {
    expect(rowCostUsd(liveTranscription({ model: "openai:gpt-unknown" }))).toBeNull();
    // Priced for files, but streaming is priced on its own.
    expect(rowCostUsd(liveTranscription({ model: "openai:gpt-4o-transcribe" }))).toBeNull();
    expect(rowCostUsd(liveTranscription({ model: "local:parakeet" }))).toBeNull();
    expect(rowCostUsd(liveTranscription({ audio_ms: null }))).toBeNull();
  });

  it("prices coach calls by Claude tokens, like grading", () => {
    // 2,000 × $0.10 + 100 × $0.50, per million.
    expect(rowCostUsd(coaching())).toBeCloseTo(0.0002 + 0.00005);
    expect(rowCostUsd(coaching({ model: "claude-sonnet-5-5", cache_read_tokens: 1_000_000 }))).toBeCloseTo(0.004 + 0.001 + 0.1);
    expect(rowCostUsd(coaching({ model: "claude-unknown" }))).toBeNull();
  });

  it("keeps the old name for the Claude prices", () => {
    expect(GRADING_USD_PER_MTOK).toBe(CLAUDE_USD_PER_MTOK);
  });
});

describe("monthlyCosts", () => {
  it("adds up each Singapore month, newest first", () => {
    const months = monthlyCosts([
      transcription(),
      grading(),
      transcription({ checkin_id: "d2", audio_ms: 300_000 }),
      // A retry graded d2 twice: one check-in, two gradings.
      grading({ checkin_id: "d2" }),
      grading({ checkin_id: "d2" }),
      // 30 Sep 23:30 UTC is 1 Oct in Singapore.
      grading({ checkin_id: "d3", created_at: "2026-09-30T23:30:00Z" }),
      grading({ checkin_id: "d4", created_at: "2026-09-30T15:00:00Z" }),
    ]);
    expect(months.map((m) => m.month)).toEqual(["2026-10", "2026-09"]);
    const [october, september] = months;
    expect(october).toMatchObject({ checkins: 3, gradings: 4, inputTokens: 4 * 1_001_000, outputTokens: 8_000, unpriced: [] });
    expect(october.audioMinutes).toBeCloseTo(15);
    expect(october.transcriptionUsd).toBeCloseTo(0.09);
    expect(october.totalUsd).toBeCloseTo(october.transcriptionUsd + october.gradingUsd);
    expect(september).toMatchObject({ checkins: 1, gradings: 1, audioMinutes: 0 });
  });

  it("names models it can't price and leaves them out of the dollars", () => {
    const [month] = monthlyCosts([transcription({ model: "openai:gpt-unknown" }), grading()]);
    expect(month.unpriced).toEqual(["openai:gpt-unknown"]);
    expect(month.transcriptionUsd).toBe(0);
    expect(month.audioMinutes).toBeCloseTo(10);
  });

  it("doesn't count a recording of unknown length as free", () => {
    const row = transcription({ audio_ms: null });
    expect(rowCostUsd(row)).toBeNull();
    const [month] = monthlyCosts([row, grading()]);
    expect(month.unpriced).toEqual(["openai:gpt-4o-transcribe (length unknown)"]);
    expect(month.transcriptionUsd).toBe(0);
    expect(month.checkins).toBe(1);
  });

  it("adds up live sessions apart from check-ins, and puts them in the total", () => {
    const months = monthlyCosts([
      // Siti's session became check-in d1; Wei Ling's l2 was never submitted.
      liveTranscription(),
      coaching(),
      coaching(),
      transcription(),
      grading(),
      liveTranscription({ live_session_id: "l2", audio_ms: 120_000 }),
      coaching({ live_session_id: "l2" }),
    ]);
    expect(months).toHaveLength(1);
    const [month] = months;
    // Only d1 is a check-in: the live rows' null ids aren't counted as one.
    expect(month).toMatchObject({ checkins: 1, liveSessions: 2, coachCalls: 3, gradings: 1, unpriced: [] });
    expect(month.liveMinutes).toBeCloseTo(7);
    expect(month.liveTranscriptionUsd).toBeCloseTo(7 * 0.017);
    expect(month.coachingUsd).toBeCloseTo(3 * 0.00025);
    // The coach's tokens are in its own dollars, not in grading's token counts.
    expect(month).toMatchObject({ inputTokens: 1_001_000, outputTokens: 2_000 });
    expect(month.audioMinutes).toBeCloseTo(10);
    expect(month.transcriptionUsd).toBeCloseTo(0.06);
    expect(month.gradingUsd).toBeCloseTo(0.0111);
    expect(month.totalUsd).toBeCloseTo(0.06 + 0.0111 + 7 * 0.017 + 3 * 0.00025);
  });

  it("counts a month with only live sessions as having no check-ins", () => {
    const [month] = monthlyCosts([liveTranscription(), coaching()]);
    expect(month).toMatchObject({ checkins: 0, liveSessions: 1, coachCalls: 1, gradings: 0, audioMinutes: 0 });
    expect(month.totalUsd).toBeCloseTo(0.085 + 0.00025);
  });

  it("names live models it can't price, marked as live, and leaves them out of the dollars", () => {
    const [month] = monthlyCosts([
      liveTranscription({ model: "openai:gpt-unknown" }),
      liveTranscription({ live_session_id: "l2", audio_ms: null }),
      coaching({ model: "claude-unknown" }),
      transcription({ model: "openai:gpt-unknown" }),
    ]);
    expect(month.unpriced).toEqual([
      "claude-unknown",
      "openai:gpt-live-transcribe (live, length unknown)",
      "openai:gpt-unknown",
      "openai:gpt-unknown (live)",
    ]);
    expect(month).toMatchObject({ liveTranscriptionUsd: 0, coachingUsd: 0, transcriptionUsd: 0, totalUsd: 0, coachCalls: 1 });
    expect(month.liveMinutes).toBeCloseTo(5);
  });

  it("is empty with no rows", () => {
    expect(monthlyCosts([])).toEqual([]);
  });
});

describe("singaporeMonth", () => {
  it("uses Singapore time", () => {
    expect(singaporeMonth("2026-12-31T16:00:00Z")).toBe("2027-01");
    expect(singaporeMonth("2026-12-31T15:59:59Z")).toBe("2026-12");
  });
});
