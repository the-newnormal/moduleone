import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadHeatmapData } from "@/lib/dashboard/load";
import type { CheckinRow, OrgNode } from "@/lib/dashboard/org";
import { PAGE_SIZE } from "@/lib/dashboard/select-all";
import type { TeamNode } from "@/lib/dashboard/tree";
import type { HealthConfig } from "@/lib/health/health";
import { HOME_WEEKS, loadTeamHealthGlance } from "./team-health";

// The portal's team-health tiles: the last six weeks as bars for the topmost boxes the viewer
// covers, coloured by the scoring settings, with last week's and this week's counts; the red spots
// for Needs a look (hq and leaders of a division or the organisation only); and who's checked in
// this week, as counts per box. Only leaders and hq see any of it; a member's rows are their own
// grades, so the loader hides them even if it's called for a member by mistake. It never throws.

vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadHeatmapData: vi.fn(),
}));

// The six weeks ending this week, oldest first.
const FIRST = "2026-08-31";
const LAST = "2026-09-28";
const THIS = "2026-10-05";
const WEEKS = [FIRST, "2026-09-07", "2026-09-14", "2026-09-21", LAST, THIS];
// The three weeks between the oldest week and last week, with nothing in them in these fixtures.
const QUIET = [null, null, null] as const;

const RULES: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const node = (id: string, name: string, kind: TeamNode["kind"], parent_id: string | null, sort_order = 0): TeamNode => ({
  id,
  name,
  kind,
  parent_id,
  sort_order,
  archived_at: null,
});

const checkin = (team_id: string | null, week_start: string, scores: [number, number, number] | null): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

// The New Normal › Gather › IP Lab › IP Lab 1; The New Normal › Culture › Atlas; Loose Ends, a domain
// not placed in the organisation yet.
const TEAMS = [
  node("org", "The New Normal", "organisation", null),
  node("ga", "Gather", "division", "org", 0),
  node("cu", "Culture", "division", "org", 1),
  node("ip", "IP Lab", "domain", "ga"),
  node("ip1", "IP Lab 1", "team", "ip"),
  node("at", "Atlas", "domain", "cu"),
  node("lo", "Loose Ends", "domain", null),
];
// Everything under the organisation: what app_led_team_ids gives whoever leads it.
const UNDER_ORG = ["org", "ga", "cu", "ip", "ip1", "at"];

const CHECKINS = [
  checkin("at", FIRST, [3, 3, 3]), // 9, yellow: the oldest bar, never in the counts
  checkin("ip1", LAST, [4, 3, 3]), // 12, green
  checkin("lo", LAST, [2, 2, 3]), // 4, red
  checkin("ip1", THIS, [2, 2, 3]), // 4, red
  checkin("at", THIS, [3, 3, 3]), // 9, yellow
  checkin("at", THIS, null), // waiting for the grader
  checkin(null, THIS, [5, 5, 5]), // made with no team: hq's to count, but not a box on the glance
];

function heatmap(over: Partial<Awaited<ReturnType<typeof loadHeatmapData>>> = {}) {
  vi.mocked(loadHeatmapData).mockResolvedValue({
    teams: TEAMS,
    checkins: CHECKINS,
    config: RULES,
    role: "hq",
    ledTeams: [],
    ...over,
  });
}

// A box as [name, ...each week's band, oldest first], for comparing colours at a glance.
const bands = (n: OrgNode | null) => n && [n.name, ...n.cells.map((c) => c.health?.band ?? null)];

// --- The viewer's Supabase client, for Who's checked in ----------------------------------------
//
// A small stand-in for PostgREST over in-memory tables: it applies the filters, order and limit the
// loader asks for and returns only the selected columns, and records every request. Only from() and
// the calls loadCheckedIn makes exist: an rpc, storage or any other method would throw, which the
// loader turns into checkedIn "failed", so every array of counts below also proves it made none.

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: unknown };
type Call = [method: string, ...args: unknown[]];
type Query = { table: string; columns: string | null; calls: Call[] };
// A request that fails: a PostgREST error, a rejected request, or a client that throws before sending.
type Fault = { error: unknown } | { rejects: unknown } | { throws: unknown };

type Builder = PromiseLike<Result> & {
  select(columns: string): Builder;
  eq(column: string, value: unknown): Builder;
  in(column: string, values: readonly unknown[]): Builder;
  not(column: string, operator: string, value: unknown): Builder;
  gt(column: string, value: unknown): Builder;
  order(column: string): Builder;
  limit(count: number): Builder;
};

let tables: Record<string, Row[]>;
// table → which request to that table (0 for the first) fails, and how.
let faults: Record<string, Record<number, Fault>>;
let queries: Query[];

function run(rows: readonly Row[], query: Query): Row[] {
  let out = [...rows];
  let limit = Infinity;
  for (const [method, ...args] of query.calls) {
    const column = args[0] as string;
    if (method === "eq") out = out.filter((r) => r[column] === args[1]);
    else if (method === "in") out = out.filter((r) => (args[1] as unknown[]).includes(r[column]));
    else if (method === "gt") out = out.filter((r) => String(r[column]) > String(args[1]));
    else if (method === "not") {
      if (args[1] !== "is" || args[2] !== null) throw new Error(`unexpected not(${args.join(", ")})`);
      out = out.filter((r) => r[column] !== null);
    } else if (method === "order") {
      out.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0));
    }
    else if (method === "limit") limit = args[0] as number;
  }
  const columns = query.columns?.split(",").map((c) => c.trim());
  return out
    .slice(0, limit)
    .map((r) => (columns && !columns.includes("*") ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
}

function from(table: string): Builder {
  const fault = faults[table]?.[queries.filter((q) => q.table === table).length];
  if (fault && "throws" in fault) throw fault.throws;
  const query: Query = { table, columns: null, calls: [] };
  queries.push(query);
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
    in: record("in"),
    not: record("not"),
    gt: record("gt"),
    order: record("order"),
    limit: record("limit"),
    then(onFulfilled, onRejected) {
      const settled: Promise<Result> =
        fault && "rejects" in fault
          ? Promise.reject(fault.rejects)
          : fault && "error" in fault
            ? Promise.resolve({ data: null, error: fault.error })
            : Promise.resolve({ data: run(tables[table] ?? [], query), error: null });
      return settled.then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const supabase = { from } as never;

const queriesOf = (table: string) => queries.filter((q) => q.table === table);
const argsOf = (query: Query, method: string) => query.calls.filter(([m]) => m === method).map(([, ...args]) => args);
const afterOf = (query: Query) => argsOf(query, "gt")[0]?.[1] ?? null;

// Who sits where now. Names and emails are there to prove they never leave the database.
const member = (id: string, team_id: string | null) => ({
  id,
  team_id,
  name: `Ada Lovelace ${id}`,
  email: `${id}@example.com`,
});
// Deliberately out of id order: the loader must ask for an order to page safely.
const MEMBERS = [
  member("m-07", "lo"),
  member("m-01", "ip1"),
  member("m-05", "cu"), // sits in the division: its leader
  member("m-02", "ip1"),
  member("m-06", "org"), // sits in the organisation: the President
  member("m-03", "ip"),
  member("m-04", "at"),
  member("m-08", null), // not placed anywhere yet
];

// Check-ins, with the grade columns RLS would also hand a leader or hq.
const graded = (id: string, member_id: string, week_start: string, team_id: string | null) => ({
  id,
  member_id,
  week_start,
  team_id,
  activity_score: 1,
  excellence_score: 1,
  morale_score: 1,
  category: "red",
  review: "Ada Lovelace is struggling",
  transcript: "…",
});
const WEEK_CHECKINS = [
  graded("c-3", "m-08", THIS, null), // unplaced: counted in no box
  graded("c-1", "m-01", THIS, "ip1"),
  graded("c-4", "m-02", LAST, "ip1"), // last week: not this week's
  graded("c-2", "m-04", THIS, "at"),
  graded("c-5", "m-07", FIRST, "lo"),
  graded("c-0", "m-99", THIS, "at"), // someone no longer placed in a team the viewer reads
];

// Anything that would hand the viewer part of a grade or the recording, or every column at once.
const GRADE_COLUMNS = /\*|score|category|review|transcript|audio|grade/;

let log: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.mocked(loadHeatmapData).mockReset();
  heatmap();
  tables = { members: MEMBERS, checkins: WEEK_CHECKINS };
  faults = {};
  queries = [];
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

async function loadOk(thisWeek = THIS) {
  const health = await loadTeamHealthGlance(supabase, thisWeek);
  if (health.status !== "ok") throw new Error(`expected ok, got ${health.status}`);
  return health;
}

async function checkedIn(thisWeek = THIS) {
  const { checkedIn } = await loadOk(thisWeek);
  if (checkedIn === "failed") throw new Error("expected counts, got failed");
  return checkedIn;
}

describe("loadTeamHealthGlance", () => {
  it("shows six weeks of bars", () => {
    expect(HOME_WEEKS).toBe(6);
  });

  it.each([
    [THIS, WEEKS],
    // Across a year end: still six whole weeks, seven days apart.
    ["2026-01-05", ["2025-12-01", "2025-12-08", "2025-12-15", "2025-12-22", "2025-12-29", "2026-01-05"]],
  ])("reads only the six weeks ending this week, oldest first, for the week of %s", async (thisWeek, weeks) => {
    const health = await loadTeamHealthGlance(supabase, thisWeek);
    expect(loadHeatmapData).toHaveBeenCalledTimes(1);
    expect(loadHeatmapData).toHaveBeenCalledWith(supabase, weeks);
    expect(health).toMatchObject({ status: "ok", weeks });
    if (health.status !== "ok") return;
    // Every box has a bar a week, oldest first.
    expect(health.glance.summary?.cells.map((c) => c.week)).toEqual(weeks);
  });

  // RLS gives a member their own graded check-ins: hide them, with nothing graded alongside, and
  // ask nothing more: no check-ins by week, no members by team.
  it.each(["member", null] as const)("is hidden for role %s, even with graded rows loaded, and reads nothing else", async (role) => {
    heatmap({ role, ledTeams: ["ga", "ip", "ip1"] });
    expect(await loadTeamHealthGlance(supabase, THIS)).toEqual({ status: "hidden" });
    expect(queries).toEqual([]);
  });

  it("says it failed, and logs only the code and status, when the heat-map can't load", async () => {
    vi.mocked(loadHeatmapData).mockRejectedValue(
      Object.assign(new Error("Couldn't load check-ins: Ada Lovelace"), { code: "PGRST000" }),
    );
    expect(await loadTeamHealthGlance(supabase, THIS)).toEqual({ status: "failed" });
    expect(log).toHaveBeenCalledWith("portal team health failed", { code: "PGRST000", status: undefined });
    expect(JSON.stringify(log.mock.calls)).not.toContain("Ada");
    expect(queries).toEqual([]);
  });

  // The whole computation is inside the guard, not just the load: a row the grader could never have
  // written fails the tile rather than the portal.
  it("says it failed when a loaded row can't be scored", async () => {
    heatmap({ checkins: [checkin("ip1", THIS, [9, 3, 3])] });
    expect(await loadTeamHealthGlance(supabase, THIS)).toEqual({ status: "failed" });
    expect(log).toHaveBeenCalledWith("portal team health failed", expect.anything());
  });

  it("gives hq the organisation, the divisions under it and the unplaced domains, with the last two weeks' counts", async () => {
    const health = await loadOk();

    expect(health).toMatchObject({ role: "hq", config: RULES, weeks: WEEKS });
    // The organisation takes in everything placed under it; Loose Ends and the no-team row don't count.
    expect(health.glance.summary?.cells).toEqual([
      { week: FIRST, health: { band: "yellow", score: 9, graded: 1, bands: { green: 0, yellow: 1, red: 0 } }, pending: 0 },
      { week: WEEKS[1], health: null, pending: 0 },
      { week: WEEKS[2], health: null, pending: 0 },
      { week: WEEKS[3], health: null, pending: 0 },
      { week: LAST, health: { band: "green", score: 12, graded: 1, bands: { green: 1, yellow: 0, red: 0 } }, pending: 0 },
      { week: THIS, health: { band: "yellow", score: 6.5, graded: 2, bands: { green: 0, yellow: 1, red: 1 } }, pending: 1 },
    ]);
    expect(bands(health.glance.summary)).toEqual(["The New Normal", "yellow", ...QUIET, "green", "yellow"]);
    expect(health.glance.rows.map(bands)).toEqual([
      ["Gather", null, ...QUIET, "green", "red"],
      ["Culture", "yellow", ...QUIET, null, "yellow"],
    ]);
    expect(health.glance.other.map(bands)).toEqual([["Loose Ends", null, ...QUIET, "red", null]]);
    expect(health.glance.more).toBe(0);
    // Counted row by row, last week and this week only (not the oldest bar's check-in): hq covers
    // every team, and check-ins made with no team.
    expect(health.tally).toEqual({
      lastWeek: { checkins: 2, pending: 0 },
      thisWeek: { checkins: 4, pending: 1 },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("counts the two weeks before this one across a year end", async () => {
    heatmap({
      checkins: [
        checkin("ip1", "2025-12-22", [2, 2, 3]),
        checkin("ip1", "2025-12-29", [4, 3, 3]),
        checkin("at", "2025-12-29", null),
        checkin("at", "2026-01-05", [3, 3, 3]),
      ],
    });
    const health = await loadOk("2026-01-05");
    expect(health.tally).toEqual({
      lastWeek: { checkins: 2, pending: 1 },
      thisWeek: { checkins: 1, pending: 0 },
    });
  });

  it("gives a leader the teams they lead, without their own check-ins elsewhere", async () => {
    heatmap({
      role: "leader",
      ledTeams: ["ip", "ip1"],
      // What RLS returns a leader of IP Lab: its check-ins, plus their own in Atlas and with no team.
      checkins: [
        checkin("ip1", FIRST, [2, 2, 3]),
        checkin("ip1", LAST, [4, 3, 3]),
        checkin("ip1", THIS, [2, 2, 3]),
        checkin("ip1", THIS, null),
        checkin("at", THIS, [5, 5, 5]),
        checkin(null, LAST, [5, 5, 5]),
      ],
    });
    const health = await loadOk();

    expect(health.role).toBe("leader");
    // One box above everything they cover: it heads the glance, with what's directly under it below.
    expect(bands(health.glance.summary)).toEqual(["IP Lab", "red", ...QUIET, "green", "red"]);
    expect(health.glance.rows.map(bands)).toEqual([["IP Lab 1", "red", ...QUIET, "green", "red"]]);
    expect(health.glance.other).toEqual([]);
    expect(health.tally).toEqual({
      lastWeek: { checkins: 1, pending: 0 },
      thisWeek: { checkins: 2, pending: 1 },
    });
  });

  // Colours come from scoring_settings: the same check-ins under other thresholds, same scores.
  it.each([
    [
      "lower",
      { green: 4, yellow: 2 },
      ["The New Normal", "green", ...QUIET, "green", "green"],
      [
        ["Gather", null, ...QUIET, "green", "green"],
        ["Culture", "green", ...QUIET, null, "green"],
      ],
      [["Loose Ends", null, ...QUIET, "green", null]],
    ],
    [
      "higher",
      { green: 13, yellow: 10 },
      ["The New Normal", "red", ...QUIET, "yellow", "red"],
      [
        ["Gather", null, ...QUIET, "yellow", "red"],
        ["Culture", "red", ...QUIET, null, "red"],
      ],
      [["Loose Ends", null, ...QUIET, "red", null]],
    ],
  ])("colours the glance by the settings' thresholds (%s)", async (_, thresholds, summary, rows, other) => {
    const config: HealthConfig = { ...RULES, thresholds };
    heatmap({ config });
    const health = await loadOk();

    expect(health.config).toBe(config);
    expect(bands(health.glance.summary)).toEqual(summary);
    expect(health.glance.rows.map(bands)).toEqual(rows);
    expect(health.glance.other.map(bands)).toEqual(other);
    expect(health.glance.summary?.cells.at(-1)?.health?.score).toBe(6.5);
  });
});

describe("loadTeamHealthGlance: Needs a look", () => {
  // For now only hq and leaders of a division or the organisation see it (needs-a-look.ts).
  it.each([
    ["a domain and its team", ["ip", "ip1"]],
    ["a team only", ["ip1"]],
    ["a domain outside the organisation", ["lo"]],
    ["nothing", []],
  ])("is null for a leader who leads %s", async (_, ledTeams) => {
    heatmap({ role: "leader", ledTeams, checkins: [checkin("ip1", THIS, [1, 1, 1]), checkin("lo", THIS, [1, 1, 1])] });
    const health = await loadOk();
    expect(health.needsALook).toBeNull();
  });

  // hq: this week's red is IP Lab 1, named under Gather › IP Lab (the organisation adds nothing);
  // last week's is Loose Ends, outside the organisation. Each week gets its own spots.
  it("gives hq this week's and last week's smallest boxes with a red check-in", async () => {
    const { needsALook } = await loadOk();
    expect(needsALook).toEqual({
      thisWeek: [
        {
          teamId: "ip1",
          name: "IP Lab 1",
          context: ["Gather", "IP Lab"],
          red: true,
          cell: expect.objectContaining({ week: THIS, health: expect.objectContaining({ band: "red" }) }),
        },
      ],
      lastWeek: [
        {
          teamId: "lo",
          name: "Loose Ends",
          context: [],
          red: true,
          cell: expect.objectContaining({ week: LAST, health: expect.objectContaining({ band: "red" }) }),
        },
      ],
    });
  });

  it("is empty, not null, for hq when nothing was red", async () => {
    heatmap({ checkins: [checkin("ip1", THIS, [5, 5, 5]), checkin("at", LAST, [3, 3, 3])] });
    expect((await loadOk()).needsALook).toEqual({ thisWeek: [], lastWeek: [] });
  });

  // A division's leader: Atlas this week is green on average with a red check-in in it, and red
  // last week. Their own red check-in in IP Lab 1 is their grade, not a box they cover: never named.
  it("gives a division's leader the boxes they cover, and never their own check-ins elsewhere", async () => {
    heatmap({
      role: "leader",
      ledTeams: ["cu", "at"],
      checkins: [
        checkin("at", THIS, [2, 2, 3]), // 4, red
        checkin("at", THIS, [5, 5, 5]), // 30, green: Atlas is green this week
        checkin("at", LAST, [2, 2, 3]),
        checkin("ip1", THIS, [1, 1, 1]), // their own, in a team they don't lead
        checkin(null, LAST, [1, 1, 1]), // their own, with no team
      ],
    });
    const { needsALook } = await loadOk();
    expect(needsALook).toEqual({
      thisWeek: [
        {
          teamId: "at",
          name: "Atlas",
          context: ["Culture"],
          red: false,
          cell: expect.objectContaining({ week: THIS, health: expect.objectContaining({ band: "green" }) }),
        },
      ],
      lastWeek: [
        {
          teamId: "at",
          name: "Atlas",
          context: ["Culture"],
          red: true,
          cell: expect.objectContaining({ week: LAST, health: expect.objectContaining({ band: "red" }) }),
        },
      ],
    });
  });

  // Leading the organisation covers every division; Loose Ends sits outside it.
  it("gives whoever leads the organisation the red boxes under it", async () => {
    heatmap({
      role: "leader",
      ledTeams: UNDER_ORG,
      checkins: CHECKINS.filter((c) => c.team_id !== null && UNDER_ORG.includes(c.team_id)),
    });
    const { needsALook } = await loadOk();
    expect(needsALook?.thisWeek.map((s) => [s.teamId, s.context, s.red])).toEqual([["ip1", ["Gather", "IP Lab"], true]]);
    expect(needsALook?.lastWeek).toEqual([]);
  });

  // Red boxes first, then by how many check-ins were red.
  it("lists red boxes before boxes with a red check-in in them", async () => {
    heatmap({
      checkins: [
        checkin("at", THIS, [2, 2, 3]),
        checkin("at", THIS, [2, 2, 3]),
        checkin("at", THIS, [5, 5, 5]), // Atlas: 2 red of 3, mean 12.67, green
        checkin("ip1", THIS, [2, 2, 3]), // IP Lab 1: 1 red of 1, red
        checkin("lo", THIS, [1, 1, 1]),
        checkin("lo", THIS, [1, 1, 1]), // Loose Ends: 2 red of 2, red
      ],
    });
    const { needsALook } = await loadOk();
    expect(needsALook?.thisWeek.map((s) => [s.name, s.red])).toEqual([
      ["Loose Ends", true],
      ["IP Lab 1", true],
      ["Atlas", false],
    ]);
  });
});

describe("loadTeamHealthGlance: Who's checked in", () => {
  it("counts, per box on the glance, the people placed in it and how many checked in this week", async () => {
    expect(await checkedIn()).toEqual([
      { teamId: "org", name: "The New Normal", people: 6, checkedIn: 2 },
      { teamId: "ga", name: "Gather", people: 3, checkedIn: 1 },
      { teamId: "cu", name: "Culture", people: 2, checkedIn: 1 },
      { teamId: "lo", name: "Loose Ends", people: 1, checkedIn: 0 },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("reads people by team and this week's check-ins by id only, with no grade columns", async () => {
    await checkedIn();
    // Only these two tables, and only these requests.
    expect(new Set(queries.map((q) => q.table))).toEqual(new Set(["members", "checkins"]));

    const [people] = queriesOf("members");
    expect(queriesOf("members")).toHaveLength(1);
    expect(people.columns).toBe("id, team_id");
    // hq: everyone placed somewhere, never the unplaced.
    expect(people.calls).toEqual([
      ["not", "team_id", "is", null],
      ["order", "id"],
      ["limit", PAGE_SIZE],
    ]);

    const [week] = queriesOf("checkins");
    expect(queriesOf("checkins")).toHaveLength(1);
    expect(week.columns).toBe("id, member_id");
    expect(week.calls).toEqual([
      ["eq", "week_start", THIS],
      ["order", "id"],
      ["limit", PAGE_SIZE],
    ]);
    for (const q of queriesOf("checkins")) expect(q.columns).not.toMatch(GRADE_COLUMNS);
  });

  it("returns counts only: never a name, email, member id or grade", async () => {
    const health = await loadOk();
    const text = JSON.stringify(health.checkedIn);
    for (const leak of ["Ada", "@example.com", "m-0", "c-", "struggling"]) expect(text).not.toContain(leak);
  });

  it("asks for this week's check-ins across a year end", async () => {
    tables.checkins = [graded("c-1", "m-01", "2026-01-05", "ip1"), graded("c-2", "m-02", "2025-12-29", "ip1")];
    const counts = await checkedIn("2026-01-05");
    expect(argsOf(queriesOf("checkins")[0], "eq")).toEqual([["week_start", "2026-01-05"]]);
    expect(counts.find((r) => r.teamId === "ga")).toEqual({ teamId: "ga", name: "Gather", people: 3, checkedIn: 1 });
  });

  it("reads a leader's people only from the teams they lead", async () => {
    heatmap({ role: "leader", ledTeams: ["ip", "ip1"], checkins: [checkin("ip1", THIS, [4, 3, 3])] });
    expect(await checkedIn()).toEqual([
      { teamId: "ip", name: "IP Lab", people: 3, checkedIn: 1 },
      { teamId: "ip1", name: "IP Lab 1", people: 2, checkedIn: 1 },
    ]);
    expect(queriesOf("members").map((q) => [q.columns, q.calls])).toEqual([
      [
        "id, team_id",
        [
          ["in", "team_id", ["ip", "ip1"]],
          ["order", "id"],
          ["limit", PAGE_SIZE],
        ],
      ],
    ]);
    expect(queriesOf("checkins").map((q) => q.columns)).toEqual(["id, member_id"]);
  });

  // A leader who leads nothing: never a members request without a team filter, which RLS would
  // answer with whatever else the viewer may read.
  it("reads no members for a leader who leads nothing", async () => {
    heatmap({ role: "leader", ledTeams: [], checkins: [] });
    expect(await checkedIn()).toEqual([]);
    expect(queriesOf("members")).toEqual([]);
  });

  it.each([
    [1, 1],
    [100, 1],
    [101, 2],
    [150, 2],
    [201, 3],
  ])("reads a leader of %i teams' people in batches of at most 100 team ids (%i requests)", async (count, requests) => {
    const ledTeams = Array.from({ length: count }, (_, i) => `t-${String(i).padStart(3, "0")}`);
    heatmap({ role: "leader", ledTeams, checkins: [] });
    await checkedIn();
    const batches = queriesOf("members").map((q) => argsOf(q, "in"));
    expect(batches).toHaveLength(requests);
    for (const filters of batches) {
      expect(filters).toHaveLength(1);
      expect(filters[0][0]).toBe("team_id");
      expect((filters[0][1] as string[]).length).toBeLessThanOrEqual(100);
    }
    // Every led team is asked for exactly once, in order.
    expect(batches.flatMap((filters) => filters[0][1] as string[])).toEqual(ledTeams);
    for (const q of queriesOf("members")) expect(argsOf(q, "not")).toEqual([]);
  });

  // 150 led teams: IP Lab in the first batch of 100, IP Lab 1 in the second. Both count.
  it("adds up a leader's people across batches, paging within each batch", async () => {
    const ledTeams = Array.from({ length: 150 }, (_, i) => `t-${String(i).padStart(3, "0")}`);
    ledTeams[0] = "ip";
    ledTeams[120] = "ip1";
    const crowd = Array.from({ length: PAGE_SIZE + 2 }, (_, i) => member(`p-${String(i).padStart(4, "0")}`, "ip"));
    tables.members = [...crowd.reverse(), member("m-01", "ip1"), member("m-02", "ip1")];
    tables.checkins = [graded("c-1", "m-01", THIS, "ip1"), graded("c-2", "p-0005", THIS, "ip")];
    heatmap({ role: "leader", ledTeams, checkins: [checkin("ip1", THIS, [4, 3, 3])] });

    expect(await checkedIn()).toEqual([
      { teamId: "ip", name: "IP Lab", people: PAGE_SIZE + 4, checkedIn: 2 },
      { teamId: "ip1", name: "IP Lab 1", people: 2, checkedIn: 1 },
    ]);
    const requests = queriesOf("members").map((q) => [(argsOf(q, "in")[0][1] as string[])[0], afterOf(q)]);
    expect(requests).toHaveLength(3);
    // The first batch takes two pages, the second page starting after the first's last id and
    // keeping the batch's team filter; the second batch fits in one.
    expect(requests).toEqual(
      expect.arrayContaining([
        ["ip", null],
        ["ip", `p-${String(PAGE_SIZE - 1).padStart(4, "0")}`],
        [ledTeams[100], null],
      ]),
    );
  });

  it("pages through more than a page of people and of check-ins, by id", async () => {
    const pad = (i: number) => String(i).padStart(4, "0");
    tables.members = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => member(`p-${pad(i)}`, "at")).reverse();
    tables.checkins = [
      ...Array.from({ length: PAGE_SIZE + 1 }, (_, i) => graded(`k-${pad(i)}`, `p-${pad(i)}`, THIS, "at")).reverse(),
      graded("k-9999", "p-1004", LAST, "at"),
    ];
    expect(await checkedIn()).toEqual([
      { teamId: "org", name: "The New Normal", people: PAGE_SIZE + 5, checkedIn: PAGE_SIZE + 1 },
      { teamId: "ga", name: "Gather", people: 0, checkedIn: 0 },
      { teamId: "cu", name: "Culture", people: PAGE_SIZE + 5, checkedIn: PAGE_SIZE + 1 },
      { teamId: "lo", name: "Loose Ends", people: 0, checkedIn: 0 },
    ]);
    expect(queriesOf("members").map(afterOf)).toEqual([null, `p-${pad(PAGE_SIZE - 1)}`]);
    expect(queriesOf("checkins").map(afterOf)).toEqual([null, `k-${pad(PAGE_SIZE - 1)}`]);
    // Every page keeps its filters and stays ids only.
    for (const q of queriesOf("members")) expect(argsOf(q, "not")).toEqual([["team_id", "is", null]]);
    for (const q of queriesOf("checkins")) {
      expect(q.columns).toBe("id, member_id");
      expect(argsOf(q, "eq")).toEqual([["week_start", THIS]]);
    }
  });

  // A failure here leaves the rest of team health standing, logged with its code and status only.
  const PGRST = { code: "PGRST301", message: "JWT expired for Ada Lovelace", details: "Ada", hint: "" };
  const big = () => {
    const pad = (i: number) => String(i).padStart(4, "0");
    tables.members = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => member(`p-${pad(i)}`, "at"));
    tables.checkins = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => graded(`k-${pad(i)}`, `p-${pad(i)}`, THIS, "at"));
  };
  it.each([
    ["people can't be read", "members", 0, { error: PGRST }, () => {}],
    ["this week's check-ins can't be read", "checkins", 0, { error: PGRST }, () => {}],
    ["a later page of people can't be read", "members", 1, { error: PGRST }, big],
    ["a later page of check-ins can't be read", "checkins", 1, { error: PGRST }, big],
    ["the people request is rejected", "members", 0, { rejects: Object.assign(new Error("Ada"), { status: 503 }) }, () => {}],
    ["the client throws on check-ins", "checkins", 0, { throws: Object.assign(new Error("Ada"), { code: "X1" }) }, () => {}],
  ] as const)("says Who's checked in failed, and keeps the rest, when %s", async (_, table, request, fault, setup) => {
    setup();
    faults[table] = { [request]: fault };
    const health = await loadOk();

    expect(health.checkedIn).toBe("failed");
    // The rest of team health is unaffected.
    expect(health.role).toBe("hq");
    expect(health.weeks).toEqual(WEEKS);
    expect(bands(health.glance.summary)).toEqual(["The New Normal", "yellow", ...QUIET, "green", "yellow"]);
    expect(health.tally).toEqual({ lastWeek: { checkins: 2, pending: 0 }, thisWeek: { checkins: 4, pending: 1 } });
    expect(health.needsALook?.thisWeek.map((s) => s.teamId)).toEqual(["ip1"]);

    expect(log).toHaveBeenCalledTimes(1);
    const [message, detail] = log.mock.calls[0];
    expect(message).toBe("portal who's checked in failed");
    expect(Object.keys(detail as object).sort()).toEqual(["code", "status"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Ada");
  });

  it("logs the failing request's code and status", async () => {
    faults.checkins = { 0: { error: PGRST } };
    await loadOk();
    expect(log).toHaveBeenCalledWith("portal who's checked in failed", { code: "PGRST301", status: undefined });
  });

  it("fails for a leader when any batch of their people fails", async () => {
    const ledTeams = Array.from({ length: 150 }, (_, i) => `t-${String(i).padStart(3, "0")}`);
    heatmap({ role: "leader", ledTeams, checkins: [] });
    faults.members = { 1: { error: PGRST } };
    const health = await loadOk();
    expect(health.checkedIn).toBe("failed");
    expect(log).toHaveBeenCalledWith("portal who's checked in failed", { code: "PGRST301", status: undefined });
  });
});
