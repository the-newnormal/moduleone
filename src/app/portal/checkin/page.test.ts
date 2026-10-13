// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIARY_COLUMNS, type DiaryRow } from "@/lib/checkin/diary";
import { noteOnboardingForm } from "@/lib/checkin/onboarding-note";
import { processCheckin } from "@/lib/checkin/process";
import { VIEW_LOG_COLUMNS, type ViewLogRow } from "@/lib/checkin/view-log";
import { DEFAULT_OPENING_QUESTION, QUESTIONS } from "@/lib/checkin/week";
import { coachRubric } from "@/lib/coach/rubric";
import { RubricError } from "@/lib/rubrics/markdown";
import { createClient } from "@/lib/supabase/server";
import { VOICE_ONLY_LINE } from "./camera-stage";
import { tidyMemberAudio } from "./housekeeping";
import CheckinPage, { metadata } from "./page";

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
// Mocked whole, so the service-role client it writes with is never made (onboarding-note.test.ts).
vi.mock("@/lib/checkin/onboarding-note", () => ({ noteOnboardingForm: vi.fn() }));
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
  prepareRecording: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  submitCheckin: vi.fn(),
}));
// SavedTake renders nothing until it runs in a browser; mark where it sits.
vi.mock("./saved-take", () => ({
  SavedTake: ({ path }: { path: string | null }) => createElement("i", { "data-saved-take": path ?? "none" }),
}));

const NOW = new Date("2026-10-08T04:00:00Z"); // Thursday noon in Singapore
const WEEK = "2026-10-05";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const CHECKIN = "d1000000-0000-4000-8000-000000000001";
const DRAFT_PATH = `${MEMBER}/${WEEK}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`;
const PLAYBACK = `http://127.0.0.1:54321/storage/v1/object/sign/checkin-audio/${DRAFT_PATH}?token=play`;

type Result = { data: unknown; error: unknown };
type Query = {
  table: string;
  columns: string;
  filters: [string, unknown][];
  order: [string, unknown][];
  limit: number | null;
};

// What maybeSingle() gives, and what awaiting a list gives, per table (a function: worked out when
// the page asks).
let reads: Record<string, Result>;
let lists: Record<string, Result | (() => Result)>;
let queries: Query[];
const getClaims = vi.fn();
const createSignedUrl = vi.fn();
function from(table: string) {
  const query: Query = { table, columns: "", filters: [], order: [], limit: null };
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
    gt(column: string, value: unknown) {
      query.filters.push([`${column} >`, value]);
      return builder;
    },
    order(column: string, options: unknown) {
      query.order.push([column, options]);
      return builder;
    },
    limit(count: number) {
      query.limit = count;
      return builder;
    },
    overrideTypes: () => builder,
    maybeSingle: async () => reads[table] ?? { data: null, error: null },
    then: (onFulfilled: (r: Result) => unknown, onRejected?: (e: unknown) => unknown) => {
      const list = lists[table] ?? { data: [], error: null };
      return Promise.resolve(typeof list === "function" ? list() : list).then(onFulfilled, onRejected);
    },
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

// The member's check-ins as the diary gets them, each also carrying what RLS would hand back if
// asked for everything: grades included.
const POISON = {
  activity_score: 4,
  morale_score: 1,
  category: "wellbeing",
  rubric_review: "SECRET REVIEW burnt out",
  transcript: "SECRET TRANSCRIPT rough exhausted",
};
let n = 0;
function row(week_start: string, fields: Partial<DiaryRow> = {}): DiaryRow {
  n += 1;
  return {
    id: `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    week_start,
    submitted_at: null,
    audio_path: null,
    audio_duration_ms: null,
    audio_keep_days: 90,
    audio_delete_after: null,
    ...POISON,
    ...fields,
  };
}
const take = (week: string, ext = "webm") => `${MEMBER}/${week}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.${ext}`;
const THIS_WEEK = row(WEEK, {
  id: CHECKIN,
  audio_path: take(WEEK),
  audio_duration_ms: 192_000,
  audio_keep_days: 365,
  audio_delete_after: "2027-10-07T06:14:30Z",
  submitted_at: "2026-10-07T06:15:00Z",
});
const SEP_28 = row("2026-09-28", {
  audio_path: take("2026-09-28"),
  audio_duration_ms: 220_000,
  audio_keep_days: 365,
  audio_delete_after: "2027-10-01T02:00:00Z",
  submitted_at: "2026-10-01T03:00:00Z",
});
// Its deadline is today in Singapore: no longer offered, though the file may still be there.
const JUL_20 = row("2026-07-20", {
  audio_path: take("2026-07-20"),
  audio_delete_after: "2026-10-08T10:00:00Z",
  submitted_at: "2026-07-23T03:00:00Z",
});
const JUL_13 = row("2026-07-13", {
  audio_path: take("2026-07-13", "m4a"),
  audio_duration_ms: 125_000,
  audio_keep_days: 90,
  audio_delete_after: "2026-10-12T02:00:00Z",
  submitted_at: "2026-07-17T03:00:00Z",
});
const JUL_06 = row("2026-07-06", { submitted_at: "2026-07-09T03:00:00Z" });
const JAN_05 = row("2026-01-05");
const DEC_29 = row("2025-12-29", { submitted_at: "2026-01-02T03:00:00Z" });
const DEC_22 = row("2025-12-22");
// Before this week's check-in is submitted.
const EARLIER = [SEP_28, JUL_20, JUL_13, JUL_06, JAN_05, DEC_29, DEC_22];

const DRAFT = {
  audio_path: DRAFT_PATH,
  duration_ms: 192_000,
  recorded_at: "2026-10-08T03:30:00Z",
  created_at: "2026-10-08T03:45:00Z", // saved later, e.g. after a retry
};

async function render() {
  return renderToStaticMarkup(await CheckinPage());
}
// The page as a document, to look at its structure.
async function page() {
  return new DOMParser().parseFromString(await render(), "text/html");
}
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const card = (doc: Document) => doc.querySelector<HTMLElement>('div.outline-none[tabindex="-1"]')!;
const entries = (doc: Document) => doc.querySelector<HTMLElement>('section[aria-labelledby="entries-title"]');
const thenAndNow = (doc: Document) => doc.querySelector<HTMLElement>('section[aria-labelledby="then-and-now-title"]');
const entry = (doc: Document, week: string) =>
  [...entries(doc)!.querySelectorAll("li")].find((li) => text(li.querySelector("h4")).startsWith(`Week of ${week}`));
// Every recording address played on the page, as often as it is.
const played = (html: string) => [...html.matchAll(/src="(\/portal\/dashboard\/recording\/[^"]+)"/g)].map((m) => m[1]);

// This week's check-in is in: the card shows it, and the diary has its row.
function submitted() {
  reads.checkins = { data: GRADED, error: null };
  lists.checkins = { data: [THIS_WEEK, ...EARLIER], error: null };
}
const STATES = {
  no_member: () => {
    reads.members = { data: null, error: null };
  },
  unavailable: () => {
    reads.checkin_drafts = { data: null, error: { code: "PGRST000", message: "down" } };
  },
  record: () => {},
  draft: () => {
    reads.checkin_drafts = { data: DRAFT, error: null };
  },
  submitted,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  reads = {
    members: { data: { id: MEMBER, name: "Mei Wong" }, error: null },
    checkins: { data: null, error: null },
    checkin_drafts: { data: null, error: null },
  };
  lists = {
    checkins: { data: EARLIER, error: null },
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
  vi.mocked(noteOnboardingForm).mockReset().mockResolvedValue({ error: null });
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

  it("is the member's own diary", async () => {
    expect(metadata.title).toBe("Diary · Module One");
    const doc = await page();
    expect(text(doc.querySelector("h1"))).toBe("Diary");
    const cover = doc.querySelector("header")!;
    expect([...cover.querySelectorAll("p")].map(text)).toEqual([
      "Mei Wong",
      "Your weekly recordings, in your own voice, to listen back to.",
      "Each recording you submit is also your weekly check-in for your team leader and HQ.",
      "Under each one, you can see which leaders and HQ have opened it or played its recording in Module One, and when. The list starts from when Module One began keeping it.",
    ]);
    expect(queries.find((q) => q.table === "members")?.columns).toBe("id, name");
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
    expect(noteOnboardingForm).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    // Nothing of a diary, nor a name to head it with.
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(entries(doc)).toBeNull();
    expect(thenAndNow(doc)).toBeNull();
    expect([...doc.querySelectorAll("header p")].map(text)).not.toContain("Mei Wong");
  });

  it("shows nothing below this week's card when the member can't be loaded", async () => {
    reads.members = { data: null, error: { code: "PGRST000", message: "down" } };
    const doc = await page();
    expect(text(card(doc))).toBe("Couldn't load your check-in. Refresh the page to try again.");
    expect(entries(doc)).toBeNull();
    expect(queries.map((q) => q.table)).toEqual(["members"]);
    expect(noteOnboardingForm).not.toHaveBeenCalled();
  });

  // No privacy notice in the app (the product owner's decision, 13 October 2026): members agree on
  // the onboarding form, outside Module One. Nobody here has accepted anything.
  it("shows the recorder to a member who never accepted a notice", async () => {
    const html = await render();
    expect(html).toContain("Record your check-in");
    expect(html).toContain("Turn on my camera");
    for (const gone of ["Before you record", "I understand, continue", "How your recording is used"]) {
      expect(html).not.toContain(gone);
    }
  });

  // submit_checkin_draft keeps a take a year only if its login had a one-year row before the take
  // started (0013): the note is written as the page loads, before the recorder can show.
  it("notes the assumed onboarding consent for this member and login, once", async () => {
    await render();
    expect(noteOnboardingForm).toHaveBeenCalledExactlyOnceWith(MEMBER, "u1");
  });

  it.each(["record", "draft", "submitted"] as const)("notes it whatever this week holds (%s)", async (state) => {
    STATES[state]();
    await render();
    expect(noteOnboardingForm).toHaveBeenCalledOnce();
  });

  it("a member who submitted sees Done for this week, whatever they accepted", async () => {
    submitted();
    const doc = await page();
    expect(text(card(doc).querySelector("h2"))).toBe("Done for this week");
    expect(text(card(doc))).toContain("Submitted on Wednesday 7 October at 2:15 pm.");
    expect(text(doc.body)).not.toContain("Before you record");
  });

  it("lists this week's entry under its year, below the card, when the card can't show it", async () => {
    submitted();
    reads.checkin_drafts = { data: null, error: { code: "PGRST000", message: "down" } };
    const html = await render();
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(text(card(doc))).toBe("Couldn't load your check-in. Refresh the page to try again.");
    const thisWeek = entry(doc, "5 October")!;
    expect(thisWeek.closest('section[aria-labelledby="entries-2026"]')).not.toBeNull();
    expect(text(thisWeek)).toContain("Play it in Then and now, above");
    // Its player is Now in Then and now.
    const now = thenAndNow(doc)!.querySelector('article[aria-labelledby="then-and-now-now"]')!;
    expect(now.querySelector("audio")?.getAttribute("src")).toBe(`/portal/dashboard/recording/${CHECKIN}.webm`);
    // Below the card, in page order.
    const order = [card(doc), thenAndNow(doc)!, entries(doc)!];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(played(html)).toHaveLength(new Set(played(html)).size);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("shows the recorder when there's nothing yet, with the one open question", async () => {
    const html = await render();
    expect(html).toContain("Turn on my camera"); // the camera comes first, so they can see themselves as they talk
    expect(html).toContain("Record without camera"); // but it's optional
    expect(html).toContain(renderToStaticMarkup(VOICE_ONLY_LINE));
    expect(html).not.toContain("You record with your camera on");
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
    reads.checkin_drafts = { data: DRAFT, error: null };
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
    const doc = await page();
    expect(card(doc).querySelector("audio")).toBeNull();
    expect(text(card(doc))).toContain("Couldn't load the recording for playback");
    expect(text(card(doc))).toContain("Submit check-in");
  });

  it("shows when the check-in was submitted, and nothing about the grade or transcript", async () => {
    submitted();
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
    submitted();
    await render();
    const checkins = queries.filter((q) => q.table === "checkins");
    expect(checkins).toHaveLength(2);
    // This week's: what processing needs, to show the card and retry.
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
    // The diary's: the member's own, newest first, all of them.
    expect(checkins[1].columns).toBe(DIARY_COLUMNS);
    expect(checkins[1].columns.split(",").map((c) => c.trim())).toEqual([
      "id",
      "week_start",
      "submitted_at",
      "audio_path",
      "audio_duration_ms",
      "audio_keep_days",
      "audio_delete_after",
    ]);
    expect(checkins[1].filters).toEqual([["member_id", MEMBER]]);
    expect(checkins[1].order).toEqual([["week_start", { ascending: false }]]);
    expect(checkins[1].limit).toBeNull();
    for (const query of checkins) {
      expect(query.columns).not.toMatch(/\*|score|category|review|transcript|grader|rubric|mention|team/);
    }
    expect(new Set(queries.map((q) => q.table))).toEqual(
      new Set(["members", "checkins", "checkin_drafts", "checkin_views"]),
    );
  });

  describe("shows nothing graded, from any row", () => {
    // What the poisoned rows and the graded check-in hold. "rough" as a word: the opening question
    // may well say "through".
    const THEMES = ["SECRET", "wellbeing", "burnt out", "exhausted", /\brough\b/];
    const GRADES = ["score", "Score", "review", "transcript", "category", "Red", "Yellow", "Green", /\b[1-5]\s*\/\s*5\b/];
    const shows = (html: string, word: string | RegExp) => (typeof word === "string" ? html.includes(word) : word.test(html));

    it.each(["record", "draft", "submitted"] as const)("in the %s state", async (state) => {
      STATES[state]();
      const html = await render();
      for (const word of [...THEMES, ...GRADES]) expect(shows(html, word), String(word)).toBe(false);
    });
  });

  it("plays this week's submitted recording in the card", async () => {
    submitted();
    const doc = await page();
    const audio = card(doc).querySelectorAll("audio");
    expect(audio).toHaveLength(1);
    expect(audio[0].getAttribute("src")).toBe(`/portal/dashboard/recording/${CHECKIN}.webm`);
    expect(audio[0].getAttribute("preload")).toBe("none");
    expect(audio[0].getAttribute("aria-label")).toBe("Your recording for the week of 5 October 2026");
    expect(text(card(doc))).toContain("3 min 12 s · Kept until 6 October 2027");
    // SavedTake still tells this tab its take was submitted, last in the card.
    const content = card(doc).querySelector('[data-slot="card-content"]')!;
    expect(content.lastElementChild?.getAttribute("data-saved-take")).toBe("none");
    expect(text(card(doc))).not.toContain("Turn on my camera");
    // Not listed again under Entries.
    expect(entry(doc, "5 October")).toBeUndefined();
  });

  it("says when this week's submitted recording has nothing to play", async () => {
    submitted();
    lists.checkins = { data: [{ ...THIS_WEEK, audio_path: null }, ...EARLIER], error: null };
    const doc = await page();
    expect(card(doc).querySelector("audio")).toBeNull();
    expect(text(card(doc))).toContain("Recording no longer kept");
  });

  describe("gives every recording one player", () => {
    it("before this week's is submitted: Then and now has both, and their entries link up", async () => {
      const html = await render();
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(played(html).sort()).toEqual(
        [`/portal/dashboard/recording/${SEP_28.id}.webm`, `/portal/dashboard/recording/${JUL_13.id}.m4a`].sort(),
      );
      expect(doc.querySelectorAll("audio")).toHaveLength(2);
      const tile = thenAndNow(doc)!;
      expect(text(tile.querySelector("#then-and-now-then"))).toBe("Then Week of 13 July 2026");
      expect(text(tile.querySelector("#then-and-now-now"))).toBe("Now Week of 28 September 2026");
      expect(tile.querySelectorAll("audio")).toHaveLength(2);
      expect(text(entries(doc)).match(/Play it in Then and now, above/g)).toHaveLength(2);
      expect(entries(doc)!.querySelectorAll("audio")).toHaveLength(0);
    });

    it("once it is: this week's plays in the card, and 28 September under Entries", async () => {
      submitted();
      const html = await render();
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(played(html).sort()).toEqual(
        [
          `/portal/dashboard/recording/${CHECKIN}.webm`,
          `/portal/dashboard/recording/${SEP_28.id}.webm`,
          `/portal/dashboard/recording/${JUL_13.id}.m4a`,
        ].sort(),
      );
      expect(doc.querySelectorAll("audio")).toHaveLength(3);
      const now = thenAndNow(doc)!.querySelector('article[aria-labelledby="then-and-now-now"]')!;
      expect(now.querySelector("audio")).toBeNull();
      expect(text(now)).toContain("Play it in this week's entry, above");
      expect(entry(doc, "28 September")!.querySelector("audio")?.getAttribute("src")).toBe(
        `/portal/dashboard/recording/${SEP_28.id}.webm`,
      );
    });
  });

  it.each(["record", "draft", "submitted"] as const)(
    "names every player for screen readers by its own week, year included (%s)",
    async (state) => {
      STATES[state]();
      const doc = await page();
      const labels = [...doc.querySelectorAll("audio")].map((audio) => audio.getAttribute("aria-label") ?? "");
      expect(labels.length).toBeGreaterThan(1);
      for (const label of labels) expect(label).toMatch(/^Your (recording|draft) for the week of \d{1,2} [A-Z][a-z]+ \d{4}$/);
      expect(new Set(labels).size).toBe(labels.length);
      if (state === "draft") {
        expect(card(doc).querySelector("audio")?.getAttribute("aria-label")).toBe("Your draft for the week of 5 October 2026");
      }
    },
  );

  // Then and now's and the entries' links up to where a recording plays.
  it.each([
    ["record", ["#then-and-now-title"]],
    ["submitted", ["#then-and-now-title", "#this-week"]],
  ] as const)("links only to places on the page (%s)", async (state, targets) => {
    STATES[state]();
    const doc = await page();
    const links = [...doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href")!);
    expect([...new Set(links)].sort()).toEqual([...targets].sort());
    for (const href of links) expect(doc.getElementById(href.slice(1)), href).not.toBeNull();
    // "Play it in this week's entry, above" lands on the section that holds this week's card.
    expect(doc.querySelector('section#this-week[aria-label="This week"]')?.contains(card(doc))).toBe(true);
  });

  it.each(["record", "submitted"] as const)("signs nothing for the diary on load (%s)", async (state) => {
    STATES[state]();
    await render();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["no_member", null],
    ["unavailable", null],
    ["record", "Record your check-in"],
    ["draft", "Your recording"],
    ["submitted", "Done for this week"],
  ] as const)("keeps this week's heading first for focus (%s)", async (state, heading) => {
    STATES[state]();
    const wrapper = card(await page());
    const h2 = wrapper.querySelector("h2");
    expect(h2 && text(h2)).toBe(heading);
    for (const h of wrapper.querySelectorAll("h2, h3, h4")) expect(text(h)).not.toMatch(/^(Then and now|Entries)$/);
    expect(wrapper.querySelector("#then-and-now-title, #entries-title")).toBeNull();
  });

  it("groups entries by year", async () => {
    const doc = await page();
    const years = [...entries(doc)!.querySelectorAll("h3")].map(text);
    expect(years).toEqual(["2026", "2025"]);
    const y2025 = entries(doc)!.querySelector('section[aria-labelledby="entries-2025"]')!;
    expect(text(y2025.querySelector("details > summary"))).toBe("2 entries, no recordings to play");
    const dec29 = entry(doc, "29 December")!;
    expect(y2025.contains(dec29)).toBe(true);
    expect(text(dec29.querySelector("h4 .sr-only"))).toBe("2025");
    expect(text(dec29)).toContain("Submitted Friday 2 January 2026");
    expect(text(entry(doc, "6 July"))).toContain("Recording no longer kept");
    expect(text(entry(doc, "5 January"))).toContain("No recording to play");
    expect(text(entry(doc, "13 July"))).toContain("Kept until 11 October 2026");
  });

  it("stops offering a recording on its deadline day", async () => {
    const jul20 = entry(await page(), "20 July")!;
    expect(jul20.querySelector("audio")).toBeNull();
    expect(text(jul20)).toContain("Recording no longer kept");
    expect(text(jul20)).not.toContain("Kept until");
  });

  it("explains 90-day recordings while one can be played", async () => {
    const NOTE = "Recordings you made under the earlier privacy notice are kept for 90 days, as it said.";
    expect(text(entries(await page()))).toContain(NOTE);
    lists.checkins = { data: EARLIER.filter((r) => r !== JUL_13), error: null };
    expect(text(entries(await page()))).not.toContain(NOTE);
  });

  it("says when the first entry was", async () => {
    expect(text(entries(await page()))).toContain("Your first entry was the week of 22 December 2025.");
  });

  describe("keeps this week working when entries can't load", () => {
    const failed = () => {
      lists.checkins = { data: null, error: { code: "PGRST000", message: "down" } };
    };

    it("while recording", async () => {
      failed();
      const doc = await page();
      expect(entries(doc)!.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't load your entries. Refresh the page to try again.",
      );
      expect(text(card(doc))).toContain("Turn on my camera");
      expect(thenAndNow(doc)).toBeNull();
      expect(console.error).toHaveBeenCalledExactlyOnceWith("checkin page: loading failed", {
        what: "diary",
        code: "PGRST000",
      });
    });

    it("once submitted, with the card as it was", async () => {
      submitted();
      failed();
      const doc = await page();
      const content = card(doc).querySelector('[data-slot="card-content"]')!;
      expect([...content.children].map((el) => el.getAttribute("role") ?? el.getAttribute("data-saved-take"))).toEqual([
        "status",
        "none",
      ]);
      expect(text(content)).toBe("Submitted on Wednesday 7 October at 2:15 pm. Thanks, see you next week.");
      expect(doc.querySelector("audio")).toBeNull();
      expect(thenAndNow(doc)).toBeNull();
      expect(text(entries(doc))).toContain("Couldn't load your entries.");
    });
  });

  // Without the note, a take recorded now would be kept 90 days, not the year members are promised.
  it("says it couldn't load, rather than show the recorder, when the note can't be written", async () => {
    vi.mocked(noteOnboardingForm).mockResolvedValue({ error: { code: "PGRST000" } });
    const doc = await page();
    expect(text(card(doc))).toBe("Couldn't load your check-in. Refresh the page to try again.");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("checkin page: loading failed", {
      what: "onboarding_note",
      code: "PGRST000",
    });
    expect(text(doc.body)).not.toContain("Turn on my camera");
    expect(thenAndNow(doc)).not.toBeNull(); // the diary still shows
    expect(entry(doc, "28 September")).toBeDefined();
  });

  // A draft or a submitted check-in already has its start time, so the note can't change how long
  // it is kept: only a new take waits for it.
  it.each(["draft", "submitted"] as const)("still shows the %s card when the note can't be written", async (state) => {
    STATES[state]();
    vi.mocked(noteOnboardingForm).mockResolvedValue({ error: { code: "PGRST000" } });
    const doc = await page();
    expect(text(card(doc))).not.toContain("Couldn't load your check-in");
    if (state === "submitted") expect(text(card(doc).querySelector("h2"))).toBe("Done for this week");
    else expect(card(doc).querySelector("audio")).not.toBeNull(); // the take waiting to be submitted
    expect(console.error).not.toHaveBeenCalledWith("checkin page: loading failed", expect.objectContaining({ what: "onboarding_note" }));
  });

  it("keeps the history when this week can't load", async () => {
    reads.checkin_drafts = { data: null, error: { code: "PGRST000", message: "down" } };
    const doc = await page();
    expect(text(card(doc))).toBe("Couldn't load your check-in. Refresh the page to try again.");
    expect(thenAndNow(doc)).not.toBeNull();
    expect(entry(doc, "28 September")).toBeDefined();
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

// Who opened each check-in (the view log, 0015): read from the member's own rows, shown under the
// entry it was about, and never anything about the viewer but their name and Leader or HQ.
describe("/portal/checkin, who opened it", () => {
  const JANE = "a1000000-0000-4000-8000-000000000001";
  const ALI = "a1000000-0000-4000-8000-000000000002";
  let v = 0;
  // A row as RLS hands it to the owner, carrying what the page must never show.
  function view(fields: Partial<ViewLogRow>): ViewLogRow {
    v += 1;
    return {
      id: `e1000000-0000-4000-8000-${String(v).padStart(12, "0")}`,
      checkin_id: CHECKIN,
      week_start: WEEK,
      viewer_key: JANE,
      viewer_name: "Jane Tan",
      viewer_role: "hq",
      kind: "opened",
      viewed_at: "2026-10-07T07:15:00+00:00",
      ...({ owner_id: MEMBER, viewed_on: "2026-10-07", team: "SECRET TEAM", email: "jane@example.com" } as object),
      ...fields,
    };
  }
  const VIEWS = [
    // This week's, in the card: Jane opened it, and an earlier one she saw before it was reset.
    view({}),
    view({ checkin_id: null, viewed_at: "2026-10-06T01:00:00+00:00" }),
    // 28 September's, under its entry.
    view({ checkin_id: SEP_28.id, week_start: SEP_28.week_start, viewer_key: ALI, viewer_name: "Ali Rahman", viewer_role: "leader", viewed_at: "2026-10-01T02:00:00+00:00" }),
    view({ checkin_id: SEP_28.id, week_start: SEP_28.week_start, viewer_key: ALI, viewer_name: "Ali Rahman", viewer_role: "leader", kind: "played", viewed_at: "2026-10-01T02:05:00+00:00" }),
    // 22 December 2025's, last year.
    view({ checkin_id: DEC_22.id, week_start: DEC_22.week_start, viewed_at: "2025-12-23T02:00:00+00:00" }),
    // 24 August's was reset and never recorded again: no entry left.
    view({ checkin_id: null, week_start: "2026-08-24", viewed_at: "2026-08-27T08:30:00+00:00" }),
  ];
  const noLonger = (doc: Document) => doc.querySelector<HTMLElement>('section[aria-labelledby="no-longer-title"]');
  const lines = (el: Element | null | undefined) => [...(el?.querySelectorAll("li") ?? [])].map(text);

  beforeEach(() => {
    lists.checkin_views = { data: VIEWS, error: null };
  });

  it("reads only the member's own log, a page at a time, apart from their check-ins", async () => {
    submitted();
    await render();
    const log = queries.filter((q) => q.table === "checkin_views");
    expect(log).toHaveLength(1);
    expect(log[0].columns).toBe(VIEW_LOG_COLUMNS);
    expect(log[0].filters).toEqual([["owner_id", MEMBER]]);
    expect(log[0].order).toEqual([["id", undefined]]);
    expect(log[0].limit).toBe(1000);
    // The diary still asks for exactly what it did.
    expect(queries.filter((q) => q.table === "checkins")[1].columns).toBe(DIARY_COLUMNS);
  });

  it("asks for no log without a member", async () => {
    reads.members = { data: null, error: null };
    await render();
    expect(queries.map((q) => q.table)).toEqual(["members"]);
  });

  it("shows this week's under the card's player, before the saved-take marker", async () => {
    submitted();
    const doc = await page();
    const content = card(doc).querySelector('[data-slot="card-content"]')!;
    const details = content.querySelector("details")!;
    expect(text(details.querySelector("summary"))).toBe("Opened by Jane Tan");
    expect(details.hasAttribute("open")).toBe(false);
    expect(lines(details)).toEqual([
      "Jane Tan · HQ — opened your check-in on Wednesday 7 October at 3:15 pm",
      "Jane Tan · HQ — opened your check-in on Tuesday 6 October at 9:00 am (an earlier check-in for this week, since reset)",
    ]);
    expect(content.querySelector("audio")!.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(content.lastElementChild?.getAttribute("data-saved-take")).toBe("none");
  });

  it("shows each entry's under it, with the year when it isn't this one", async () => {
    submitted();
    const doc = await page();
    const sep28 = entry(doc, "28 September")!;
    expect(text(sep28.querySelector("summary"))).toBe("Opened by Ali Rahman");
    expect(lines(sep28)).toEqual([
      "Ali Rahman · Leader — played your recording on Thursday 1 October at 10:05 am",
      "Ali Rahman · Leader — opened your check-in on Thursday 1 October at 10:00 am",
    ]);
    // After its kept-until line.
    const kept = [...sep28.querySelectorAll("p")].find((p) => text(p).startsWith("Kept until"))!;
    expect(kept.compareDocumentPosition(sep28.querySelector("details")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lines(entry(doc, "22 December"))).toEqual(["Jane Tan · HQ — opened your check-in on Tuesday 23 December 2025 at 10:00 am"]);
    // Entries nobody opened say nothing about it.
    for (const week of ["20 July", "13 July", "6 July", "5 January", "29 December"]) {
      expect(entry(doc, week)!.querySelector("details")).toBeNull();
      expect(text(entry(doc, week))).not.toContain("Opened by");
    }
    // Then and now doesn't repeat them.
    expect(text(thenAndNow(doc))).not.toContain("Opened by");
  });

  it("lists weeks with no entry left after the entries, as no longer in the Diary", async () => {
    submitted();
    const doc = await page();
    const section = noLonger(doc)!;
    expect(text(section.querySelector("h2"))).toBe("No longer in your Diary");
    expect([...section.querySelectorAll("h3")].map(text)).toEqual(["Week of 24 August"]);
    expect(lines(section)).toEqual([
      "Jane Tan · HQ — opened your check-in on Thursday 27 August at 4:30 pm (an earlier check-in for this week, since reset)",
    ]);
    expect(entries(doc)!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts this week's there too while it has no entry (reset, and not recorded again yet)", async () => {
    const doc = await page(); // recording: this week has no check-in
    expect([...noLonger(doc)!.querySelectorAll("h3")].map(text)).toEqual(["Week of 5 October", "Week of 24 August"]);
    expect(card(doc).querySelector("details")).toBeNull();
  });

  it("names a few people, then how many more", async () => {
    submitted();
    const people = ["Ann Ong", "Ben Ho", "Cai Lin", "Dev Raj"].map((name, i) =>
      view({ viewer_key: `a2000000-0000-4000-8000-00000000000${i}`, viewer_name: name, viewed_at: `2026-10-07T0${i}:00:00+00:00` }),
    );
    lists.checkin_views = { data: people.slice(0, 3), error: null };
    expect(text(card(await page()).querySelector("summary"))).toBe("Opened by Cai Lin, Ben Ho and Ann Ong");
    lists.checkin_views = { data: people, error: null };
    expect(text(card(await page()).querySelector("summary"))).toBe("Opened by Dev Raj, Cai Lin and 2 others");
  });

  it("says nothing at all when nobody has opened anything", async () => {
    submitted();
    lists.checkin_views = { data: [], error: null };
    const html = await render();
    expect(html).not.toContain("Opened by");
    expect(html).not.toContain("No longer in your Diary");
    expect(html).not.toContain("<details class=\"group\"><summary class=\"flex min-h-10 w-fit");
  });

  it("never shows a grade, the viewer's key, team or email, or the owner", async () => {
    submitted();
    const html = await render();
    for (const word of ["SECRET", "wellbeing", "burnt out", "exhausted", /\brough\b/, "score", "Score", "review", "transcript", "category", "Red", "Yellow", "Green", /\b[1-5]\s*\/\s*5\b/]) {
      expect(typeof word === "string" ? html.includes(word) : word.test(html), String(word)).toBe(false);
    }
    for (const secret of [JANE, ALI, "jane@example.com", "SECRET TEAM", "2026-10-07", "viewed_on"]) {
      expect(html).not.toContain(secret);
    }
  });

  describe("when the log can't load", () => {
    beforeEach(() => {
      lists.checkin_views = { data: null, error: { code: "42P01", message: "relation \"checkin_views\" does not exist" } };
    });

    it("says so in one line, and the rest of the Diary still shows", async () => {
      submitted();
      const doc = await page();
      expect([...doc.querySelectorAll("header p")].map(text)).toContain(
        "Couldn't load who has opened your check-ins. Refresh the page to try again.",
      );
      expect(card(doc).querySelectorAll("audio")).toHaveLength(1);
      expect(entry(doc, "28 September")!.querySelector("audio")).not.toBeNull();
      expect(thenAndNow(doc)).not.toBeNull();
      expect(text(doc.body)).not.toContain("Opened by");
      expect(noLonger(doc)).toBeNull();
      expect(console.error).toHaveBeenCalledExactlyOnceWith("checkin page: loading failed", { what: "views", code: "42P01" });
    });

    it("keeps this week working", async () => {
      expect(text(card(await page()))).toContain("Turn on my camera");
    });
  });

  it("shows none of it when the entries can't load, since there's nothing to put it under", async () => {
    submitted();
    lists.checkins = { data: null, error: { code: "PGRST000", message: "down" } };
    const html = await render();
    expect(html).not.toContain("Opened by");
    expect(html).not.toContain("No longer in your Diary");
    expect(html).not.toContain("Couldn&#x27;t load who has opened");
  });
});

// The page writes more than the onboarding note: after the response it tidies the member's files and
// retries processing, both with the service role (the last tests above). Whoever reviews what a load
// of the Diary does reads its header comment and CLAUDE.md, so neither may say the note is all it
// writes: where either says it writes only one thing, it says of which table (recording_notices), and
// it names the tidying and the retry too.
describe("what the Diary says it writes", () => {
  const ROOT = join(import.meta.dirname, "../../../..");
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

  // The comment above CHECKIN_COLUMNS, without its slashes.
  function pageHeader(): string {
    const source = read("src/app/portal/checkin/page.tsx");
    const end = source.indexOf("const CHECKIN_COLUMNS");
    expect(end).toBeGreaterThan(0);
    const lines = source.slice(0, end).trimEnd().split("\n");
    let start = lines.length;
    while (start > 0 && lines[start - 1].trimStart().startsWith("//")) start -= 1;
    return lines
      .slice(start)
      .map((line) => line.replace(/^\s*\/\/\s?/, ""))
      .join(" ");
  }

  // CLAUDE.md's sentences about the Diary, from "The Diary (`/portal/checkin`)" to the RLS tests.
  function contract(): string {
    const text = read("CLAUDE.md");
    const start = text.indexOf("The Diary (`/portal/checkin`)");
    const end = text.indexOf("RLS tests live in", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  // A sentence ends at a full stop followed by a capital letter or a backtick.
  const sentences = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z`])/);

  function expectAllWritesNamed(text: string) {
    expect(text).toMatch(/onboarding (note|consent)/);
    // Any sentence that says the page writes only one thing says of which table.
    const exclusive = sentences(text).filter((sentence) => /\bwrites (only|one thing)\b/i.test(sentence));
    expect(exclusive.length).toBeGreaterThan(0);
    for (const sentence of exclusive) expect(sentence).toContain("recording_notices");
    // And the after-response work is named alongside it.
    expect(text).toMatch(/\b(tid(y|ies)|clears? out)\b[^.]*\bdrafts\b[^.]*\bfiles\b/);
    expect(text).toMatch(/\bretr(y|ies)\b[^.]*\b(processing|grading)\b/);
  }

  it("is still true of the page: it tidies and retries after the response", () => {
    const source = read("src/app/portal/checkin/page.tsx");
    expect(source).toMatch(/after\(\(\) => tidyMemberAudio\(/);
    expect(source).toMatch(/after\(\(\) => processCheckin\(/);
  });

  it("in the page's header comment", () => {
    expectAllWritesNamed(pageHeader());
  });

  it("in CLAUDE.md", () => {
    expectAllWritesNamed(contract());
  });

  it.each([
    "It writes one thing: the note of the assumed onboarding consent for this login.",
    "It writes only the onboarding note.",
    "Of recording_notices it writes only the onboarding note.",
  ])("rejects %j", (claim) => {
    expect(() => expectAllWritesNamed(claim)).toThrow();
  });
});
