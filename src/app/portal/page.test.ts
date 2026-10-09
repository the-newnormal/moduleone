// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCheckin } from "@/lib/checkin/process";
import { loadHeatmapData, loadRole, loadScoringConfig, type Role } from "@/lib/dashboard/load";
import { type CheckinRow, cellsFor } from "@/lib/dashboard/org";
import type { TeamNode } from "@/lib/dashboard/tree";
import type { HealthConfig } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import { text } from "@/test/dom";
import { tidyMemberAudio } from "./checkin/housekeeping";
import { describeCell } from "./dashboard/describe";
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

// --- The viewer's client: claims, the admin-grant rpc, and reads of their own rows. ---

type Result = { data: unknown; error: unknown };
type Filter = [op: string, column: string, value: unknown];
type Query = { table: string; columns: string | null; filters: Filter[] };
type Builder = PromiseLike<Result> & {
  select(columns: string): Builder;
  eq(column: string, value: unknown): Builder;
  gte(column: string, value: unknown): Builder;
  lte(column: string, value: unknown): Builder;
  order(column: string): Builder;
  overrideTypes(): Builder;
  maybeSingle(): Promise<Result>;
};

let tables: Record<string, Result>;
let queries: Query[];
let adminGrant: Result;
const getClaims = vi.fn();
const rpc = vi.fn();

// Reads only: a write (insert, update, upsert, delete) isn't there to call, and the client has no
// storage, so a page that tried either would fall over into "Couldn't load your check-in".
function from(table: string): Builder {
  const query: Query = { table, columns: null, filters: [] };
  queries.push(query);
  const settle = () => Promise.resolve(tables[table] ?? { data: null, error: { message: `unexpected table ${table}` } });
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
    gte: filter("gte"),
    lte: filter("lte"),
    order: () => builder,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  tables = {
    members: { data: { id: MEMBER, name: NAME }, error: null },
    checkins: { data: [], error: null },
    checkin_drafts: { data: null, error: null },
  };
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

// Members never see a grade. The portal's own check-in queries must ask for the week and when it
// was submitted, of the viewer's own row only, whoever is looking: RLS hands a leader their teams'
// rows and hq everyone's, grades included.
describe("the grade guard", () => {
  beforeEach(() => {
    tables.checkins = {
      data: [graded("2026-09-07"), graded(LAST_WEEK), graded(THIS_WEEK)],
      error: null,
    };
  });

  it.each(["member", "leader", "hq"] as const)("asks only whether and when, of %s's own check-ins", async (role) => {
    viewer(role);
    await render();
    const asked = checkinQueries();
    expect(asked.length).toBeGreaterThan(0);
    for (const query of asked) {
      expect(query.columns).toBe("week_start, submitted_at");
      expect(query.filters.filter(([, column]) => column === "member_id")).toEqual([["eq", "member_id", MEMBER]]);
    }
  });

  it.each(["member", "leader", "hq"] as const)("shows %s none of their own review or transcript", async (role) => {
    viewer(role);
    const html = await render();
    for (const secret of ["wellbeing", REVIEW, "burnt out", TRANSCRIPT, "exhausted"]) {
      expect(html).not.toContain(secret);
    }
  });

  it("shows a member no colour, band or category at all, and never loads the heat-map", async () => {
    const html = await render();
    for (const secret of ["Green", "Yellow", "Red", "wellbeing"]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/status-good|status-warning|status-critical/);
    expect(loadHeatmapData).not.toHaveBeenCalled();
    expect(tile("team-health")).toBeNull();
    expect(document.querySelector("[data-placeholder]")).toBeNull();
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
  it("shows a leader the teams they lead, last week beside this week, each cell opening that week", async () => {
    viewer("leader");
    const html = await render();
    const health = tile("team-health")!;
    expect(text(health)).toContain("The teams you lead");
    expect([...health.querySelectorAll("li > span:first-child")].map((el) => text(el))).toEqual([
      "IP Lab 1",
      "IP Lab 2",
    ]);

    // Each cell's accessible name is the org chart's description of that team's week.
    for (const [teamId, name] of [
      ["ip1", "IP Lab 1"],
      ["ip2", "IP Lab 2"],
    ]) {
      const cells = cellsFor(
        LEADER_CHECKINS.filter((c) => c.team_id === teamId),
        [LAST_WEEK, THIS_WEEK],
        CONFIG,
      );
      for (const cell of cells) {
        const a = link(`/portal/dashboard/${teamId}/${cell.week}`, health);
        expect(a, `${teamId} ${cell.week}`).not.toBeNull();
        const { title, lines } = describeCell(name, cell, CONFIG);
        expect(a!.getAttribute("aria-label")).toBe(`${title}. ${lines.join(". ")}`);
      }
    }
    expect(link("/portal/dashboard/ip1/2026-09-28", health)!.getAttribute("aria-label")).toBe(
      "IP Lab 1 · week of 28 Sept 2026. Green · mean score 12.0. 1 graded check-in: 1 green, 0 yellow, 0 red",
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
    expect(text(otherList)).toContain("Loose Ends");
    expect(link(`/portal/dashboard/lo/${LAST_WEEK}`, otherList)).not.toBeNull();
    expect(link(`/portal/dashboard/lo/${THIS_WEEK}`, otherList)).not.toBeNull();
    expect(text(health)).toContain("The New Normal");
    expect(text(health)).toContain("Gather");

    // The no-team check-in counts towards this week, but isn't a row here (it stays on Team health).
    expect(stat("Check-ins this week")).toBe("2");
    expect(stat("Check-ins last week")).toBe("2");
    expect(html).not.toContain("No team");
  });

  it("says so when the heat-map can't be loaded, and the rest of the page still renders", async () => {
    viewer("leader");
    vi.mocked(loadHeatmapData).mockRejectedValue(new Error("Couldn't load check-ins: timeout"));
    await render();
    const health = tile("team-health")!;
    expect(text(health.querySelector('[role="alert"]')!)).toBe("Couldn't load team health just now.");
    expect(text(link("/portal/dashboard", health)!)).toBe("Open Team health");
    expect(document.querySelector('dl[aria-label="This week in numbers"]')).toBeNull();
    expect(text(tile("checkin")!)).toContain("Record this week's check-in");
    expect(signOutButtons()).toHaveLength(1);
  });

  it("is left out for a leader whose heat-map came back as a member's", async () => {
    viewer("leader");
    vi.mocked(loadHeatmapData).mockResolvedValue(MEMBER_DATA);
    const html = await render();
    expect(tile("team-health")).toBeNull();
    expect(html).not.toMatch(/status-good|status-warning|status-critical/);
  });
});

// Tiles still to come can't pass for real data: words only, no numbers or links.
describe("the placeholders", () => {
  it.each(["leader", "hq"] as const)("say Coming soon, with no numbers and nothing to open, for %s", async (role) => {
    viewer(role);
    await render();
    const placeholders = [...document.querySelectorAll<HTMLElement>("[data-placeholder]")];
    expect(placeholders).toHaveLength(2);
    for (const section of placeholders) {
      expect(text(section)).toContain("Coming soon");
      expect(text(section)).not.toMatch(/\d/);
      expect(section.innerHTML).not.toContain("<a");
      expect(section.querySelector("a, button, input, [tabindex]")).toBeNull();
    }
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
