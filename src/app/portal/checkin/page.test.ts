import { redirect } from "next/navigation";
import { after } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeSections } from "@/lib/checkin/notice";
import { processCheckin } from "@/lib/checkin/process";
import { DEFAULT_OPENING_QUESTION, QUESTIONS } from "@/lib/checkin/week";
import { coachRubric } from "@/lib/coach/rubric";
import { RubricError } from "@/lib/rubrics/markdown";
import { createClient } from "@/lib/supabase/server";
import { tidyMemberAudio } from "./housekeeping";
import CheckinPage from "./page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  // The recorder refreshes the page after a save; rendering it needs only the hook.
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/checkin/process", () => ({ processCheckin: vi.fn() }));
// The real rubric, unless a test breaks it.
vi.mock("@/lib/coach/rubric", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coach/rubric")>();
  return { ...actual, coachRubric: vi.fn(actual.coachRubric) };
});
vi.mock("./housekeeping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./housekeeping")>()),
  tidyMemberAudio: vi.fn(),
}));
// The client components' server actions aren't called while rendering; keep their imports inert.
vi.mock("./actions", () => ({
  acceptNotice: vi.fn(),
  prepareRecording: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  submitCheckin: vi.fn(),
}));

const NOW = new Date("2026-10-08T04:00:00Z"); // Thursday noon in Singapore
const WEEK = "2026-10-05";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const CHECKIN = "d1000000-0000-4000-8000-000000000001";
const DRAFT_PATH = `${MEMBER}/${WEEK}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`;
const PLAYBACK = `http://127.0.0.1:54321/storage/v1/object/sign/checkin-audio/${DRAFT_PATH}?token=play`;

type Result = { data: unknown; error: unknown };
type Query = { table: string; columns: string; filters: [string, unknown][] };

let reads: Record<string, Result>;
let queries: Query[];
const getClaims = vi.fn();
const createSignedUrl = vi.fn();
function from(table: string) {
  const query: Query = { table, columns: "", filters: [] };
  queries.push(query);
  const builder = {
    select(columns: string) {
      query.columns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return builder;
    },
    maybeSingle: async () => reads[table] ?? { data: null, error: null },
  };
  return builder;
}

// A graded check-in as the database holds it. RLS lets members read their own row, grade
// included; the page must neither ask for nor show it.
const GRADED = {
  id: CHECKIN,
  submitted_at: "2026-10-07T06:15:00Z",
  graded_at: "2026-10-07T06:17:00Z",
  processing_started_at: "2026-10-07T06:15:01Z",
  processing_error: null,
  processing_attempts: 1,
  activity_score: 4,
  excellence_score: 2,
  morale_score: 1,
  category: "wellbeing",
  rubric_review: "Sounds burnt out; raise with the leader.",
  transcript: "Honestly this week was rough and I am exhausted.",
};

async function render() {
  return renderToStaticMarkup(await CheckinPage());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  reads = {
    members: { data: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" }, error: null },
    recording_notices: { data: { member_id: MEMBER }, error: null },
    checkins: { data: null, error: null },
    checkin_drafts: { data: null, error: null },
  };
  queries = [];
  vi.mocked(createClient).mockResolvedValue({
    auth: { getClaims },
    from,
    storage: { from: () => ({ createSignedUrl }) },
  } as never);
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "u1", email: "mei@example.com" } }, error: null });
  createSignedUrl.mockReset().mockResolvedValue({ data: { signedUrl: PLAYBACK }, error: null });
  vi.mocked(after).mockReset();
  vi.mocked(processCheckin).mockReset();
  vi.mocked(tidyMemberAudio).mockReset();
  vi.mocked(redirect).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Runs what the page scheduled with after().
async function runAfter() {
  for (const [task] of vi.mocked(after).mock.calls) await (task as () => unknown)();
}

describe("/portal/checkin", () => {
  it("sends a signed-out visitor to sign in, then back here", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(CheckinPage()).rejects.toThrow("NEXT_REDIRECT /login?next=/portal/checkin");
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/login?next=/portal/checkin");
  });

  it("shows the week and when it closes", async () => {
    const html = await render();
    expect(html).toContain("Week of Monday 5 October");
    expect(html).toContain("Submit by Sunday 11 October, 11:59 pm Singapore time");
  });

  it("tells a user with no members row to ask HQ", async () => {
    reads.members = { data: null, error: null };
    const html = await render();
    expect(html).toContain("Your account isn&#x27;t set up yet. Ask HQ.");
    expect(html).not.toContain("Turn on my camera");
    expect(queries.map((q) => q.table)).toEqual(["members"]);
    expect(after).not.toHaveBeenCalled();
  });

  it("shows the privacy notice until it is accepted", async () => {
    reads.recording_notices = { data: null, error: null };
    const html = await render();
    for (const { heading } of noticeSections()) expect(html).toContain(heading);
    expect(html).toContain("I understand, continue");
    expect(html).not.toContain("Turn on my camera");
  });

  it("looks for the notice accepted with this login, not the member row's earlier one", async () => {
    await render();
    expect(queries.find((q) => q.table === "recording_notices")?.filters).toEqual(
      expect.arrayContaining([
        ["member_id", MEMBER],
        ["auth_user_id", "u1"],
      ]),
    );
  });

  it("shows the recorder when there's nothing yet, with the one open question", async () => {
    const html = await render();
    expect(html).toContain("Turn on my camera"); // they record looking at themselves, so the camera comes first
    expect(html).toContain(renderToStaticMarkup(coachRubric().opening));
    for (const { text: question } of QUESTIONS) expect(html).not.toContain(renderToStaticMarkup(question));
  });

  it("asks the one open question, without follow-ups, while live check-ins are off", async () => {
    vi.stubEnv("LIVE_CHECKIN", "off");
    const html = await render();
    expect(html).toContain(renderToStaticMarkup(coachRubric().opening));
    expect(html).toContain("There&#x27;s one question.");
    expect(html).not.toContain("We&#x27;ll start with one question");
    expect(html).not.toContain("What have you done this week?");
  });

  it("starts with the coach's one open question while live check-ins are on", async () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    const html = await render();
    expect(html).toContain("Turn on my camera");
    expect(html).toContain("We&#x27;ll start with one question");
    expect(html).toContain(renderToStaticMarkup(coachRubric().opening));
    expect(html).not.toContain("What have you done this week?");
  });

  it("asks the built-in opening question, without follow-ups, when rubrics/coach.md can't be used", async () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    vi.mocked(coachRubric).mockImplementationOnce(() => {
      throw new RubricError("rubrics/coach.md", ['"## Opening question" is missing.']);
    });
    const html = await render();
    expect(html).toContain("Turn on my camera");
    expect(html).toContain(renderToStaticMarkup(DEFAULT_OPENING_QUESTION));
    expect(html).toContain("There&#x27;s one question.");
    expect(html).not.toContain("We&#x27;ll start with one question");
    expect(html).not.toContain("What have you done this week?");
  });

  it("shows the draft with playback, its length and when it was recorded", async () => {
    reads.checkin_drafts = {
      data: {
        audio_path: DRAFT_PATH,
        duration_ms: 192_000,
        recorded_at: "2026-10-08T03:30:00Z",
        created_at: "2026-10-08T03:45:00Z", // saved later, e.g. after a retry
      },
      error: null,
    };
    const html = await render();
    // Two hours: long enough to come back to the tab and listen before submitting.
    expect(createSignedUrl).toHaveBeenCalledExactlyOnceWith(DRAFT_PATH, 7200);
    expect(html).toContain(`src="${PLAYBACK}"`);
    expect(html).toContain("Recorded Thursday 8 October at 11:30 am · 3 min 12 s");
    expect(html).toContain("Delete and record again");
    expect(html).toContain("Submit check-in");
    expect(html).not.toContain("Turn on my camera");
  });

  it("shows when the draft was saved when its recording time is unknown", async () => {
    reads.checkin_drafts = {
      data: { audio_path: DRAFT_PATH, duration_ms: null, recorded_at: "-infinity", created_at: "2026-10-08T03:45:00Z" },
      error: null,
    };
    expect(await render()).toContain("Recorded Thursday 8 October at 11:45 am");
  });

  it("still offers submit and delete when playback can't be signed", async () => {
    reads.checkin_drafts = {
      data: { audio_path: DRAFT_PATH, duration_ms: null, recorded_at: NOW.toISOString(), created_at: NOW.toISOString() },
      error: null,
    };
    createSignedUrl.mockResolvedValue({ data: null, error: { name: "StorageApiError", message: "nope" } });
    const html = await render();
    expect(html).not.toContain("<audio");
    expect(html).toContain("Couldn&#x27;t load the recording for playback");
    expect(html).toContain("Submit check-in");
  });

  it("shows when the check-in was submitted, and nothing about the grade or transcript", async () => {
    reads.checkins = { data: GRADED, error: null };
    const html = await render();
    expect(html).toContain("Submitted on Wednesday 7 October at 2:15 pm. Thanks, see you next week.");
    for (const secret of ["wellbeing", "burnt out", "exhausted", "rough", "score", "Score", "review", "transcript"]) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toMatch(/\b[1-5]\s*\/\s*5\b/);
    expect(html).not.toContain("Turn on my camera");
    expect(html).not.toContain("Submit check-in");
  });

  it("never asks the database for the grade or the transcript", async () => {
    reads.checkins = { data: GRADED, error: null };
    await render();
    const checkins = queries.filter((q) => q.table === "checkins");
    expect(checkins).toHaveLength(1);
    expect(checkins[0].columns).not.toMatch(/\*|score|category|review|transcript|grader/);
    expect(checkins[0].columns.split(",").map((c) => c.trim())).toEqual([
      "id",
      "submitted_at",
      "graded_at",
      "processing_started_at",
      "processing_error",
      "processing_attempts",
    ]);
    expect(checkins[0].filters).toEqual([
      ["member_id", MEMBER],
      ["week_start", WEEK],
    ]);
  });

  it("covers check-ins made before submitting existed", async () => {
    reads.checkins = { data: { ...GRADED, submitted_at: null }, error: null };
    expect(await render()).toContain("Your check-in for this week is in. Thanks, see you next week.");
  });

  it("asks for a refresh when loading fails", async () => {
    reads.checkin_drafts = { data: null, error: { code: "PGRST000", message: "down" } };
    const html = await render();
    expect(html).toContain("Couldn&#x27;t load your check-in. Refresh the page to try again.");
    expect(console.error).toHaveBeenCalledWith("checkin page: loading failed", { what: "draft", code: "PGRST000" });
  });

  it("tidies the member's files after the response", async () => {
    await render();
    expect(after).toHaveBeenCalledOnce();
    expect(tidyMemberAudio).not.toHaveBeenCalled();
    await runAfter();
    expect(tidyMemberAudio).toHaveBeenCalledExactlyOnceWith(MEMBER, WEEK);
    expect(processCheckin).not.toHaveBeenCalled();
  });

  it("retries a submitted check-in whose processing failed", async () => {
    reads.checkins = {
      data: { ...GRADED, graded_at: null, processing_error: "transcription_failed: 503", processing_attempts: 2 },
      error: null,
    };
    const html = await render();
    expect(html).not.toContain("transcription_failed");
    await runAfter();
    expect(processCheckin).toHaveBeenCalledExactlyOnceWith(CHECKIN);
  });

  it.each([
    ["graded", GRADED],
    ["being processed", { ...GRADED, graded_at: null, processing_started_at: "2026-10-08T03:58:00Z" }],
    ["out of attempts", { ...GRADED, graded_at: null, processing_error: "x", processing_attempts: 5 }],
  ])("doesn't retry a check-in that is %s", async (_label, row) => {
    reads.checkins = { data: row, error: null };
    await render();
    await runAfter();
    expect(processCheckin).not.toHaveBeenCalled();
  });
});
