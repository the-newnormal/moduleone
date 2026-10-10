import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdminPage } from "@/lib/admin/session";
import type { CostRow } from "@/lib/costs/costs";
import CostsPage from "./page";

vi.mock("@/lib/admin/session", () => ({ requireAdminPage: vi.fn() }));

type Result = { data: CostRow[] | null; error: { code: string; message: string } | null };

let result: Result;
let columns: string;

// processing_costs as the admin's client reads it: one page of rows, whatever the range.
function from(table: string) {
  expect(table).toBe("processing_costs");
  const builder = {
    select(selected: string) {
      columns = selected;
      return builder;
    },
    gte: () => builder,
    order: () => builder,
    range: async () => result,
  };
  return builder;
}

const row = (overrides: Partial<CostRow>): CostRow => ({
  checkin_id: null,
  live_session_id: null,
  step: "transcription",
  model: "openai:gpt-transcribe",
  audio_ms: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  created_at: "2026-10-06T02:00:00Z",
  ...overrides,
});

const tokens = { audio_ms: null, input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

beforeEach(() => {
  vi.mocked(requireAdminPage).mockResolvedValue({ supabase: { from } } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  columns = "";
  result = { data: [], error: null };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const render = async () => renderToStaticMarkup(await CostsPage());
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const cells = (html: string) => [...html.matchAll(/<td class="[^"]*">(.*?)<\/td>/g)].map((m) => text(m[1]));

describe("CostsPage", () => {
  it("reads the live session column and names the live models and switch", async () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    vi.stubEnv("STT_LIVE_MODEL", "");
    vi.stubEnv("COACH_MODEL", "claude-sonnet-5-5");
    const html = text(await render());
    expect(columns).toContain("live_session_id");
    expect(columns).toContain("checkin_id");
    expect(html).toContain("Live check-ins are on (LIVE_CHECKIN). They transcribe with openai:gpt-live-transcribe (STT_LIVE_MODEL)");
    expect(html).toContain("coach with claude-sonnet-5-5 (COACH_MODEL)");
    expect(html).toContain("No check-ins have been processed yet.");
  });

  it("says when live check-ins are off", async () => {
    vi.stubEnv("LIVE_CHECKIN", "off");
    vi.stubEnv("COACH_MODEL", "");
    expect(text(await render())).toContain(
      "Live check-ins are off (LIVE_CHECKIN). When on, they transcribe with openai:gpt-live-transcribe (STT_LIVE_MODEL) and coach with claude-haiku-5-5 (COACH_MODEL).",
    );
  });

  it("shows live costs in their own columns, in the total and per check-in", async () => {
    result = {
      data: [
        // One check-in, d1: 10 minutes at $0.0045 and a million Haiku input tokens at $0.10.
        row({ checkin_id: "d1", audio_ms: 600_000 }),
        row({ checkin_id: "d1", step: "grading", model: "claude-haiku-5-5", ...tokens }),
        // Two live sessions, one never submitted: 10 minutes at $0.017 and two coach calls.
        row({ live_session_id: "l1", step: "live_transcription", model: "openai:gpt-live-transcribe", audio_ms: 300_000 }),
        row({ live_session_id: "l2", step: "live_transcription", model: "openai:gpt-live-transcribe", audio_ms: 300_000 }),
        row({ live_session_id: "l1", step: "coaching", model: "claude-haiku-5-5", ...tokens }),
        row({ live_session_id: "l2", step: "coaching", model: "claude-haiku-5-5", ...tokens }),
      ],
      error: null,
    };
    const html = await render();
    const headers = [...html.matchAll(/<th class="[^"]*font-medium">([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual([
      "Month",
      "Check-ins",
      "Audio min",
      "Transcription",
      "Gradings",
      "Tokens in",
      "Tokens out",
      "Grading",
      "Live min",
      "Live transcription",
      "Coach calls",
      "Coaching",
      "Total",
      "Per check-in",
    ]);
    expect(cells(html)).toEqual([
      "1",
      "10.0",
      "US$0.0450",
      "1",
      "1,000,000",
      "0",
      "US$0.1000",
      "10.0 2 sessions",
      "US$0.1700",
      "2",
      "US$0.2000",
      // 0.045 + 0.1 + 0.17 + 0.2, all on the one check-in.
      "US$0.5150",
      "US$0.5150",
    ]);
  });

  it("lists a live model it can't price rather than counting it as free", async () => {
    result = {
      data: [row({ live_session_id: "l1", step: "live_transcription", model: "openai:gpt-unknown", audio_ms: 60_000 })],
      error: null,
    };
    const html = await render();
    expect(text(html)).toContain("Not priced: openai:gpt-unknown (live)");
    // One minute, one session, nothing priced; no check-ins this month, so nothing to divide by.
    expect(cells(html).slice(7)).toEqual(["1.0 1 session", "US$0.0000", "0", "US$0.0000", "US$0.0000", "–"]);
  });

  it("throws a calm error when the costs can't be read", async () => {
    result = { data: null, error: { code: "PGRST000", message: "down" } };
    await expect(CostsPage()).rejects.toThrow("Couldn't load the processing costs.");
  });
});
