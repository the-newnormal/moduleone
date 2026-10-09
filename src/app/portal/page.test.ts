// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCheckin } from "@/lib/checkin/process";
import { loadHeatmapData, loadRole, loadScoringConfig, type Role } from "@/lib/dashboard/load";
import { type CheckinRow, cellsFor, type HeatmapCell } from "@/lib/dashboard/org";
import type { TeamNode } from "@/lib/dashboard/tree";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import { text } from "@/test/dom";
import { tidyMemberAudio } from "./checkin/housekeeping";
import { BANDS } from "./dashboard/band";
import { cellWord, describeCell } from "./dashboard/describe";
import PortalPage from "./page";

// The portal's dashboard as each viewer gets it. Members never see a grade: the page may ask only
// whether and when they checked in, and only leaders and hq get the heat-map. It's a page to look
// at: rendering it never processes, tidies or writes anything, and never uses the service role.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  // SaveWatch and Sign out hold a router; rendering them needs only the hook.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadRole: vi.fn(),
  loadHeatmapData: vi.fn(),
  loadScoringConfig: vi.fn(),
}));
// What the check-in page does on render, which the portal must not: mocked so a call would show.
vi.mock("@/lib/checkin/process", () => ({ processCheckin: vi.fn() }));
vi.mock("./checkin/housekeeping", () => ({ tidyMemberAudio: vi.fn() }));
vi.mock("./actions", () => ({ signOut: vi.fn() }));

const NOW = new Date("2026-10-08T04:00:00Z"); // Thursday noon in Singapore
const THIS_WEEK = "2026-10-05";
const LAST_WEEK = "2026-09-28";
const AUTH_USER = "a0000000-0000-4000-8000-000000000001";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const NAME = "Mei Tan";

const CONFIG: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

// The viewer's own check-in as the database holds it, grade and all. RLS lets a member read it, and
// hands leaders and hq their teams' too; the fake returns it whatever the query asks for, so only
// what the page selects and shows keeps the grade off the portal.
const REVIEW = "Sounds burnt out; raise with the leader.";
const TRANSCRIPT = "Honestly this week was rough and I am exhausted.";
const graded = (week_start: string, submitted_at: string | null = `${week_start}T06:15:00Z`) => ({
  id: `c0000000-0000-4000-8000-${week_start.replaceAll("-", "").padStart(12, "0")}`,
  member_id: MEMBER,
  team_id: "ip1",
  week_start,
  submitted_at,
  graded_at: submitted_at,
  activity_score: 4,
  excellence_score: 2,
  morale_score: 1,
  category: "wellbeing",
  rubric_review: REVIEW,
  transcript: TRANSCRIPT,
  audio_path: `${MEMBER}/${week_start}.webm`,
});

// --- The viewer's client: claims, the admin-grant rpc, and reads. ---

type Result = { data: unknown; error: unknown };
type Row = Record<string, unknown>;
type Filter = [op: string, column: string, value: unknown];
type Query = { table: string; columns: string | null; filters: Filter[]; limit: number | null };
type Builder = PromiseLike<Result> & {
  select(columns: string): Builder;
  eq(column: string, value: unknown): Builder;
  in(column: string, values: readonly unknown[]): Builder;
  not(column: string, operator: string, value: unknown): Builder;
  gt(column: string, value: unknown): Builder;
  gte(column: string, value: unknown): Builder;
  lte(column: string, value: unknown): Builder;
  order(column: string): Builder;
  limit(count: number): Builder;
  overrideTypes(): Builder;
  maybeSingle(): Promise<Result>;
};

// The viewer's own reads (their member row, their check-ins, their draft), by table.
let tables: Record<string, Result>;
// Who's checked in reads people by team ("id, team_id") and this week's check-ins ("id, member_id").
// The fake answers those two from these lists, applying the filters the page asks for (so a page
// that dropped one would count the wrong people), but hands back whole rows, names and grades
// included, as RLS would: only what the page selects and shows keeps them off the portal.
let people: Row[];
let teamCheckins: Row[];
// Requests ("table: columns") that come back with a PostgREST error.
let failing: Set<string>;
let queries: Query[];
let adminGrant: Result;
const getClaims = vi.fn();
const rpc = vi.fn();

const PEOPLE_BY_TEAM = "members: id, team_id";
const WHO_CHECKED_IN = "checkins: id, member_id";

function matching(rows: readonly Row[], query: Query): Row[] {
  let out = [...rows];
  for (const [op, column, value] of query.filters) {
    if (op === "eq") out = out.filter((r) => r[column] === value);
    else if (op === "in") out = out.filter((r) => (value as unknown[]).includes(r[column]));
    else if (op === "gt") out = out.filter((r) => String(r[column]) > String(value));
    else if (op === "not" && JSON.stringify(value) === JSON.stringify(["is", null]))
      out = out.filter((r) => r[column] !== null);
    else throw new Error(`unexpected filter ${op} ${column} on ${query.table}`);
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return query.limit === null ? out : out.slice(0, query.limit);
}

// Reads only: a write (insert, update, upsert, delete) isn't there to call, and the client has no
// storage, so a page that tried either would fall over into "Couldn't load your check-in".
function from(table: string): Builder {
  const query: Query = { table, columns: null, filters: [], limit: null };
  queries.push(query);
  const settle = (): Promise<Result> => {
    const key = `${table}: ${query.columns}`;
    if (failing.has(key)) return Promise.resolve({ data: null, error: { code: "PGRST000", message: "down" } });
    if (key === PEOPLE_BY_TEAM) return Promise.resolve({ data: matching(people, query), error: null });
    if (key === WHO_CHECKED_IN) return Promise.resolve({ data: matching(teamCheckins, query), error: null });
    return Promise.resolve(tables[table] ?? { data: null, error: { message: `unexpected table ${table}` } });
  };
  const filter =
    (op: string) =>
    (column: string, value: unknown): Builder => {
      query.filters.push([op, column, value]);
      return builder;
    };
  const builder: Builder = {
    select(columns) {
      query.columns = columns;
      return builder;
    },
    eq: filter("eq"),
    in: filter("in"),
    not: (column, operator, value) => filter("not")(column, [operator, value]),
    gt: filter("gt"),
    gte: filter("gte"),
    lte: filter("lte"),
    order: () => builder,
    limit(count) {
      query.limit = count;
      return builder;
    },
    overrideTypes: () => builder,
    maybeSingle: settle,
    then: (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected),
  };
  return builder;
}

// --- What loadHeatmapData returns for leaders and hq (the heat-map's own tests cover loading it). ---

const team = (id: string, name: string, kind: TeamNode["kind"], parent_id: string | null, sort_order = 0): TeamNode => ({
  id,
  name,
  kind,
  parent_id,
  sort_order,
  archived_at: null,
});
const scored = (team_id: string | null, week_start: string, scores: [number, number, number] | null): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

// A leader of IP Lab 1 and IP Lab 2, who sees the division and domain above them uncoloured, and
// who checked in this week while still placed in Atlas, a team they don't lead.
const LEADER_CHECKINS = [
  scored("ip1", LAST_WEEK, [4, 3, 3]), // 12, green
  scored("ip1", THIS_WEEK, [2, 2, 3]), // 4, red
  scored("ip2", THIS_WEEK, null), // waiting for the grader
  scored("at", THIS_WEEK, [5, 5, 5]), // the leader's own, in a team they don't lead
];
const LEADER_DATA = {
  teams: [
    team("ga", "Gather", "division", null),
    team("ip", "IP Lab", "domain", "ga"),
    team("ip1", "IP Lab 1", "team", "ip", 0),
    team("ip2", "IP Lab 2", "team", "ip", 1),
    team("at", "Atlas", "team", null),
  ],
  checkins: LEADER_CHECKINS,
  config: CONFIG,
  role: "leader" as const,
  ledTeams: ["ip1", "ip2"],
};

// The New Normal › Gather › IP Lab › IP Lab 1, and Loose Ends, a domain not placed in it yet.
const HQ_DATA = {
  teams: [
    team("org", "The New Normal", "organisation", null),
    team("ga", "Gather", "division", "org"),
    team("ip", "IP Lab", "domain", "ga"),
    team("ip1", "IP Lab 1", "team", "ip"),
    team("lo", "Loose Ends", "domain", null),
  ],
  checkins: [
    scored("ip1", LAST_WEEK, [4, 3, 3]),
    scored("lo", LAST_WEEK, [3, 3, 3]),
    scored("ip1", THIS_WEEK, [2, 2, 3]),
    scored(null, THIS_WEEK, [5, 5, 5]), // made with no team
  ],
  config: CONFIG,
  role: "hq" as const,
  ledTeams: [],
};

// The heat-map as RLS would hand it to a member: their own graded rows. The page must never ask.
const MEMBER_DATA = {
  teams: [team("ip1", "IP Lab 1", "team", null)],
  checkins: [scored("ip1", THIS_WEEK, [4, 2, 1])],
  config: CONFIG,
  role: "member" as const,
  ledTeams: [],
};

// The six weeks Team health shows on the portal, oldest first, ending with this week.
const SIX_WEEKS = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", LAST_WEEK, THIS_WEEK];

// For Needs a look: The New Normal › Gather › IP Lab › IP Lab 1 and IP Lab 2, and The New Normal ›
// Culture › Atlas.
const ORG_TEAMS = [
  team("org", "The New Normal", "organisation", null),
  team("ga", "Gather", "division", "org", 0),
  team("cu", "Culture", "division", "org", 1),
  team("ip", "IP Lab", "domain", "ga"),
  team("ip1", "IP Lab 1", "team", "ip", 0),
  team("ip2", "IP Lab 2", "team", "ip", 1),
  team("at", "Atlas", "team", "cu"),
];
// This week: IP Lab 1 red with both its check-ins red; Atlas green, but with someone red in it; IP
// Lab 2 green all through. Three weeks ago Atlas was red, which is too long ago to list.
const RED_THIS_WEEK = [
  scored("at", "2026-09-14", [1, 1, 1]), // 0.6, red
  scored("ip1", THIS_WEEK, [2, 2, 3]), // 4, red
  scored("ip1", THIS_WEEK, [2, 1, 3]), // 2, red: IP Lab 1's mean is 3.0, red
  scored("ip2", THIS_WEEK, [4, 3, 3]), // 12, green
  scored("at", THIS_WEEK, [5, 5, 5]), // 30, green
  scored("at", THIS_WEEK, [2, 2, 3]), // 4, red: Atlas's mean is 17.0, green
];
// Nothing red yet this week; last week IP Lab 1 was.
const RED_LAST_WEEK = [
  scored("at", "2026-09-14", [1, 1, 1]), // 0.6, red, too long ago
  scored("ip1", LAST_WEEK, [2, 2, 3]), // 4, red
  scored("ip1", LAST_WEEK, [2, 1, 3]), // 2, red
  scored("ip2", THIS_WEEK, [4, 3, 3]), // 12, green
  scored("at", THIS_WEEK, null), // waiting for the grader
];
// What app_led_team_ids gives whoever leads each node: it and everything under it.
const LEADS = {
  organisation: ["org", "ga", "cu", "ip", "ip1", "ip2", "at"],
  division: ["ga", "ip", "ip1", "ip2"],
  domain: ["ip", "ip1", "ip2"],
  team: ["ip1"],
};
// The heat-map as RLS hands it to hq, or to a leader of `led` (the check-ins made in teams they
// lead, and their own elsewhere: the viewer sits in Atlas).
function orgData(checkins: CheckinRow[], led: keyof typeof LEADS | "hq") {
  const covered = led === "hq" ? null : new Set(LEADS[led]);
  return {
    teams: ORG_TEAMS,
    checkins: covered ? checkins.filter((c) => c.team_id === null || covered.has(c.team_id)) : checkins,
    config: CONFIG,
    role: led === "hq" ? ("hq" as const) : ("leader" as const),
    ledTeams: covered ? [...covered] : [],
  };
}

// People as they're placed now, for Who's checked in, with the names RLS would also hand back.
const person = (n: number, team_id: string | null, name: string) => ({
  id: `9e000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  team_id,
  name,
  auth_user_id: null,
});
// Someone's check-in as RLS hands it to leaders and hq: grade, review and transcript included.
const checkinBy = (member: { id: string }, week_start: string) => ({
  ...graded(week_start),
  id: `c1000000-0000-4000-8000-${member.id.slice(-4)}${week_start.replaceAll("-", "")}`,
  member_id: member.id,
});

function viewer(role: Role | null, { admin = false }: { admin?: boolean } = {}) {
  vi.mocked(loadRole).mockResolvedValue(role);
  vi.mocked(loadHeatmapData).mockResolvedValue(
    role === "leader" ? LEADER_DATA : role === "hq" ? HQ_DATA : MEMBER_DATA,
  );
  adminGrant = { data: admin, error: null };
}

async function render() {
  const html = renderToStaticMarkup(await PortalPage());
  document.body.innerHTML = html;
  return html;
}

// A tile by its id (each is a section named by its heading).
const tile = (id: string) => document.querySelector<HTMLElement>(`section[aria-labelledby="${id}-title"]`);
const signOutButtons = () => [...document.querySelectorAll("button")].filter((b) => text(b) === "Sign out");
const link = (href: string, within: ParentNode = document) => within.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
// A Stat's number, by its label.
function stat(label: string) {
  const dt = [...document.querySelectorAll("dt")].find((el) => text(el) === label);
  return dt?.nextElementSibling ? text(dt.nextElementSibling) : null;
}
// The strip's headline: the number, then what it counts.
const weekCount = () =>
  [...(tile("weeks")?.querySelectorAll("p > span") ?? [])].map((el) => text(el)).join(" ");
const checkinQueries = () => queries.filter((q) => q.table === "checkins");
const asked = (key: string) => queries.filter((q) => `${q.table}: ${q.columns}` === key);

// Team health's rows (each with a link for this week so far), as [name, the box].
const glanceRows = (within: ParentNode) =>
  [...within.querySelectorAll("li")].filter((li) => [...li.children].some((el) => el.matches("a[aria-label]")));
const rowName = (li: Element) => text(li.firstElementChild!);
// A row's bars (one link per week, for the pointer) and its link for this week so far.
const barsOf = (li: Element) => li.querySelector('span[aria-hidden="true"]')!;
const thisWeekOf = (li: Element) => [...li.children].find((el) => el.matches("a[aria-label]")) as HTMLAnchorElement;
// What this week's link says of a box's six weeks: first what it shows (so it can be named by
// voice), then what the org chart says of the week and the five before it.
function readOut(name: string, cells: HeatmapCell[]) {
  const cell = cells[cells.length - 1];
  const { title, lines } = describeCell(name, cell, CONFIG);
  const shown = cell.health
    ? `${BANDS[cell.health.band].label} ${formatScore(cell.health.score, CONFIG)}`
    : cell.pending > 0
      ? "waiting"
      : "no check-ins";
  const earlier = cells.slice(0, -1).map(cellWord).join(", ");
  return `${shown}, ${title}. ${lines.join(". ")}. The 5 weeks before, oldest first: ${earlier}.`;
}
// Who's checked in, as [box, count] per row.
const checkedInRows = () =>
  [...tile("checked-in")!.querySelectorAll("li")].map((li) => {
    const [name, count] = [...li.querySelector("div")!.children];
    return [text(name), text(count)];
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  tables = {
    members: { data: { id: MEMBER, name: NAME }, error: null },
    checkins: { data: [], error: null },
    checkin_drafts: { data: null, error: null },
  };
  people = [];
  teamCheckins = [];
  failing = new Set();
  queries = [];
  getClaims.mockReset().mockResolvedValue({
    data: { claims: { sub: AUTH_USER, email: "mei@example.com" } },
    error: null,
  });
  rpc.mockReset().mockImplementation(async (fn: string, args: unknown) =>
    fn === "app_has_grant" && JSON.stringify(args) === JSON.stringify({ requested: "admin" })
      ? adminGrant
      : { data: null, error: { message: `unexpected rpc ${fn}` } },
  );
  vi.mocked(createClient).mockReset().mockResolvedValue({ auth: { getClaims }, rpc, from } as never);
  vi.mocked(loadScoringConfig).mockReset().mockResolvedValue(CONFIG);
  vi.mocked(loadRole).mockReset();
  vi.mocked(loadHeatmapData).mockReset();
  vi.mocked(after).mockReset();
  vi.mocked(processCheckin).mockReset();
  vi.mocked(tidyMemberAudio).mockReset();
  vi.mocked(redirect).mockClear();
  viewer("member");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("/portal", () => {
  it("sends a signed-out visitor to sign in, then back here, before reading anything", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(PortalPage()).rejects.toThrow("NEXT_REDIRECT /login?next=/portal");
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/login?next=/portal");
    expect(queries).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(loadRole).not.toHaveBeenCalled();
  });
});

describe("the check-in tile", () => {
  it("offers to record when there's nothing yet this week", async () => {
    await render();
    const hero = tile("checkin")!;
    expect(text(hero)).toContain("Not started");
    expect(text(hero)).toContain("Record this week's check-in");
    expect(text(hero)).toContain("Submit by Sunday 11 October, 11:59 pm Singapore time.");
    expect(text(link("/portal/checkin", hero)!)).toBe("Start check-in");
    expect(text(document.querySelector("h1")!)).toBe(`Hello, ${NAME}`);
  });

  it("says a recording is waiting, with when and how long, without playing it", async () => {
    tables.checkin_drafts = {
      data: { duration_ms: 192_000, recorded_at: "2026-10-08T03:30:00Z", created_at: "2026-10-08T03:45:00Z" },
      error: null,
    };
    const html = await render();
    const hero = tile("checkin")!;
    expect(text(hero)).toContain("Not submitted");
    expect(text(hero)).toContain("Your recording is waiting");
    expect(text(hero)).toContain("Recorded Thursday 8 October at 11:30 am · 3 min 12 s. Only you can hear it");
    expect(text(link("/portal/checkin", hero)!)).toBe("Listen back and submit");
    // Playback is the check-in page's: the portal signs no URL and shows no player.
    expect(html).not.toContain("<audio");
    expect(text(document.querySelector('ol[aria-label^="Your last"] li:last-child')!)).toBe(
      "Week of 5 Oct (this week): recorded, not submitted",
    );

    const draft = queries.find((q) => q.table === "checkin_drafts");
    expect(draft?.columns).toBe("duration_ms, recorded_at, created_at");
    expect(draft?.filters).toEqual([
      ["eq", "member_id", MEMBER],
      ["eq", "week_start", THIS_WEEK],
    ]);
  });

  it("says when this week's check-in went in, and when the next one opens", async () => {
    tables.checkins = { data: [graded(THIS_WEEK, "2026-10-07T06:15:00Z")], error: null };
    await render();
    const hero = tile("checkin")!;
    expect(text(hero)).toContain("Done for this week");
    expect(text(hero)).toContain("Submitted on Wednesday 7 October at 2:15 pm. Thanks, see you next week.");
    expect(text(hero)).toContain("Next check-in opens Monday 12 October.");
    expect(text(link("/portal/checkin", hero)!)).toBe("Open check-in");
  });

  it("covers a check-in made before submitting existed", async () => {
    tables.checkins = { data: [graded(THIS_WEEK, null)], error: null };
    await render();
    const hero = tile("checkin")!;
    expect(text(hero)).toContain("Your check-in for this week is in. Thanks, see you next week.");
    expect(text(hero)).not.toContain("Submitted on");
    expect(text(hero)).toContain("Next check-in opens Monday 12 October.");
  });

  it("tells a login with no member row to ask HQ, and offers nothing that needs one", async () => {
    tables.members = { data: null, error: null };
    await render();
    expect(text(tile("checkin")!.querySelector('[role="status"]')!)).toBe("Your account isn't set up yet. Ask HQ.");
    expect(link("/portal/checkin", tile("checkin")!)).toBeNull();
    expect(text(document.querySelector("h1")!)).toBe("Portal");
    expect(tile("weeks")).toBeNull();
    expect(tile("questions")).toBeNull();
    expect(queries.map((q) => q.table)).toEqual(["members"]);
    expect(signOutButtons()).toHaveLength(1);
  });

  it("says so when the check-in can't be loaded, and still links to it", async () => {
    tables.checkins = { data: null, error: { code: "PGRST000", message: "down" } };
    await render();
    const hero = tile("checkin")!;
    expect(text(hero.querySelector('[role="alert"]')!)).toBe(
      "Couldn't load your check-in. Refresh the page to try again.",
    );
    expect(text(link("/portal/checkin", hero)!)).toBe("Open your check-in");
    expect(text(hero)).not.toContain("Start check-in");
    expect(text(tile("weeks")!)).toContain("Couldn't load your past weeks.");
    // The name was read before the failure, so the greeting keeps it.
    expect(text(document.querySelector("h1")!)).toBe(`Hello, ${NAME}`);
    expect(signOutButtons()).toHaveLength(1);
  });
});

describe("the week strip", () => {
  it("marks each of the last 8 weeks checked in or not, oldest first, this week last", async () => {
    tables.checkins = { data: [graded("2026-09-07"), graded(LAST_WEEK)], error: null };
    await render();
    const strip = document.querySelector('ol[aria-label="Your last 8 weeks, oldest first"]')!;
    expect([...strip.querySelectorAll("li")].map((li) => text(li))).toEqual([
      "Week of 17 Aug: no check-in",
      "Week of 24 Aug: no check-in",
      "Week of 31 Aug: no check-in",
      "Week of 7 Sept: checked in",
      "Week of 14 Sept: no check-in",
      "Week of 21 Sept: no check-in",
      "Week of 28 Sept: checked in",
      "Week of 5 Oct (this week): not yet",
    ]);
    expect(weekCount()).toBe("2 check-ins in the last 8 weeks");
    expect(checkinQueries()[0].filters).toEqual(
      expect.arrayContaining([
        ["gte", "week_start", "2026-08-17"],
        ["lte", "week_start", THIS_WEEK],
      ]),
    );
  });
});

// Members never see a grade. The portal's own check-in query must ask for the week and when it was
// submitted, of the viewer's own row only, whoever is looking: RLS hands a leader their teams' rows
// and hq everyone's, grades included. The only other check-in query, Who's checked in's, is for
// leaders and hq and asks this week's rows for whose they are, nothing more. (Team health's grades
// come through loadHeatmapData, for leaders and hq only; its own tests cover what it selects.)
describe("the grade guard", () => {
  // Any column that holds or gives away a grade, or every column at once.
  const GRADE_COLUMNS = /\*|score|category|review|transcript|audio|graded/;

  beforeEach(() => {
    tables.checkins = {
      data: [graded("2026-09-07"), graded(LAST_WEEK), graded(THIS_WEEK)],
      error: null,
    };
    const colleague = person(1, "ip1", "Ana Lim");
    people = [colleague, { ...person(0, "at", NAME), id: MEMBER }];
    teamCheckins = [checkinBy(colleague, THIS_WEEK), checkinBy({ id: MEMBER }, THIS_WEEK)];
  });

  it.each(["member", "leader", "hq"] as const)(
    "asks only whether and when of %s's own check-ins, and at most whose this week's are",
    async (role) => {
      viewer(role);
      await render();
      const all = checkinQueries();
      // Every check-in query names its columns (none falls back to all of them), and none is a grade.
      for (const query of all) {
        expect(query.columns).not.toBeNull();
        expect(query.columns).not.toMatch(GRADE_COLUMNS);
      }

      const own = all.filter((q) => q.columns === "week_start, submitted_at");
      expect(own).toHaveLength(1);
      expect(own[0].filters.filter(([, column]) => column === "member_id")).toEqual([["eq", "member_id", MEMBER]]);

      const others = all.filter((q) => !own.includes(q));
      for (const query of others) {
        expect(query.columns).toBe("id, member_id");
        expect(query.filters.filter(([, column]) => column === "week_start")).toEqual([
          ["eq", "week_start", THIS_WEEK],
        ]);
      }
      expect(others.length > 0).toBe(role !== "member");
    },
  );

  it.each([
    ["a member", false],
    ["a member with the admin grant", true],
  ] as const)("has %s ask nothing about anyone else: no one's check-ins, no team's people", async (_, admin) => {
    viewer("member", { admin });
    await render();
    expect(asked(WHO_CHECKED_IN)).toEqual([]);
    expect(asked(PEOPLE_BY_TEAM)).toEqual([]);
    // The only member row read is their own, by their login.
    expect(queries.filter((q) => q.table === "members")).toEqual([
      expect.objectContaining({ columns: "id, name", filters: [["eq", "auth_user_id", AUTH_USER]] }),
    ]);
  });

  it.each(["member", "leader", "hq"] as const)(
    "shows %s none of their own or anyone's review, transcript or name",
    async (role) => {
      viewer(role);
      const html = await render();
      for (const secret of ["wellbeing", REVIEW, "burnt out", TRANSCRIPT, "exhausted", "Ana Lim"]) {
        expect(html).not.toContain(secret);
      }
    },
  );

  it("shows a member no colour, band, score or category at all, and never loads the heat-map", async () => {
    const html = await render();
    for (const secret of ["Green", "Yellow", "Red", "wellbeing", "mean score", "graded check-in"]) {
      expect(html).not.toContain(secret);
    }
    // No score as the page writes one (one or two decimals), anywhere in what they read.
    expect(text()).not.toMatch(/\d\.\d/);
    expect(html).not.toMatch(/status-good|status-warning|status-critical/);
    expect(loadHeatmapData).not.toHaveBeenCalled();
    for (const id of ["team-health", "needs-a-look", "checked-in"]) expect(tile(id)).toBeNull();
    expect(document.querySelector('dl[aria-label="This week in numbers"]')).toBeNull();
    // The strip still says they checked in.
    expect(weekCount()).toBe("3 check-ins in the last 8 weeks");
  });
});

// The check-in page processes submitted check-ins and tidies old drafts as it renders; the portal
// only reads, as the viewer.
describe("no side effects", () => {
  it.each([
    ["member", false],
    ["leader", false],
    ["hq", true],
  ] as const)("rendering for %s (admin: %s) schedules, processes and tidies nothing", async (role, admin) => {
    viewer(role, { admin });
    // What would set the check-in page to work: a submitted check-in still waiting for the grader,
    // beside a draft.
    tables.checkins = {
      data: [{ ...graded(THIS_WEEK), graded_at: null, activity_score: null, excellence_score: null, morale_score: null }],
      error: null,
    };
    tables.checkin_drafts = {
      data: { duration_ms: 1000, recorded_at: NOW.toISOString(), created_at: NOW.toISOString() },
      error: null,
    };
    await render();
    expect(text(tile("checkin")!)).toContain("Done for this week"); // read, not fallen over
    expect(after).not.toHaveBeenCalled();
    expect(processCheckin).not.toHaveBeenCalled();
    expect(tidyMemberAudio).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls).toEqual([["app_has_grant", { requested: "admin" }]]);
    expect(new Set(queries.map((q) => q.table))).toEqual(new Set(["members", "checkins", "checkin_drafts"]));
  });
});

// The same, read from the source: none of the portal's own code imports what the check-in page
// uses to write (the service-role client, processing, housekeeping) or Next's after(); nor does
// anything the page loads at runtime (type-only imports are erased, so they're skipped there).
describe("the portal's imports", () => {
  // From the file's directory: under happy-dom, URL resolves relative paths against localhost.
  const ROOT = join(import.meta.dirname, "../../..");
  const FORBIDDEN = ["src/app/portal/checkin/housekeeping", "src/lib/checkin/process", "src/lib/supabase/admin"];

  const sourcesIn = (dir: string) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => posix.join(dir, file.split(sep).join("/")));
  const SCANNED = ["src/app/portal/page.tsx", ...sourcesIn("src/app/portal/_home"), ...sourcesIn("src/lib/portal")];

  // Every import and re-export statement (static or dynamic) in a file: its specifier, resolved to
  // a repo path without extension when it's one of ours, and whether it's type-only.
  type Import = { spec: string; path: string | null; typeOnly: boolean; names: string[] };
  function importsOf(file: string): Import[] {
    const source = readFileSync(join(ROOT, file), "utf8");
    const found: Import[] = [];
    for (const m of source.matchAll(/^(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm)) {
      // The names it imports, as exported: `{ type A, b as c }` → ["A", "b"].
      const braces = /\{([^}]*)\}/.exec(m[2])?.[1] ?? "";
      const names = braces.split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]);
      found.push({ spec: m[3], path: null, typeOnly: /^\s*type\b/.test(m[2]), names });
    }
    for (const m of source.matchAll(/^import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm)) {
      found.push({ spec: m[1] ?? m[2], path: null, typeOnly: false, names: [] });
    }
    for (const i of found) {
      if (i.spec.startsWith("@/")) i.path = `src/${i.spec.slice(2)}`;
      else if (i.spec.startsWith(".")) i.path = posix.normalize(posix.join(posix.dirname(file), i.spec));
      i.path = i.path?.replace(/\.(ts|tsx)$/, "").replace(/\/index$/, "") ?? null;
    }
    return found;
  }

  function offences(file: string, imports: Import[]): string[] {
    return imports.flatMap((i) => [
      ...(i.path && FORBIDDEN.includes(i.path) ? [`${file} imports ${i.spec}`] : []),
      ...(i.spec === "next/server" && i.names.some((n) => n === "after" || n === "unstable_after")
        ? [`${file} imports after from next/server`]
        : []),
    ]);
  }

  it("finds the portal's files", () => {
    expect(SCANNED).toEqual(
      expect.arrayContaining([
        "src/app/portal/page.tsx",
        "src/app/portal/_home/checkin-tile.tsx",
        "src/app/portal/_home/team-health-tile.tsx",
        "src/lib/portal/access.ts",
        "src/lib/portal/my-week.ts",
        "src/lib/portal/team-health.ts",
      ]),
    );
    expect(SCANNED.some((file) => file.includes(".test."))).toBe(false);
    // The scan sees real imports, and catches these where they are: the check-in page imports all
    // but the service-role client.
    expect(importsOf("src/app/portal/page.tsx").map((i) => i.path)).toContain("src/lib/portal/my-week");
    const checkinPage = "src/app/portal/checkin/page.tsx";
    expect(offences(checkinPage, importsOf(checkinPage))).toEqual([
      `${checkinPage} imports after from next/server`,
      `${checkinPage} imports @/lib/checkin/process`,
      `${checkinPage} imports ./housekeeping`,
    ]);
  });

  it.each(SCANNED)("%s imports none of them", (file) => {
    expect(offences(file, importsOf(file))).toEqual([]);
  });

  it("nor does anything the page loads", () => {
    const resolve = (path: string) =>
      [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`].find(
        (candidate) => existsSync(join(ROOT, candidate)) && statSync(join(ROOT, candidate)).isFile(),
      );
    const seen = new Set<string>();
    const found: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const imports = importsOf(file).filter((i) => !i.typeOnly);
      found.push(...offences(file, imports));
      for (const { path } of imports) {
        const next = path && resolve(path);
        if (next) walk(next);
      }
    };
    walk("src/app/portal/page.tsx");
    // It walked past the portal's own files, into what they use.
    expect(seen).toContain("src/app/portal/sign-out-button.tsx");
    expect(seen).toContain("src/lib/dashboard/load.ts");
    expect(found).toEqual([]);
  });
});

describe("Team health", () => {
  // Every row: six bars, oldest first, hidden from screen readers and drawn only (on the portal they
  // open nothing: too small to tap; earlier weeks open from the org chart), each with its tooltip;
  // then this week so far, the one link, which reads the five weeks before out.
  function expectRow(li: Element, teamId: string, name: string, cells: HeatmapCell[]) {
    expect(cells.map((c) => c.week)).toEqual(SIX_WEEKS);
    expect(rowName(li)).toBe(name);
    expect(barsOf(li).querySelector("a")).toBeNull();
    const bars = [...barsOf(li).querySelectorAll("[data-tip-title]")];
    expect(bars).toHaveLength(SIX_WEEKS.length);
    bars.forEach((a, i) => {
      expect(a.getAttribute("data-tip-title")).toBe(describeCell(name, cells[i], CONFIG).title);
      expect(a.getAttribute("data-tip-body")).toBe(describeCell(name, cells[i], CONFIG).lines.join("\n"));
    });
    const now = thisWeekOf(li);
    expect(now.getAttribute("href")).toBe(`/portal/dashboard/${teamId}/${THIS_WEEK}`);
    expect(now.getAttribute("aria-label")).toBe(readOut(name, cells));
  }

  it("shows a leader the teams they lead, six weeks of bars beside this week so far, each to its week", async () => {
    viewer("leader");
    const html = await render();
    const health = tile("team-health")!;
    expect(text(health)).toContain("The teams you lead");
    expect(text(health)).toContain("Last 6 weeks");
    expect(text(health)).toContain("This week so far · 5 Oct");
    expect(text(health)).toContain("the last 6 weeks, oldest first");
    const rows = glanceRows(health);
    expect(rows.map(rowName)).toEqual(["IP Lab 1", "IP Lab 2"]);

    // Each box is the org chart's: its bars and its accessible name describe its weeks as there.
    for (const [i, [teamId, name]] of [
      ["ip1", "IP Lab 1"],
      ["ip2", "IP Lab 2"],
    ].entries()) {
      const cells = cellsFor(
        LEADER_CHECKINS.filter((c) => c.team_id === teamId),
        SIX_WEEKS,
        CONFIG,
      );
      expectRow(rows[i], teamId, name, cells);
    }
    expect(thisWeekOf(rows[0]).getAttribute("aria-label")).toBe(
      "Red 4.0, IP Lab 1 · week of 5 Oct 2026. Red · mean score 4.0. 1 graded check-in: 0 green, 0 yellow, 1 red." +
        " The 5 weeks before, oldest first: no check-ins, no check-ins, no check-ins, no check-ins, green.",
    );
    expect(thisWeekOf(rows[1]).getAttribute("aria-label")).toBe(
      "waiting, IP Lab 2 · week of 5 Oct 2026. Nothing graded yet. 1 waiting for the grader." +
        " The 5 weeks before, oldest first: no check-ins, no check-ins, no check-ins, no check-ins, no check-ins.",
    );

    // Their own check-in in Atlas is their grade, not a team's: it stays off the glance and the
    // counts.
    expect(html).not.toContain("Your check-ins ·");
    expect(html).not.toContain("Atlas");
    expect(stat("Check-ins this week")).toBe("2");
    expect(stat("Check-ins last week")).toBe("1");
    expect(stat("Waiting for the grader")).toBe("1");
    expect(text(link("/portal/dashboard", health)!)).toBe("Open Team health");
  });

  it("shows hq the organisation, its divisions, and unplaced domains under Other; counts check-ins with no team", async () => {
    viewer("hq");
    const html = await render();
    const health = tile("team-health")!;
    expect(text(health)).toContain("Every team");
    const other = [...health.querySelectorAll("p")].find((p) => text(p) === "Other");
    expect(other).toBeDefined();
    const otherList = other!.nextElementSibling!;
    expect(glanceRows(health).map(rowName)).toEqual(["The New Normal", "Gather", "Loose Ends"]);
    expect(glanceRows(otherList).map(rowName)).toEqual(["Loose Ends"]);

    const cells = (ids: string[]) =>
      cellsFor(HQ_DATA.checkins.filter((c) => c.team_id !== null && ids.includes(c.team_id)), SIX_WEEKS, CONFIG);
    const [organisation, gather, looseEnds] = glanceRows(health);
    expectRow(organisation, "org", "The New Normal", cells(["org", "ga", "ip", "ip1"]));
    expectRow(gather, "ga", "Gather", cells(["ga", "ip", "ip1"]));
    expectRow(looseEnds, "lo", "Loose Ends", cells(["lo"]));
    expect(link(`/portal/dashboard/lo/${THIS_WEEK}`, otherList)).not.toBeNull();
    expect(thisWeekOf(looseEnds).getAttribute("aria-label")).toBe(
      "no check-ins, Loose Ends · week of 5 Oct 2026. No check-ins." +
        " The 5 weeks before, oldest first: no check-ins, no check-ins, no check-ins, no check-ins, yellow.",
    );

    // The no-team check-in counts towards this week, but isn't a row here (it stays on Team health).
    expect(stat("Check-ins this week")).toBe("2");
    expect(stat("Check-ins last week")).toBe("2");
    expect(html).not.toContain("No team");
    expect(link("/portal/dashboard/none/2026-10-05")).toBeNull();
  });

  it("says so when the heat-map can't be loaded, and the rest of the page still renders", async () => {
    viewer("hq");
    vi.mocked(loadHeatmapData).mockRejectedValue(new Error("Couldn't load check-ins: timeout"));
    await render();
    const health = tile("team-health")!;
    expect(text(health.querySelector('[role="alert"]')!)).toBe("Couldn't load team health just now.");
    expect(text(link("/portal/dashboard", health)!)).toBe("Open Team health");
    expect(document.querySelector('dl[aria-label="This week in numbers"]')).toBeNull();
    // Nothing else that comes from it, nor anything asked for it.
    expect(tile("needs-a-look")).toBeNull();
    expect(tile("checked-in")).toBeNull();
    expect(asked(WHO_CHECKED_IN)).toEqual([]);
    expect(asked(PEOPLE_BY_TEAM)).toEqual([]);
    expect(text(tile("checkin")!)).toContain("Record this week's check-in");
    expect(signOutButtons()).toHaveLength(1);
  });

  it("is left out, with all that goes with it, for a leader whose heat-map came back as a member's", async () => {
    viewer("leader");
    vi.mocked(loadHeatmapData).mockResolvedValue(MEMBER_DATA);
    const html = await render();
    for (const id of ["team-health", "needs-a-look", "checked-in"]) expect(tile(id)).toBeNull();
    expect(document.querySelector('dl[aria-label="This week in numbers"]')).toBeNull();
    expect(html).not.toMatch(/status-good|status-warning|status-critical/);
    expect(asked(WHO_CHECKED_IN)).toEqual([]);
    expect(asked(PEOPLE_BY_TEAM)).toEqual([]);
  });
});

// For hq and leaders of a division or the organisation (src/lib/dashboard/needs-a-look.ts): the
// smallest boxes with a red check-in this week, red boxes first, each opening that week.
describe("Needs a look", () => {
  const spots = () => [...tile("needs-a-look")!.querySelectorAll("li")];
  // A spot as it reads: where it sits, its name, and how many were red.
  const spotText = (li: Element) =>
    [...li.querySelector("a > span")!.children].map((el) => text(el));
  // What the link shows, in screen order, then the week and its counts.
  const IP_LAB_1 =
    "Gather › IP Lab › IP Lab 1, 2 of 2 graded check-ins red, Red 3.0. Week of 5 Oct 2026. 2 graded check-ins: 0 green, 0 yellow, 2 red";

  it("shows hq every box with someone red this week, the red ones first, named within the organisation", async () => {
    viewer("hq");
    vi.mocked(loadHeatmapData).mockResolvedValue(orgData(RED_THIS_WEEK, "hq"));
    await render();
    const tileEl = tile("needs-a-look")!;
    expect(text(tileEl)).not.toContain("Nothing red");
    const [ipLab1, atlas, ...rest] = spots();
    expect(rest).toEqual([]);

    expect(spotText(ipLab1)).toEqual(["Gather › IP Lab", "IP Lab 1", "2 of 2 graded check-ins red"]);
    const toIpLab1 = ipLab1.querySelector("a")!;
    expect(toIpLab1.getAttribute("href")).toBe(`/portal/dashboard/ip1/${THIS_WEEK}`);
    expect(toIpLab1.getAttribute("aria-label")).toBe(IP_LAB_1);
    const ip1Cell = cellsFor(RED_THIS_WEEK.filter((c) => c.team_id === "ip1"), [THIS_WEEK], CONFIG)[0];
    const { lines } = describeCell("IP Lab 1", ip1Cell, CONFIG);
    expect(toIpLab1.getAttribute("aria-label")).toContain(lines.slice(1).join(". "));

    // Atlas is green, but someone in it was red.
    expect(spotText(atlas)).toEqual(["Culture", "Atlas", "1 of 2 graded check-ins red"]);
    expect(atlas.querySelector("a")!.getAttribute("href")).toBe(`/portal/dashboard/at/${THIS_WEEK}`);
    expect(atlas.querySelector("a")!.getAttribute("aria-label")).toBe(
      "Culture › Atlas, 1 of 2 graded check-ins red, Green 17.0. Week of 5 Oct 2026. 2 graded check-ins: 1 green, 0 yellow, 1 red",
    );
    // Only this week's: Atlas's red three weeks ago isn't listed.
    expect(tileEl.querySelectorAll("a")).toHaveLength(2);
  });

  it.each(["division", "organisation"] as const)(
    "shows a leader of the %s the boxes they lead with someone red this week",
    async (led) => {
      viewer("leader");
      vi.mocked(loadHeatmapData).mockResolvedValue(orgData(RED_THIS_WEEK, led));
      await render();
      const names = spots().map((li) => spotText(li)[1]);
      expect(names).toEqual(led === "division" ? ["IP Lab 1"] : ["IP Lab 1", "Atlas"]);
      const ipLab1 = spots()[0];
      expect(spotText(ipLab1)).toEqual(["Gather › IP Lab", "IP Lab 1", "2 of 2 graded check-ins red"]);
      expect(ipLab1.querySelector("a")!.getAttribute("href")).toBe(`/portal/dashboard/ip1/${THIS_WEEK}`);
      expect(ipLab1.querySelector("a")!.getAttribute("aria-label")).toBe(IP_LAB_1);
    },
  );

  it("says nothing is red so far this week when nothing was last week either", async () => {
    viewer("hq");
    vi.mocked(loadHeatmapData).mockResolvedValue(
      orgData(
        [
          scored("at", "2026-09-14", [1, 1, 1]), // red, too long ago
          scored("ip1", LAST_WEEK, [4, 3, 3]), // 12, green
          scored("at", THIS_WEEK, [3, 3, 3]), // 9, yellow
        ],
        "hq",
      ),
    );
    await render();
    const tileEl = tile("needs-a-look")!;
    expect(text(tileEl.querySelector("p")!)).toBe("Nothing red so far this week.");
    expect(text(tileEl)).not.toContain("Last week");
    expect(tileEl.querySelector("li, a")).toBeNull();
  });

  it("shows last week's when nothing is red so far this week, each opening last week", async () => {
    viewer("hq");
    vi.mocked(loadHeatmapData).mockResolvedValue(orgData(RED_LAST_WEEK, "hq"));
    await render();
    const tileEl = tile("needs-a-look")!;
    expect(text(tileEl.querySelector("p")!)).toBe("Nothing red so far this week. Last week:");
    const [ipLab1, ...rest] = spots();
    expect(rest).toEqual([]);
    expect(spotText(ipLab1)).toEqual(["Gather › IP Lab", "IP Lab 1", "2 of 2 graded check-ins red"]);
    const to = ipLab1.querySelector("a")!;
    expect(to.getAttribute("href")).toBe(`/portal/dashboard/ip1/${LAST_WEEK}`);
    expect(to.getAttribute("aria-label")).toBe(
      "Gather › IP Lab › IP Lab 1, 2 of 2 graded check-ins red, Red 3.0. Week of 28 Sept 2026. 2 graded check-ins: 0 green, 0 yellow, 2 red",
    );
    expect(tileEl.querySelectorAll("a")).toHaveLength(1);
  });

  it.each([
    ["a domain", "domain"],
    ["a team", "team"],
  ] as const)("isn't there for a leader of %s, even with someone red in it", async (_, led) => {
    viewer("leader");
    vi.mocked(loadHeatmapData).mockResolvedValue(orgData(RED_THIS_WEEK, led));
    const html = await render();
    // Team health still shows them the red.
    expect(glanceRows(tile("team-health")!).length).toBeGreaterThan(0);
    expect(tile("needs-a-look")).toBeNull();
    expect(html).not.toContain("Needs a look");
  });

  it("isn't there for a team leader on the fixture's own heat-map either, nor for a member", async () => {
    viewer("leader");
    let html = await render();
    expect(tile("team-health")).not.toBeNull();
    expect(tile("needs-a-look")).toBeNull();
    expect(html).not.toContain("Needs a look");

    viewer("member");
    html = await render();
    expect(tile("needs-a-look")).toBeNull();
    expect(html).not.toContain("Needs a look");
  });
});

// For leaders and hq: how many of the people in each box on Team health have checked in this week.
// Counts only, never who.
describe("Who's checked in", () => {
  const spots = () => [...(tile("needs-a-look")?.querySelectorAll("li") ?? [])];

  it("shows a leader, for each team they lead, how many of the people placed there have checked in", async () => {
    viewer("leader");
    const [ana, ben, chi] = [person(1, "ip1", "Ana Lim"), person(2, "ip1", "Ben Ong"), person(3, "ip2", "Chi Ng")];
    const me = { ...person(0, "at", NAME), id: MEMBER };
    people = [ana, ben, chi, me];
    teamCheckins = [
      checkinBy(ana, THIS_WEEK),
      checkinBy(chi, THIS_WEEK),
      checkinBy(me, THIS_WEEK),
      checkinBy(ben, LAST_WEEK), // last week's: not this week's count
    ];
    const html = await render();
    expect(text(tile("checked-in")!)).toContain("This week so far. Counts only, never names.");
    expect(checkedInRows()).toEqual([
      ["IP Lab 1", "1 of 2 checked in"],
      ["IP Lab 2", "1 of 1 checked in"],
    ]);
    for (const name of ["Ana Lim", "Ben Ong", "Chi Ng"]) expect(html).not.toContain(name);
    expect(tile("checked-in")!.querySelector("a")).toBeNull();

    // People by the teams they lead; check-ins by this week, whose only.
    const [byTeam, ...more] = asked(PEOPLE_BY_TEAM);
    expect(more).toEqual([]);
    expect(byTeam.filters).toEqual([["in", "team_id", ["ip1", "ip2"]]]);
    expect(asked(WHO_CHECKED_IN).map((q) => q.filters)).toEqual([[["eq", "week_start", THIS_WEEK]]]);
  });

  it("shows hq the organisation, its divisions and Other, with No one here yet for an empty box", async () => {
    viewer("hq");
    const [ana, ben, unplaced] = [person(1, "ip1", "Ana Lim"), person(2, "ga", "Ben Ong"), person(3, null, "Chi Ng")];
    const me = { ...person(0, "org", NAME), id: MEMBER };
    people = [ana, ben, unplaced, me];
    teamCheckins = [checkinBy(ana, THIS_WEEK), checkinBy(me, THIS_WEEK), checkinBy(unplaced, THIS_WEEK)];
    await render();
    expect(checkedInRows()).toEqual([
      ["The New Normal", "2 of 3 checked in"],
      ["Gather", "1 of 2 checked in"],
      ["Loose Ends", "No one here yet"],
    ]);
    // Everyone placed somewhere, read by team, never someone with no team.
    expect(asked(PEOPLE_BY_TEAM).map((q) => q.filters)).toEqual([[["not", "team_id", ["is", null]]]]);
  });

  it.each([
    ["the people", PEOPLE_BY_TEAM],
    ["this week's check-ins", WHO_CHECKED_IN],
  ])("says so when %s can't be loaded, and the rest of team health stands", async (_, key) => {
    viewer("hq");
    vi.mocked(loadHeatmapData).mockResolvedValue(orgData(RED_THIS_WEEK, "hq"));
    people = [person(1, "ip1", "Ana Lim")];
    failing.add(key);
    await render();
    const checkedIn = tile("checked-in")!;
    expect(text(checkedIn.querySelector('[role="alert"]')!)).toBe("Couldn't load who's checked in just now.");
    expect(checkedIn.querySelector("li")).toBeNull();
    expect(text(checkedIn)).not.toMatch(/\d/);
    expect(glanceRows(tile("team-health")!).map(rowName)).toEqual(["The New Normal", "Gather", "Culture"]);
    expect(spots().length).toBe(2);
    expect(stat("Check-ins this week")).toBe("5");
  });

  it.each([false, true])("is never shown to a member (admin: %s)", async (admin) => {
    viewer("member", { admin });
    people = [person(1, "ip1", "Ana Lim")];
    teamCheckins = [checkinBy(people[0] as { id: string }, THIS_WEEK)];
    const html = await render();
    expect(tile("checked-in")).toBeNull();
    expect(html).not.toMatch(/Who(&#x27;|')s checked in|people checked in|No one here yet/);
    expect(asked(PEOPLE_BY_TEAM)).toEqual([]);
    expect(asked(WHO_CHECKED_IN)).toEqual([]);
  });

});

describe("Sign out", () => {
  it.each([
    ["a member", "member", false],
    ["a leader", "leader", false],
    ["hq", "hq", false],
    ["an admin who is a member", "member", true],
    ["someone whose role can't be read", null, false],
  ] as const)("is one button for %s", async (_, role, admin) => {
    viewer(role, { admin });
    const html = await render();
    expect(signOutButtons()).toHaveLength(1);
    expect(html.split("Sign out")).toHaveLength(2);
  });
});
