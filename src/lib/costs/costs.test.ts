import { describe, expect, it } from "vitest";
import { monthlyCosts, rowCostUsd, singaporeMonth, type CostRow } from "./costs";

const transcription = (overrides: Partial<CostRow> = {}): CostRow => ({
  checkin_id: "d1",
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

  it("prices grading tokens, with cache reads at the cache rate", () => {
    // 1,000 × $0.10 + 2,000 × $0.50 + 1,000,000 × $0.01, per million.
    expect(rowCostUsd(grading())).toBeCloseTo(0.0001 + 0.001 + 0.01);
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
