// Prices and monthly totals for the admin Costs page, from processing_costs rows (0008, 0011). The
// rows keep usage only; prices live here, so a price change is a code change, not a migration.
// Figures are estimates for checking the bill, not the bill itself.

// US$ per minute of audio, by `<provider>:<model>` as transcript_model records it. A local server
// costs nothing per call. A model missing here shows as "not priced" rather than as free.
export const TRANSCRIPTION_USD_PER_MINUTE: Record<string, number> = {
  // The default (src/lib/stt/config.ts).
  "openai:gpt-transcribe": 0.0045,
  "openai:gpt-4o-transcribe": 0.006,
  "openai:gpt-4o-mini-transcribe": 0.003,
  "openai:whisper-1": 0.006,
};

// US$ per minute of the live check-in's realtime audio, by `openai:<model>` as the live session
// records it (STT_LIVE_MODEL). Kept apart from the prices above because streaming is priced on its
// own, even for a model that also transcribes files; a model missing here shows as "not priced".
export const LIVE_TRANSCRIPTION_USD_PER_MINUTE: Record<string, number> = {
  // The default (src/lib/checkin/live-config.ts). OpenAI's listed price per minute of realtime
  // audio; check the pricing page.
  "openai:gpt-live-transcribe": 0.017,
};

type TokenPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

// US$ per million tokens (platform.claude.com/docs/en/about-claude/pricing), for grading and the
// live coach alike. Cache writes are the 5-minute kind (1.25× input); cache reads are 0.1× input,
// but 0.05× on Opus 5.5 and Sonnet 5.5. Claude Haiku 5.5's price is for prompts up to 100K tokens;
// a check-in transcript is a few thousand.
export const CLAUDE_USD_PER_MTOK: Record<string, TokenPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Refusal fallbacks can answer with an older model.
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

// The name these prices had before the live coach used them too (src/lib/grader/compare.live.test.ts).
export const GRADING_USD_PER_MTOK = CLAUDE_USD_PER_MTOK;

export type CostRow = {
  // A check-in's steps (transcription, grading) name the check-in; a live session's steps (its
  // realtime transcription, its coach calls) name the session instead, whether or not it became one.
  checkin_id: string | null;
  live_session_id: string | null;
  step: "transcription" | "grading" | "live_transcription" | "coaching";
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
  // Every input token grading used, cached or not (the coach's are only in coachingUsd).
  inputTokens: number;
  outputTokens: number;
  gradingUsd: number;
  // Live check-in sessions with a cost this month, submitted or not.
  liveSessions: number;
  liveMinutes: number;
  liveTranscriptionUsd: number;
  coachCalls: number;
  coachingUsd: number;
  totalUsd: number;
  // Calls this month that can't be priced (a model with no price above, or a recording of unknown
  // length); they are left out of the US$ figures.
  unpriced: string[];
};

function audioCostUsd(prices: Record<string, number>, row: CostRow): number | null {
  const perMinute = prices[row.model];
  // A recording whose length the recorder didn't report can't be priced; it isn't free.
  return perMinute === undefined || row.audio_ms === null ? null : (row.audio_ms / 60_000) * perMinute;
}

function tokenCostUsd(row: CostRow): number | null {
  const price = CLAUDE_USD_PER_MTOK[row.model];
  if (!price) return null;
  return (
    ((row.input_tokens ?? 0) * price.input +
      (row.output_tokens ?? 0) * price.output +
      (row.cache_read_tokens ?? 0) * price.cacheRead +
      (row.cache_write_tokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

export function rowCostUsd(row: CostRow): number | null {
  switch (row.step) {
    case "transcription":
      return row.model.startsWith("local:") ? 0 : audioCostUsd(TRANSCRIPTION_USD_PER_MINUTE, row);
    case "live_transcription":
      // Always OpenAI's realtime API: a local server has none, so nothing here is free.
      return audioCostUsd(LIVE_TRANSCRIPTION_USD_PER_MINUTE, row);
    case "grading":
    case "coaching":
      return tokenCostUsd(row);
  }
}

// How an unpriced row is named on the page: a live model is marked as such, since the same model
// can be priced for files and not for streaming.
function unpricedLabel(row: CostRow): string {
  const notes: string[] = [];
  if (row.step === "live_transcription") notes.push("live");
  if ((row.step === "transcription" || row.step === "live_transcription") && row.audio_ms === null) notes.push("length unknown");
  return notes.length ? `${row.model} (${notes.join(", ")})` : row.model;
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

type MonthTally = MonthCosts & { checkinIds: Set<string>; sessionIds: Set<string>; unpricedSet: Set<string> };

// Newest month first.
export function monthlyCosts(rows: readonly CostRow[]): MonthCosts[] {
  const months = new Map<string, MonthTally>();
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
        liveSessions: 0,
        liveMinutes: 0,
        liveTranscriptionUsd: 0,
        coachCalls: 0,
        coachingUsd: 0,
        totalUsd: 0,
        unpriced: [],
        checkinIds: new Set(),
        sessionIds: new Set(),
        unpricedSet: new Set(),
      };
      months.set(key, month);
    }
    // A live session's rows have no check-in: counting them would make "per check-in" too low.
    if (row.checkin_id !== null) month.checkinIds.add(row.checkin_id);
    if (row.live_session_id !== null) month.sessionIds.add(row.live_session_id);
    const usd = rowCostUsd(row);
    if (usd === null) month.unpricedSet.add(unpricedLabel(row));
    switch (row.step) {
      case "transcription":
        month.audioMinutes += (row.audio_ms ?? 0) / 60_000;
        month.transcriptionUsd += usd ?? 0;
        break;
      case "grading":
        month.gradings += 1;
        month.inputTokens += (row.input_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);
        month.outputTokens += row.output_tokens ?? 0;
        month.gradingUsd += usd ?? 0;
        break;
      case "live_transcription":
        month.liveMinutes += (row.audio_ms ?? 0) / 60_000;
        month.liveTranscriptionUsd += usd ?? 0;
        break;
      case "coaching":
        month.coachCalls += 1;
        month.coachingUsd += usd ?? 0;
        break;
    }
  }
  return [...months.values()]
    .map(({ checkinIds, sessionIds, unpricedSet, ...month }) => ({
      ...month,
      checkins: checkinIds.size,
      liveSessions: sessionIds.size,
      totalUsd: month.transcriptionUsd + month.gradingUsd + month.liveTranscriptionUsd + month.coachingUsd,
      unpriced: [...unpricedSet].sort(),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}
