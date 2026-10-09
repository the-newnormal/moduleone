import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { HOME_CHECKIN_COLUMNS, HOME_DRAFT_COLUMNS, loadMyWeek, STRIP_WEEKS, weekStrip } from "./my-week";

// The portal's own check-in tile and week strip. Members never see their grade, so the portal may
// ask only whether and when they checked in, and every query is pinned to the viewer's own member
// row: RLS would also hand a leader their teams' check-ins and hq everyone's.

const AUTH_USER = "a0000000-0000-4000-8000-000000000001";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const NAME = "Mei Tan";
// STRIP_WEEKS Mondays, oldest first, ending with this week (as the page builds them).
const WEEKS = [
  "2026-08-17",
  "2026-08-24",
  "2026-08-31",
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
];
const THIS_WEEK = "2026-10-05";

// Anything that would hand a member part of their grade or the recording, or every column at once.
const GRADE_COLUMNS = /\*|score|category|review|transcript|audio|grade/;

type Result = { data: unknown; error: unknown };
// How a table's request ends: rows or a PostgREST error, a rejected request, or a client that
// throws before sending it.
type Outcome = Result | { rejects: unknown } | { throws: unknown };
type Call = [method: string, ...args: unknown[]];
type Query = { table: string; columns: string | null; calls: Call[]; awaited: "list" | "single" | null };

type Builder = PromiseLike<Result> & {
  select(columns: string): Builder;
  eq(column: string, value: unknown): Builder;
  gte(column: string, value: unknown): Builder;
  lte(column: string, value: unknown): Builder;
  order(column: string): Builder;
  overrideTypes(): Builder;
  maybeSingle(): Promise<Result>;
};

let outcomes: Record<string, Outcome>;
let queries: Query[];

// Only from() exists, and only the calls loadMyWeek makes: an rpc, storage or any other filter would
// throw, which loadMyWeek turns into "unavailable", so every "ok" below also proves it made none.
function from(table: string): Builder {
  const outcome = outcomes[table] ?? { data: null, error: null };
  if ("throws" in outcome) throw outcome.throws;
  const query: Query = { table, columns: null, calls: [], awaited: null };
  queries.push(query);
  const settle = (): Promise<Result> =>
    "rejects" in outcome ? Promise.reject(outcome.rejects) : Promise.resolve(outcome);
  const record =
    (method: string) =>
    (...args: unknown[]): Builder => {
      query.calls.push([method, ...args]);
      return builder;
    };
  const builder: Builder = {
    select(columns) {
      query.columns = columns;
      return builder;
    },
    eq: record("eq"),
    gte: record("gte"),
    lte: record("lte"),
    order: record("order"),
    overrideTypes: record("overrideTypes"),
    maybeSingle() {
      query.awaited = "single";
      return settle();
    },
    then(onFulfilled, onRejected) {
      query.awaited = "list";
      return settle().then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const supabase = { from } as never;
const load = () => loadMyWeek(supabase, AUTH_USER, WEEKS);
const queryOf = (table: string) => queries.find((q) => q.table === table);

const ok = (data: unknown): Result => ({ data, error: null });
const checkin = (week_start: string, submitted_at: string | null = `${week_start}T06:15:00Z`) => ({
  week_start,
  submitted_at,
});
const DRAFT = { duration_ms: 95_000, recorded_at: "2026-10-06T02:30:00Z", created_at: "2026-10-06T02:31:00Z" };

// A PostgREST failure as it arrives: message and details can carry row values (names, emails).
const DB_ERROR = {
  code: "57014",
  message: `canceling statement due to statement timeout for ${NAME}`,
  details: "Failing row contains (mei@example.com)",
  hint: null,
  status: 503,
};

let log: MockInstance<typeof console.error>;

beforeEach(() => {
  outcomes = {
    members: ok({ id: MEMBER, name: NAME }),
    checkins: ok([]),
    checkin_drafts: ok(null),
  };
  queries = [];
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what loadMyWeek asks for", () => {
  it("reads only the week and submission time of check-ins, and only the timing of the draft", () => {
    expect(HOME_CHECKIN_COLUMNS).toBe("week_start, submitted_at");
    expect(HOME_DRAFT_COLUMNS).toBe("duration_ms, recorded_at, created_at");
    expect(HOME_CHECKIN_COLUMNS).not.toMatch(GRADE_COLUMNS);
    expect(HOME_DRAFT_COLUMNS).not.toMatch(GRADE_COLUMNS);
  });

  it("asks with those columns, for the signed-in user's member row and nobody else's check-ins", async () => {
    outcomes.checkins = ok([checkin("2026-09-28"), checkin(THIS_WEEK)]);
    outcomes.checkin_drafts = ok(DRAFT);
    expect((await load()).state).toBe("ok");

    const members = queryOf("members");
    expect(members?.columns).toBe("id, name");
    expect(members?.columns).not.toMatch(GRADE_COLUMNS);
    expect(members?.calls).toEqual([["eq", "auth_user_id", AUTH_USER]]);
    expect(members?.awaited).toBe("single");

    const checkins = queryOf("checkins");
    expect(checkins?.columns).toBe("week_start, submitted_at");
    expect(checkins?.columns).not.toMatch(GRADE_COLUMNS);
    expect(checkins?.calls).toHaveLength(5);
    expect(checkins?.calls).toEqual(
      expect.arrayContaining([
        ["eq", "member_id", MEMBER],
        ["gte", "week_start", WEEKS[0]],
        ["lte", "week_start", THIS_WEEK],
        ["order", "week_start"],
        ["overrideTypes"],
      ]),
    );
    expect(checkins?.awaited).toBe("list");

    const draft = queryOf("checkin_drafts");
    expect(draft?.columns).toBe("duration_ms, recorded_at, created_at");
    expect(draft?.columns).not.toMatch(GRADE_COLUMNS);
    expect(draft?.calls).toHaveLength(2);
    expect(draft?.calls).toEqual(
      expect.arrayContaining([
        ["eq", "member_id", MEMBER],
        ["eq", "week_start", THIS_WEEK],
      ]),
    );
    expect(draft?.awaited).toBe("single");
  });

  it("never reads the recording notice: the portal only shows status, it doesn't start a recording", async () => {
    outcomes.recording_notices = ok({ member_id: MEMBER });
    await load();
    expect(queries.map((q) => q.table)).toEqual(["members", "checkins", "checkin_drafts"]);
  });

  it("stops at the member row when there isn't one", async () => {
    outcomes.members = ok(null);
    await expect(load()).resolves.toEqual({ state: "no_member" });
    expect(queries.map((q) => q.table)).toEqual(["members"]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("this week's state", () => {
  it("is record when there's neither a check-in nor a draft", async () => {
    await expect(load()).resolves.toEqual({ state: "ok", name: NAME, thisWeek: { state: "record" }, checkedIn: [] });
    expect(log).not.toHaveBeenCalled();
  });

  it("is draft, with when it was recorded and how long it is, when only a draft exists", async () => {
    outcomes.checkins = ok([checkin("2026-09-21"), checkin("2026-09-28")]);
    outcomes.checkin_drafts = ok(DRAFT);
    await expect(load()).resolves.toEqual({
      state: "ok",
      name: NAME,
      thisWeek: { state: "draft", recordedAt: "2026-10-06T02:30:00Z", durationMs: 95_000 },
      checkedIn: ["2026-09-21", "2026-09-28"],
    });
  });

  it("falls back to when the draft was saved when its recording time is unknown ('-infinity')", async () => {
    // Drafts saved before 0004 have recorded_at = '-infinity', which isn't a date to show.
    outcomes.checkin_drafts = ok({ duration_ms: null, recorded_at: "-infinity", created_at: "2026-10-06T02:31:00Z" });
    const week = await load();
    expect(week).toMatchObject({
      state: "ok",
      thisWeek: { state: "draft", recordedAt: "2026-10-06T02:31:00Z", durationMs: null },
    });
  });

  it("is submitted once this week's check-in exists, even if a draft is still around", async () => {
    // Submitting removes the draft, but a leftover one must not make a done week look unfinished.
    outcomes.checkins = ok([checkin("2026-09-28"), checkin(THIS_WEEK, "2026-10-07T06:15:00Z")]);
    outcomes.checkin_drafts = ok(DRAFT);
    await expect(load()).resolves.toEqual({
      state: "ok",
      name: NAME,
      thisWeek: { state: "submitted", submittedAt: "2026-10-07T06:15:00Z" },
      checkedIn: ["2026-09-28", THIS_WEEK],
    });
  });

  it("is submitted, without a time, for a check-in whose submission time is missing", async () => {
    outcomes.checkins = ok([checkin(THIS_WEEK, null)]);
    await expect(load()).resolves.toMatchObject({ thisWeek: { state: "submitted", submittedAt: null } });
  });

  it("treats no rows (data null) like an empty list", async () => {
    outcomes.checkins = ok(null);
    await expect(load()).resolves.toEqual({ state: "ok", name: NAME, thisWeek: { state: "record" }, checkedIn: [] });
  });
});

describe("when it can't be read", () => {
  it("is unavailable, without a name, if the member row fails", async () => {
    outcomes.members = { data: null, error: DB_ERROR };
    await expect(load()).resolves.toEqual({ state: "unavailable", name: null });
    expect(queries.map((q) => q.table)).toEqual(["members"]);
  });

  it.each(["checkins", "checkin_drafts"])("keeps the name if %s fails", async (table) => {
    outcomes[table] = { data: null, error: DB_ERROR };
    await expect(load()).resolves.toEqual({ state: "unavailable", name: NAME });
  });

  it.each([
    ["the member request is rejected", "members", { rejects: new TypeError("fetch failed") }, null],
    ["the client throws on members", "members", { throws: new Error("no client") }, null],
    ["the check-ins request is rejected", "checkins", { rejects: new TypeError("fetch failed") }, NAME],
    ["the client throws on check-ins", "checkins", { throws: new Error("no client") }, NAME],
    ["the draft request is rejected", "checkin_drafts", { rejects: "socket hang up" }, NAME],
  ] as const)("is unavailable, never an error page, when %s", async (_, table, outcome, name) => {
    outcomes[table] = outcome;
    await expect(load()).resolves.toEqual({ state: "unavailable", name });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("logs the code and status only, never the message or details, which can hold names and emails", async () => {
    outcomes.checkins = { data: null, error: DB_ERROR };
    await load();
    expect(log).toHaveBeenCalledWith("portal check-in status failed", { code: "57014", status: 503 });

    outcomes.checkins = { rejects: new Error(`fetch failed for ${NAME} <mei@example.com>`) };
    await load();
    expect(log).toHaveBeenLastCalledWith("portal check-in status failed", { code: undefined, status: undefined });

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("Mei");
    expect(logged).not.toContain("example.com");
    expect(logged).not.toContain("Failing row");
  });
});

describe("weekStrip", () => {
  const PAST = WEEKS.slice(0, -1);

  it("marks each past week done or not, oldest first", () => {
    const strip = weekStrip(WEEKS, ["2026-08-24", "2026-09-28"], "record");
    expect(strip.cells.map((c) => c.week)).toEqual(WEEKS);
    expect(strip.cells.slice(0, -1).map((c) => c.mark)).toEqual([
      "none",
      "done",
      "none",
      "none",
      "none",
      "none",
      "done",
    ]);
  });

  it.each([
    ["record", "open"],
    ["draft", "draft"],
    ["submitted", "done"],
  ] as const)("marks this week by its state: %s is %s", (state, mark) => {
    const strip = weekStrip(WEEKS, state === "submitted" ? [THIS_WEEK] : [], state);
    expect(strip.cells.at(-1)).toEqual({ week: THIS_WEEK, mark });
  });

  it("counts this week only once it's submitted", () => {
    expect(weekStrip(WEEKS, PAST, "record").count).toBe(STRIP_WEEKS - 1);
    expect(weekStrip(WEEKS, PAST, "draft").count).toBe(STRIP_WEEKS - 1);
    expect(weekStrip(WEEKS, [...PAST, THIS_WEEK], "submitted").count).toBe(STRIP_WEEKS);
    expect(weekStrip(WEEKS, [], "record").count).toBe(0);
  });

  it("ignores check-ins from weeks outside the strip", () => {
    const strip = weekStrip(WEEKS, ["2026-08-10", "2026-10-12", "2026-09-07"], "record");
    expect(strip.cells.map((c) => c.week)).toEqual(WEEKS);
    expect(strip.cells.filter((c) => c.mark === "done").map((c) => c.week)).toEqual(["2026-09-07"]);
    expect(strip.count).toBe(1);
  });
});
