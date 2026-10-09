import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHeatmapData, loadLedTeams, loadRole, loadScoringConfig, loadTeamWeek } from "@/lib/dashboard/load";
import type { TeamNode } from "@/lib/dashboard/tree";
import { weeksEndingAt } from "@/lib/dashboard/weeks";
import { loadMyWeek, type MyWeek } from "@/lib/portal/my-week";
import { createClient } from "@/lib/supabase/server";
import PortalPage from "../page";
import TeamWeekPage from "./[teamId]/[week]/page";
import DashboardPage from "./page";
import TrendPage from "./trend/page";

// Members never see their grade: the heat-map and its drill-in show scores, colours and the
// leaders-only review, so a member is sent to their check-in, and the portal doesn't offer them.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadHeatmapData: vi.fn(),
  loadLedTeams: vi.fn(),
  loadRole: vi.fn(),
  loadScoringConfig: vi.fn(),
  loadTeamWeek: vi.fn(),
}));
vi.mock("../actions", () => ({ signOut: vi.fn() }));
// The viewer's own week (my-week.test.ts checks it reads no grade); here, a member who hasn't
// started this week's check-in.
vi.mock("@/lib/portal/my-week", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/my-week")>()),
  loadMyWeek: vi.fn(),
}));

const CONFIG = { weights: {}, thresholds: { green: 3, yellow: 2 } } as never;
const MEMBER: MyWeek = { state: "ok", name: "Mia Tan", thisWeek: { state: "record" }, checkedIn: [] };

// Thursday 8 October 2026, noon in Singapore: the week of Monday 5 October.
const NOW = new Date("2026-10-08T04:00:00Z");
const THIS_WEEK = "2026-10-05";

// app_has_grant('admin') for the signed-in user.
const rpc = vi.fn();

// The reads the page makes itself with the viewer's client, beyond the loaders mocked above: Who's
// checked in reads people by team and this week's check-in ids. Every read comes back empty (people
// and check-ins nobody has added yet); a table nothing here should read answers with an error.
type Filter = [op: string, ...args: unknown[]];
type Query = { table: string; columns: string | null; filters: Filter[] };
type Builder = PromiseLike<{ data: unknown; error: unknown }> & {
  select(columns: string): Builder;
  eq(column: string, value: unknown): Builder;
  in(column: string, values: unknown[]): Builder;
  not(column: string, op: string, value: unknown): Builder;
  gt(column: string, value: unknown): Builder;
  order(column: string): Builder;
  limit(count: number): Builder;
};
let queries: Query[];
function from(table: string): Builder {
  const query: Query = { table, columns: null, filters: [] };
  queries.push(query);
  const result =
    table === "members" || table === "checkins"
      ? { data: [], error: null }
      : { data: null, error: { message: `unexpected table ${table}` } };
  const filter =
    (op: string) =>
    (...args: unknown[]): Builder => {
      query.filters.push([op, ...args]);
      return builder;
    };
  const builder: Builder = {
    select(columns) {
      query.columns = columns;
      return builder;
    },
    eq: filter("eq"),
    in: filter("in"),
    not: filter("not"),
    gt: filter("gt"),
    order: () => builder,
    limit: () => builder,
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}
const queriesOf = (table: string) => queries.filter((q) => q.table === table);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  queries = [];
  rpc.mockReset().mockResolvedValue({ data: false, error: null });
  vi.mocked(createClient).mockResolvedValue({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1", email: "m@example.com" } } }) },
    rpc,
    from,
  } as never);
  vi.mocked(loadHeatmapData).mockResolvedValue({
    teams: [],
    checkins: [],
    config: CONFIG,
    role: "member",
    ledTeams: [],
  } as never);
  vi.mocked(loadLedTeams).mockResolvedValue([]);
  vi.mocked(loadScoringConfig).mockResolvedValue(CONFIG);
  vi.mocked(loadTeamWeek).mockResolvedValue({ checkins: [], teamName: "Team", context: [] } as never);
  vi.mocked(loadRole).mockResolvedValue("member");
  vi.mocked(loadMyWeek).mockResolvedValue(MEMBER);
});

afterEach(() => {
  vi.useRealTimers();
});

// What loadHeatmapData read, for a viewer whose role check agrees with it.
const heatmapFor = (role: "member" | "leader" | "hq", { teams = [] as TeamNode[], ledTeams = [] as string[] } = {}) =>
  vi.mocked(loadHeatmapData).mockResolvedValue({ teams, checkins: [], config: CONFIG, role, ledTeams } as never);

const team = (id: string, name: string, kind: TeamNode["kind"], parent_id: string | null): TeamNode => ({
  id,
  name,
  kind,
  parent_id,
  sort_order: 0,
  archived_at: null,
});

// The portal's own reads of check-ins hold no grade: Who's checked in asks for ids only, for this
// week. (The viewer's own week is mocked here; my-week.test.ts and page.test.ts check its reads.)
function expectNoGradeRead() {
  for (const q of queriesOf("checkins")) {
    expect(q.columns).toBe("id, member_id");
    expect(q.filters).toEqual([["eq", "week_start", THIS_WEEK]]);
  }
}

// The tiles' headings (Tile gives each section's heading `${id}-title`).
const CHECKED_IN_TILE = 'id="checked-in-title"';
const NEEDS_A_LOOK_TILE = 'id="needs-a-look-title"';

// The portal nav's links, in order.
function nav(html: string): { label: string; href: string }[] {
  const items = /<nav aria-label="Portal"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...items.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, label]) => ({ label, href }));
}
const PORTAL = { label: "Portal", href: "/portal" };
const CHECKIN = { label: "Check-in", href: "/portal/checkin" };
const TEAM_HEALTH = { label: "Team health", href: "/portal/dashboard" };
const ADMIN = { label: "Admin", href: "/admin" };

// The heat-map's colour words: on the portal they belong to Team health's key and cells only.
const BAND_WORDS = /\b(Green|Yellow|Red)\b/;

describe("a member", () => {
  it("is sent from the heat-map to their check-in", async () => {
    await expect(DashboardPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow(
      "NEXT_REDIRECT /portal/checkin",
    );
  });

  it("is sent from the trend grid to their check-in", async () => {
    await expect(TrendPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow(
      "NEXT_REDIRECT /portal/checkin",
    );
  });

  it("is sent from a team's week to their check-in, before any check-in loads", async () => {
    await expect(
      TeamWeekPage({
        params: Promise.resolve({ teamId: "none", week: "2026-10-05" }),
        searchParams: Promise.resolve({}),
      } as never),
    ).rejects.toThrow("NEXT_REDIRECT /portal/checkin");
    expect(loadTeamWeek).not.toHaveBeenCalled();
  });

  it("isn't offered Team health on the portal", async () => {
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).not.toContain("/portal/dashboard");
    expect(html).toContain("/portal/checkin");
  });

  it("gets their own check-in on the portal, and nothing that's graded or for leaders and admins", async () => {
    const html = renderToStaticMarkup(await PortalPage());
    // The heat-map holds grades; for a member RLS would hand back their own graded check-ins.
    expect(loadHeatmapData).not.toHaveBeenCalled();
    expect(loadScoringConfig).not.toHaveBeenCalled();
    expect(nav(html)).toEqual([PORTAL, CHECKIN]);
    expect(html).not.toContain("/portal/dashboard");
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain("Team health");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain(CHECKED_IN_TILE);
    expect(html).not.toContain(NEEDS_A_LOOK_TILE);
    expect(html).not.toContain("Needs a look");
    expect(html).not.toMatch(BAND_WORDS);
    expect(html).toContain("Start check-in");
    // Nor who else checked in: no read of people by team, nor of anyone's check-ins this week.
    expect(queriesOf("members")).toEqual([]);
    expect(queriesOf("checkins").filter((q) => q.columns === "id, member_id")).toEqual([]);
    expect(queriesOf("checkins")).toEqual([]);
  });

  it("whose login isn't linked to anyone yet gets just the portal and their check-in", async () => {
    vi.mocked(loadMyWeek).mockResolvedValue({ state: "no_member" });
    vi.mocked(loadRole).mockResolvedValue(null);
    const html = renderToStaticMarkup(await PortalPage());
    expect(nav(html)).toEqual([PORTAL, CHECKIN]);
    expect(html).toContain("Your account isn&#x27;t set up yet. Ask HQ.");
    expect(loadHeatmapData).not.toHaveBeenCalled();
  });
});

describe("leaders and hq", () => {
  it.each(["leader", "hq"] as const)("%s is offered Team health on the portal", async (role) => {
    vi.mocked(loadRole).mockResolvedValue(role);
    expect(renderToStaticMarkup(await PortalPage())).toContain("/portal/dashboard");
  });

  it("the portal still renders, without Team health, if the role can't be read", async () => {
    vi.mocked(loadRole).mockRejectedValue(new Error("Couldn't load your role"));
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).not.toContain("/portal/dashboard");
    expect(html).toContain("Sign out");
  });

  // Needs a look is for hq and division leaders only (needs-a-look.ts); this leader leads no
  // division (heatmapFor gives them no teams at all), so they get Who's checked in without it.
  it.each([
    ["leader", "The teams you lead", false],
    ["hq", "Every team", true],
  ] as const)(
    "%s gets the Team health tile when the heat-map reads the same role",
    async (role, scope, needsALook) => {
      vi.mocked(loadRole).mockResolvedValue(role);
      heatmapFor(role);
      const html = renderToStaticMarkup(await PortalPage());
      expect(loadHeatmapData).toHaveBeenCalledOnce();
      // Six weeks of bars, oldest first, ending with this week.
      expect(vi.mocked(loadHeatmapData).mock.calls[0][1]).toEqual(weeksEndingAt(THIS_WEEK, 6));
      expect(nav(html)).toEqual([PORTAL, CHECKIN, TEAM_HEALTH]);
      expect(html).toContain('id="team-health-title"');
      expect(html).toContain(scope);
      expect(html).toContain("Check-ins this week");
      expect(html).toMatch(BAND_WORDS); // the key, under the scoring settings' thresholds
      expect(html).toContain("the last 6 weeks, oldest first");
      // The placeholders have made way for the real tiles.
      expect(html).not.toContain("data-placeholder");
      expect(html).not.toContain("Coming soon");
      expect(html).toContain(CHECKED_IN_TILE);
      expect(html).not.toContain("Couldn&#x27;t load who&#x27;s checked in");
      if (needsALook) {
        expect(html).toContain(NEEDS_A_LOOK_TILE);
        expect(html).toContain("Needs a look");
      } else {
        expect(html).not.toContain(NEEDS_A_LOOK_TILE);
        expect(html).not.toContain("Needs a look");
      }
      expectNoGradeRead();
      expect(queriesOf("checkins")).toHaveLength(1);
      expect(html).not.toContain('href="/admin"'); // no admin grant
      expect(loadScoringConfig).not.toHaveBeenCalled();
    },
  );

  // Who's checked in reads people by the teams the viewer covers, as the heat-map does: a leader's
  // led teams (app_led_team_ids), every placed person for hq.
  it("reads a leader's people by the teams they lead, and hq's from every team", async () => {
    vi.mocked(loadRole).mockResolvedValue("leader");
    heatmapFor("leader", {
      teams: [team("d1", "Culture", "domain", null), team("t1", "Atlas", "team", "d1")],
      ledTeams: ["d1", "t1"],
    });
    renderToStaticMarkup(await PortalPage());
    expect(queriesOf("members")).toEqual([
      { table: "members", columns: "id, team_id", filters: [["in", "team_id", ["d1", "t1"]]] },
    ]);
    expect(queriesOf("checkins")).toEqual([
      { table: "checkins", columns: "id, member_id", filters: [["eq", "week_start", THIS_WEEK]] },
    ]);

    queries = [];
    vi.mocked(loadRole).mockResolvedValue("hq");
    heatmapFor("hq");
    renderToStaticMarkup(await PortalPage());
    expect(queriesOf("members")).toEqual([
      { table: "members", columns: "id, team_id", filters: [["not", "team_id", "is", null]] },
    ]);
    expectNoGradeRead();
  });

  it.each([
    ["leads a domain and its teams", "isn't", "domain", false],
    ["leads a division", "is", "division", true],
    ["leads the organisation", "is", "organisation", true],
  ] as const)("a leader who %s %s offered Needs a look", async (_, __, kind, shown) => {
    vi.mocked(loadRole).mockResolvedValue("leader");
    heatmapFor("leader", {
      teams: [team("top", "Gather", kind, null), team("t1", "Atlas", "team", "top")],
      ledTeams: ["top", "t1"],
    });
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).toContain('id="team-health-title"');
    expect(html).toContain(CHECKED_IN_TILE);
    if (shown) {
      expect(html).toContain(NEEDS_A_LOOK_TILE);
      expect(html).toContain("Nothing red so far this week.");
    } else {
      expect(html).not.toContain(NEEDS_A_LOOK_TILE);
      expect(html).not.toContain("Needs a look");
    }
    expectNoGradeRead();
  });

  // The role is read twice, once for the nav and once with the heat-map's rows. If someone's role
  // changes in between, the rows may be a member's own graded check-ins: leave them out. The nav
  // link is harmless, since Team health checks the role again and sends a member away.
  it("leaves Team health out when the heat-map was read as a member, though the role check said leader", async () => {
    vi.mocked(loadRole).mockResolvedValue("leader");
    heatmapFor("member");
    const html = renderToStaticMarkup(await PortalPage());
    expect(nav(html)).toEqual([PORTAL, CHECKIN, TEAM_HEALTH]);
    expect(html).not.toContain('id="team-health-title"');
    expect(html).not.toContain("Check-ins this week");
    expect(html).not.toContain("data-placeholder");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain(CHECKED_IN_TILE);
    expect(html).not.toContain(NEEDS_A_LOOK_TILE);
    expect(html).not.toContain("Needs a look");
    expect(html).not.toMatch(BAND_WORDS);
    // Nothing read for Who's checked in either: no people by team, no check-ins of this week.
    expect(queriesOf("members")).toEqual([]);
    expect(queriesOf("checkins")).toEqual([]);
  });

  it("a role that can't be read loads no heat-map, and is logged without its message", async () => {
    vi.mocked(loadRole).mockRejectedValue(new Error("Couldn't load your role: secret detail"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Team health");
    expect(nav(html)).toEqual([PORTAL, CHECKIN]);
    expect(loadHeatmapData).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("portal role check failed", { code: undefined, status: undefined });
    log.mockRestore();
  });
});

describe("the Admin card", () => {
  it("is offered to an admin-grant holder, whatever their role", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const html = renderToStaticMarkup(await PortalPage());
    expect(rpc).toHaveBeenCalledWith("app_has_grant", { requested: "admin" });
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain("/portal/dashboard"); // still a member: no Team health
  });

  it("isn't offered without the grant, or if the grant can't be checked", async () => {
    vi.mocked(loadRole).mockResolvedValue("hq");
    expect(renderToStaticMarkup(await PortalPage())).not.toContain('href="/admin"');

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).not.toContain('href="/admin"');
    expect(html).toContain("/portal/dashboard");
    log.mockRestore();
  });

  it("shows a member-role admin the way into admin and the thresholds in force, without the heat-map", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const html = renderToStaticMarkup(await PortalPage());
    expect(nav(html)).toEqual([PORTAL, CHECKIN, ADMIN]);
    expect(html).toContain('id="admin-title"');
    expect(html).toContain('href="/admin/structure"');
    expect(html).toContain('href="/admin/scoring"');
    expect(html).toContain("Green 3 or more · Yellow 2 to under 3 · Red under 2");
    expect(loadScoringConfig).toHaveBeenCalledOnce();
    expect(loadHeatmapData).not.toHaveBeenCalled();
  });

  it("takes a leader's thresholds from the heat-map's settings rather than reading them again", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    vi.mocked(loadRole).mockResolvedValue("leader");
    heatmapFor("leader");
    const html = renderToStaticMarkup(await PortalPage());
    expect(nav(html)).toEqual([PORTAL, CHECKIN, TEAM_HEALTH, ADMIN]);
    expect(html).toContain("Green 3 or more · Yellow 2 to under 3 · Red under 2");
    expect(loadScoringConfig).not.toHaveBeenCalled();
  });

  it("still opens when the thresholds can't be read", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    vi.mocked(loadScoringConfig).mockRejectedValue(new Error("down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).toContain('href="/admin/scoring"');
    expect(html).toContain("Weights and thresholds.");
    expect(log).toHaveBeenCalledWith("portal scoring failed", { code: undefined, status: undefined });
    log.mockRestore();
  });

  it.each([
    ["answers with an error", () => rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } })],
    ["throws", () => rpc.mockRejectedValue(Object.assign(new Error("timeout"), { code: "57014" }))],
  ])("is left out, and the failure logged by its code, when the grant check %s", async (_, fail) => {
    fail();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(await PortalPage());
    expect(nav(html)).toEqual([PORTAL, CHECKIN]);
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain('id="admin-title"');
    expect(html).not.toContain("/admin/structure");
    expect(loadScoringConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("portal admin check failed", { code: "57014", status: undefined });
    log.mockRestore();
  });
});
