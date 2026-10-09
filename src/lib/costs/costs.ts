// Prices and monthly totals for the admin Costs page, from processing_costs rows (0007). The rows
// keep usage only; prices live here, so a price change is a code change, not a migration. Figures
// are estimates for checking the bill, not the bill itself.

// US$ per minute of audio, by `<provider>:<model>` as transcript_model records it. A local server
// costs nothing per call. A model missing here shows as "not priced" rather than as free.
export const TRANSCRIPTION_USD_PER_MINUTE: Record<string, number> = {
  // The default (src/lib/stt/config.ts).
  "openai:gpt-transcribe": 0.0045,
  "openai:gpt-4o-transcribe": 0.006,
  "openai:gpt-4o-mini-transcribe": 0.003,
  "openai:whisper-1": 0.006,
};

type TokenPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

// US$ per million tokens. Cache writes are the 5-minute kind (1.25× input). Claude Haiku 5.5's
// price is for prompts up to 100K tokens; a check-in transcript is a few thousand.
export const GRADING_USD_PER_MTOK: Record<string, TokenPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Refusal fallbacks can answer with an older model.
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export type CostRow = {
  checkin_id: string;
  step: "transcription" | "grading";
  model: string;
  audio_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  created_at: string;
};

export type MonthCosts = {
  // "2026-10", in Singapore time like the check-in weeks.
  month: string;
  checkins: number;
  audioMinutes: number;
  transcriptionUsd: number;
  gradings: number;
  // Every input token, cached or not.
  inputTokens: number;
  outputTokens: number;
  gradingUsd: number;
  totalUsd: number;
  // Calls this month that can't be priced (a model with no price above, or a recording of unknown
  // length); they are left out of the US$ figures.
  unpriced: string[];
};

export function rowCostUsd(row: CostRow): number | null {
  if (row.step === "transcription") {
    if (row.model.startsWith("local:")) return 0;
    const perMinute = TRANSCRIPTION_USD_PER_MINUTE[row.model];
    // A recording whose length the recorder didn't report can't be priced; it isn't free.
    return perMinute === undefined || row.audio_ms === null ? null : (row.audio_ms / 60_000) * perMinute;
  }
  const price = GRADING_USD_PER_MTOK[row.model];
  if (!price) return null;
  return (
    ((row.input_tokens ?? 0) * price.input +
      (row.output_tokens ?? 0) * price.output +
      (row.cache_read_tokens ?? 0) * price.cacheRead +
      (row.cache_write_tokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

// The Costs page reads about thirteen months, so this month can be set against the same month
// last year.
const HISTORY_DAYS = 400;

export function costHistoryStart(now: Date = new Date()): string {
  return new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

const SINGAPORE_MONTH = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit" });

export function singaporeMonth(iso: string): string {
  const parts = SINGAPORE_MONTH.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

// Newest month first.
export function monthlyCosts(rows: readonly CostRow[]): MonthCosts[] {
  const months = new Map<string, MonthCosts & { ids: Set<string>; unpricedSet: Set<string> }>();
  for (const row of rows) {
    const key = singaporeMonth(row.created_at);
    let month = months.get(key);
    if (!month) {
      month = {
        month: key,
        checkins: 0,
        audioMinutes: 0,
        transcriptionUsd: 0,
        gradings: 0,
        inputTokens: 0,
        outputTokens: 0,
        gradingUsd: 0,
        totalUsd: 0,
        unpriced: [],
        ids: new Set(),
        unpricedSet: new Set(),
      };
      months.set(key, month);
    }
    month.ids.add(row.checkin_id);
    const usd = rowCostUsd(row);
    if (usd === null) {
      month.unpricedSet.add(row.step === "transcription" && row.audio_ms === null ? `${row.model} (length unknown)` : row.model);
    }
    if (row.step === "transcription") {
      month.audioMinutes += (row.audio_ms ?? 0) / 60_000;
      month.transcriptionUsd += usd ?? 0;
    } else {
      month.gradings += 1;
      month.inputTokens += (row.input_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);
      month.outputTokens += row.output_tokens ?? 0;
      month.gradingUsd += usd ?? 0;
    }
  }
  return [...months.values()]
    .map(({ ids, unpricedSet, ...month }) => ({
      ...month,
      checkins: ids.size,
      totalUsd: month.transcriptionUsd + month.gradingUsd,
      unpriced: [...unpricedSet].sort(),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}
