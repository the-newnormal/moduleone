import "server-only";
import type { createServiceRoleClient } from "@/lib/supabase/admin";

// Logs paid API calls in processing_costs (0008, 0011) for the admin Costs page: numbers and model
// names only, against the check-in or the live session they were for (never a member or any words).
// Never fails what it is logging for: a missing row only makes the month's total a little low.

type Admin = ReturnType<typeof createServiceRoleClient>;

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type CostEntry =
  | { step: "transcription"; checkinId: string; model: string; audioMs: number | null }
  | { step: "grading"; checkinId: string; model: string; usage: Usage }
  | { step: "live_transcription"; liveSessionId: string; model: string; audioMs: number | null }
  | { step: "coaching"; liveSessionId: string; model: string; usage: Usage };

// Each database write gets this long, like the check-in's own saves (process.ts).
const SAVE_MS = 20_000;

function row(entry: CostEntry) {
  const subject =
    "checkinId" in entry ? { checkin_id: entry.checkinId } : { live_session_id: entry.liveSessionId };
  if (entry.step === "transcription" || entry.step === "live_transcription") {
    return { ...subject, step: entry.step, model: entry.model, audio_ms: entry.audioMs };
  }
  return {
    ...subject,
    step: entry.step,
    model: entry.model,
    input_tokens: entry.usage.inputTokens,
    output_tokens: entry.usage.outputTokens,
    cache_read_tokens: entry.usage.cacheReadTokens,
    cache_write_tokens: entry.usage.cacheWriteTokens,
  };
}

export async function recordCosts(admin: Admin, entries: CostEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const step = entries[0].step;
  try {
    const { error } = await admin.from("processing_costs").insert(entries.map(row)).abortSignal(AbortSignal.timeout(SAVE_MS));
    if (error) console.error("costs: could not record the cost", { step, code: error.code });
  } catch (error) {
    console.error("costs: could not record the cost", { step, error: error instanceof Error ? error.name : "unknown" });
  }
}
