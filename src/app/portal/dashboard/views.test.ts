import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHeatmapData, loadLedTeams, loadRole, loadScoringConfig, loadTeamWeek } from "@/lib/dashboard/load";
import type { CheckinRow } from "@/lib/dashboard/org";
import type { TeamNode } from "@/lib/dashboard/tree";
import type { HealthConfig } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import { weeksEndingAt } from "@/lib/dashboard/weeks";
import TeamWeekPage from "./[teamId]/[week]/page";
import DashboardPage from "./page";
import TrendPage from "./trend/page";

// The org chart (the dashboard's front page), what it links to, and the way back from a drill-in.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
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

const CONFIG: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const THIS_WEEK = "2026-10-05";

const node = (id: string, name: string, kind: TeamNode["kind"], parent_id: string | null): TeamNode => ({
  id,
  name,
  kind,
  parent_id,
  sort_order: 0,
  archived_at: null,
});

const TEAMS = [
  node("ga", "Gather", "division", null),
  node("ip", "IP Lab", "domain", "ga"),
  node("ip1", "IP Lab 1", "team", "ip"),
];

const checkin = (team_id: string, week_start: string, scores: [number, number, number]): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores[0],
  excellence_score: scores[1],
  morale_score: scores[2],
});

function heatmapData(
  role: "hq" | "leader",
  ledTeams: string[] = [],
  { teams = TEAMS, checkins = [] }: { teams?: TeamNode[]; checkins?: CheckinRow[] } = {},
) {
  vi.mocked(loadHeatmapData).mockResolvedValue({
    teams,
    checkins: [checkin("ip1", THIS_WEEK, [4, 4, 3]), checkin("ip1", "2026-09-28", [2, 2, 3]), ...checkins],
    config: CONFIG,
    role,
    ledTeams,
  });
}

const page = async (searchParams: Record<string, string>) =>
  renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve(searchParams) } as never));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00+08:00")); // a Thursday in the week of 5 Oct
  vi.mocked(createClient).mockResolvedValue({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1" } } }) },
  } as never);
  vi.mocked(loadScoringConfig).mockResolvedValue(CONFIG);
  vi.mocked(loadLedTeams).mockResolvedValue([]);
  vi.mocked(loadRole).mockResolvedValue("hq");
  vi.mocked(loadTeamWeek).mockResolvedValue({ teamName: "Gather", context: [], checkins: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the org chart", () => {
  it("colours each box by this week, rolled up, and opens that week's check-ins", async () => {
    heatmapData("hq");
    const html = await page({});
    expect(html).toContain("Week of 5 Oct 2026");
    expect(loadHeatmapData).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([THIS_WEEK]));
    expect(vi.mocked(loadHeatmapData).mock.calls[0][1]).toHaveLength(8);
    // Gather, IP Lab and IP Lab 1 all hold the one green check-in this week (16).
    for (const [id, name] of [
      ["ga", "Gather"],
      ["ip", "IP Lab"],
      ["ip1", "IP Lab 1"],
    ]) {
      expect(html).toContain(`href="/portal/dashboard/${id}/${THIS_WEEK}"`);
      expect(html).toContain(`aria-label="${name} · week of 5 Oct 2026. Green · mean score 16.0.`);
    }
    expect(html).toContain("The 7 weeks before, oldest first: no check-ins, no check-ins, no check-ins, no check-ins, no check-ins, no check-ins, red.");
    // Nothing after this week.
    expect(html).toMatch(/<span role="link" aria-disabled="true"[^>]*>Next week/);
    expect(html).toContain('href="/portal/dashboard?week=2026-09-28"');
  });

  it("steps back a week, and forward again to this one", async () => {
    heatmapData("hq");
    const html = await page({ week: "2026-09-28" });
    expect(vi.mocked(loadHeatmapData).mock.calls[0][1]).toEqual(weeksEndingAt("2026-09-28", 8));
    expect(html).toMatch(/Week of 28 Sept? 2026/);
    expect(html).toContain(`href="/portal/dashboard/ip1/2026-09-28"`);
    expect(html).toMatch(/IP Lab 1 · week of 28 Sept? 2026\. Red · mean score 4\.0\./);
    expect(html).toMatch(/href="\/portal\/dashboard"[^>]*>Next week/);
    expect(html).toContain("Back to this week");
  });

  it("shows a leader the domain above their team as a label, not a box", async () => {
    heatmapData("leader", ["ip1"]);
    const html = await page({});
    expect(html).toContain(`href="/portal/dashboard/ip1/${THIS_WEEK}"`);
    expect(html).not.toContain(`href="/portal/dashboard/ip/${THIS_WEEK}"`);
    expect(html).not.toContain(`href="/portal/dashboard/ga/${THIS_WEEK}"`);
    // The domain and division above it are labels, not boxes.
    expect(html).toMatch(/<span class="flex min-h-9[^"]*">IP Lab<\/span>/);
    expect(html).toMatch(/<h2 class="flex min-h-9[^"]*">Gather<\/h2>/);
  });

  it("stops at the earliest week the app accepts", async () => {
    heatmapData("hq");
    // 21 Feb 2000's bars start on 3 Jan 2000, the first week the drill-in opens.
    const html = await page({ week: "2000-02-21" });
    expect(html).toMatch(/Week of 21 Feb 2000/);
    expect(html).toMatch(/<span role="link" aria-disabled="true"[^>]*><svg[^>]*>.*?<\/svg>Previous week/);
    expect(html).not.toContain("/1999-");
    expect(await page({ week: "2000-02-14" })).toContain("Week of 5 Oct 2026");
  });

  it("sends the trend grid's old address (?weeks=) to the Trend tab", async () => {
    await expect(page({ weeks: "4" })).rejects.toThrow("NEXT_REDIRECT /portal/dashboard/trend?weeks=4");
    await expect(page({ weeks: "nonsense" })).rejects.toThrow("NEXT_REDIRECT /portal/dashboard/trend?weeks=8");
    // With ?week= too, it's an org chart address.
    heatmapData("hq");
    expect(await page({ weeks: "4", week: "2026-09-28" })).toMatch(/Week of 28 Sept? 2026/);
  });

  it("prints how many check-ins were red on every box that holds one, whatever its colour", async () => {
    // This week IP Lab 1 has 16 and three 30s (green) and three 0.6s (red): a green mean of 15.4.
    const great = checkin("ip1", THIS_WEEK, [5, 5, 5]);
    const awful = checkin("ip1", THIS_WEEK, [1, 1, 1]);
    heatmapData("hq", [], { checkins: [great, great, great, awful, awful, awful] });
    const html = await page({});
    expect(html).toContain(`aria-label="IP Lab 1 · week of 5 Oct 2026. Green · mean score 15.4. 7 graded check-ins: 4 green, 0 yellow, 3 red.`);
    // The legend's sample, then once on each of Gather, IP Lab and IP Lab 1.
    expect(html.match(/>\d+ red</g)).toEqual([">2 red<", ">3 red<", ">3 red<", ">3 red<"]);
    // A red box says how many too: 28 Sep's one check-in (4) was red.
    expect((await page({ week: "2026-09-28" })).match(/>\d+ red</g)).toEqual([">2 red<", ">1 red<", ">1 red<", ">1 red<"]);
  });

  it("prints no count on a box with no red check-ins", async () => {
    heatmapData("hq");
    expect((await page({})).match(/>\d+ red</g)).toEqual([">2 red<"]); // the legend's sample only
  });

  it("opens an earlier week from its bar, and comes back to the week being viewed", async () => {
    heatmapData("hq");
    const html = await page({});
    expect(html).toContain(`href="/portal/dashboard/ip1/2026-09-28?from=${THIS_WEEK}"`);
    expect(html).toContain(`href="/portal/dashboard/ip1/${THIS_WEEK}"`); // this week's own bar
  });
});

describe("a team's week", () => {
  const GATHER = "00000000-0000-4000-8000-0000000000aa";
  const IP_LAB = "00000000-0000-4000-8000-0000000000bb";
  const drillIn = async (teamId: string, week: string, searchParams: Record<string, string> = {}) =>
    renderToStaticMarkup(
      await TeamWeekPage({
        params: Promise.resolve({ teamId, week }),
        searchParams: Promise.resolve(searchParams),
      } as never),
    );

  it("goes back to the view it was opened from", async () => {
    expect(await drillIn(GATHER, THIS_WEEK)).toContain('href="/portal/dashboard"');
    expect(await drillIn(GATHER, "2026-09-28")).toContain('href="/portal/dashboard?week=2026-09-28"');
    expect(await drillIn(GATHER, "2026-09-28", { weeks: "4" })).toContain('href="/portal/dashboard/trend?weeks=4"');
    // From an earlier week's bar on the chart for 28 Sep: back to 28 Sep.
    expect(await drillIn(GATHER, "2026-08-17", { from: "2026-09-28" })).toContain(
      'href="/portal/dashboard?week=2026-09-28"',
    );
    expect(await drillIn(GATHER, "2026-08-17", { from: THIS_WEEK })).toContain('href="/portal/dashboard"');
    expect(await drillIn(GATHER, "2026-08-17", { from: "nonsense" })).toContain('href="/portal/dashboard?week=2026-08-17"');
  });

  it("reads a hand-typed uppercase team id as the same team", async () => {
    await drillIn(IP_LAB.toUpperCase(), THIS_WEEK);
    expect(vi.mocked(loadTeamWeek).mock.calls[0][1]).toBe(IP_LAB);
  });

  it("titles a team the leader doesn't lead as their own check-ins, not the team's", async () => {
    vi.mocked(loadRole).mockResolvedValue("leader");
    vi.mocked(loadLedTeams).mockResolvedValue(["ip1"]);
    vi.mocked(loadTeamWeek).mockResolvedValue({ teamName: "IP Lab", context: ["Gather"], checkins: [] });
    expect(await drillIn(IP_LAB, THIS_WEEK)).toContain("<h1 class=\"text-4xl\">Your check-ins · IP Lab</h1>");
    vi.mocked(loadLedTeams).mockResolvedValue([IP_LAB]);
    expect(await drillIn(IP_LAB, THIS_WEEK)).toContain("<h1 class=\"text-4xl\">IP Lab</h1>");
  });

  it("loads the check-ins the viewer covers under the team", async () => {
    vi.mocked(loadRole).mockResolvedValue("leader");
    vi.mocked(loadLedTeams).mockResolvedValue(["ip1"]);
    await drillIn(IP_LAB, THIS_WEEK);
    const [, teamId, week, covers] = vi.mocked(loadTeamWeek).mock.calls[0];
    expect([teamId, week]).toEqual([IP_LAB, THIS_WEEK]);
    expect([covers("ip1"), covers(IP_LAB)]).toEqual([true, false]);
  });

  it("puts check-ins from the teams under it in a section each", async () => {
    const checkin = (id: string, memberName: string, team: string | null, teamId: string = team ?? IP_LAB) => ({
      id,
      memberName,
      teamId,
      team,
      activity_score: 3,
      excellence_score: 3,
      morale_score: 3,
      rubric_review: null,
      transcript: null,
      recording: null,
    });
    vi.mocked(loadTeamWeek).mockResolvedValue({
      teamName: "IP Lab",
      context: ["Gather"],
      checkins: [checkin("a", "Wen", null), checkin("b", "Abe", "IP Lab 1"), checkin("c", "Xia", "IP Lab 1")],
    });
    const html = await drillIn(IP_LAB, THIS_WEEK);
    expect(html.match(/<h2[^>]*>[^<]*<\/h2>/g)).toEqual([
      expect.stringContaining(">IP Lab</h2>"),
      expect.stringContaining(">IP Lab 1</h2>"),
    ]);
    expect(html.match(/<h3[^>]*>[^<]*<\/h3>/g)?.map((h) => h.replace(/<[^>]+>/g, ""))).toEqual(["Wen", "Abe", "Xia"]);
  });
});

describe("a team's week, with two teams of the same name under it", () => {
  it("keeps their check-ins in separate sections", async () => {
    const checkin = (id: string, memberName: string, teamId: string) => ({
      id,
      memberName,
      teamId,
      team: "Twins",
      activity_score: 3,
      excellence_score: 3,
      morale_score: 3,
      rubric_review: null,
      transcript: null,
      recording: null,
    });
    vi.mocked(loadTeamWeek).mockResolvedValue({
      teamName: "IP Lab",
      context: [],
      checkins: [checkin("a", "Abe", "twin-1"), checkin("b", "Bea", "twin-2")],
    });
    const html = renderToStaticMarkup(
      await TeamWeekPage({
        params: Promise.resolve({ teamId: "00000000-0000-4000-8000-0000000000bb", week: THIS_WEEK }),
        searchParams: Promise.resolve({}),
      } as never),
    );
    expect(html.match(/<h2[^>]*>Twins<\/h2>/g)).toHaveLength(2);
  });
});

describe("the trend grid", () => {
  const trend = async (searchParams: Record<string, string>) =>
    renderToStaticMarkup(await TrendPage({ searchParams: Promise.resolve(searchParams) } as never));

  it("heads each division with its own row for hq, and keeps ?weeks= on every cell", async () => {
    heatmapData("hq");
    const html = await trend({ weeks: "4" });
    expect(vi.mocked(loadHeatmapData).mock.calls[0][1]).toEqual(weeksEndingAt(THIS_WEEK, 4));
    expect(html).toMatch(/<th scope="rowgroup" class="sticky[^"]*">Gather<\/th>/);
    for (const id of ["ga", "ip", "ip1"]) expect(html).toContain(`href="/portal/dashboard/${id}/${THIS_WEEK}?weeks=4"`);
    expect(html).not.toMatch(/href="\/portal\/dashboard\/[^"/]+\/\d{4}-\d{2}-\d{2}"/); // none without ?weeks=
  });

  it("prints how many check-ins were red under the score, and spells it out for a single week", async () => {
    // 28 Sep: IP Lab 1's one check-in (4) was red. This week: 16 and two 0.6s, yellow with two reds.
    const awful = checkin("ip1", THIS_WEEK, [1, 1, 1]);
    heatmapData("hq", [], { checkins: [awful, awful] });
    const html = await trend({ weeks: "4" });
    // The legend's sample, then Gather, IP Lab and IP Lab 1, a row each: 28 Sep, then this week.
    expect(html.match(/>\d+ red</g)).toEqual([">2 red<", ">1 red<", ">2 red<", ">1 red<", ">2 red<", ">1 red<", ">2 red<"]);
    // A single week writes the counts out, so neither its cells nor its legend carry the pill.
    const week = await trend({ weeks: "1" });
    expect(week.match(/>\d+ red</g)).toBeNull();
    expect(week).toContain("3 graded check-ins: 1 green, 0 yellow, 2 red");
  });

  it("colours only what a leader leads", async () => {
    heatmapData("leader", ["ip1"]);
    const html = await trend({ weeks: "4" });
    expect(html).toContain(`href="/portal/dashboard/ip1/${THIS_WEEK}?weeks=4"`);
    expect(html).not.toContain("/portal/dashboard/ip/");
    expect(html).not.toContain("/portal/dashboard/ga/");
    expect(html).toContain("No colour: you lead only some of the teams under it");
  });
});

// Since migration 0006 one organisation node holds every division, and people can sit in it.
describe("with an organisation node", () => {
  const ORG = { teams: [node("tn", "The New Normal", "organisation", null), { ...TEAMS[0], parent_id: "tn" }, ...TEAMS.slice(1)], checkins: [checkin("tn", THIS_WEEK, [2, 2, 3])] };

  it("puts the organisation's own box, rolled up over everything, above the division cards for hq", async () => {
    heatmapData("hq", [], ORG);
    const html = await page({});
    // Its own check-in (4) and IP Lab 1's (16): a mean of 10.0, yellow.
    expect(html).toContain(`aria-label="The New Normal · week of 5 Oct 2026. Yellow · mean score 10.0.`);
    expect(html).toContain(`aria-label="Gather · week of 5 Oct 2026. Green · mean score 16.0.`);
    expect(html.indexOf('href="/portal/dashboard/tn/')).toBeLessThan(html.indexOf('href="/portal/dashboard/ga/'));
  });

  it("leaves it out for a leader who doesn't cover it", async () => {
    // RLS gives a leader none of the organisation's own check-ins.
    heatmapData("leader", ["ip1"], { teams: ORG.teams });
    const html = await page({});
    expect(html).not.toContain("The New Normal");
    expect(html).toContain(`href="/portal/dashboard/ip1/${THIS_WEEK}"`);
    expect(html).toMatch(/<h2 class="flex min-h-9[^"]*">Gather<\/h2>/);
  });

  it("heads the trend grid with its own row, then a group per division", async () => {
    heatmapData("hq", [], ORG);
    const html = await renderToStaticMarkup(await TrendPage({ searchParams: Promise.resolve({ weeks: "4" }) } as never));
    expect(html).toMatch(/<th scope="rowgroup" class="sticky[^"]*">The New Normal<\/th>[\s\S]*<th scope="rowgroup" class="sticky[^"]*">Gather<\/th>/);
  });
});

describe("the colour tally at the top", () => {
  // { green, yellow, red } as the panel shows them.
  const tally = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/>(\d+)<\/span><span class="text-muted-foreground">(green|yellow|red)</g)].map(([, n, band]) => [band, Number(n)]),
    );
  const trend = async (weeks: string) =>
    renderToStaticMarkup(await TrendPage({ searchParams: Promise.resolve({ weeks }) } as never));

  it("counts the week's teams by colour on the org chart, not the domain or division above them", async () => {
    heatmapData("hq");
    const html = await page({});
    expect(html).toContain(">Teams, this week</h2>");
    expect(tally(html)).toEqual({ green: 1, yellow: 0, red: 0 }); // IP Lab 1 only
    const earlier = await page({ week: "2026-09-28" });
    expect(earlier).toMatch(/>Teams, week of 28 Sept?<\/h2>/);
    expect(tally(earlier)).toEqual({ green: 0, yellow: 0, red: 1 });
  });

  it("counts a team with nothing graded apart", async () => {
    heatmapData("hq", [], { teams: [...TEAMS, node("ip2", "IP Lab 2", "team", "ip")], checkins: [checkin("ip2", "2026-09-28", [4, 4, 4])] });
    const html = await page({});
    expect(tally(html)).toEqual({ green: 1, yellow: 0, red: 0 });
    expect(html).toContain("1 more with nothing graded");
  });

  it("counts only the teams a leader leads", async () => {
    heatmapData("leader", ["ip1"]);
    const html = await page({});
    expect(html).toContain(">Teams you lead, this week</h2>");
    expect(tally(html)).toEqual({ green: 1, yellow: 0, red: 0 });
  });

  it("counts this week on the Trend tab, whatever the range", async () => {
    heatmapData("hq");
    for (const weeks of ["1", "12"]) {
      const html = await trend(weeks);
      expect(html).toContain(">Teams, this week</h2>");
      expect(tally(html)).toEqual({ green: 1, yellow: 0, red: 0 });
    }
  });

  it("is left out when there are no teams to count", async () => {
    heatmapData("hq", [], { teams: [node("ga", "Gather", "division", null)] });
    expect(await page({})).not.toContain("Teams, ");
  });
});

describe("signing in again", () => {
  it("comes back to the exact page, query included", async () => {
    vi.mocked(createClient).mockResolvedValue({ auth: { getClaims: async () => ({ data: null }) } } as never);
    await expect(DashboardPage({ searchParams: Promise.resolve({ week: "2026-09-28" }) } as never)).rejects.toThrow(
      `NEXT_REDIRECT /login?next=${encodeURIComponent("/portal/dashboard?week=2026-09-28")}`,
    );
    await expect(TrendPage({ searchParams: Promise.resolve({ weeks: "4" }) } as never)).rejects.toThrow(
      `NEXT_REDIRECT /login?next=${encodeURIComponent("/portal/dashboard/trend?weeks=4")}`,
    );
    const team = "00000000-0000-4000-8000-0000000000aa";
    await expect(
      TeamWeekPage({
        params: Promise.resolve({ teamId: team, week: "2026-08-17" }),
        searchParams: Promise.resolve({ from: "2026-09-28" }),
      } as never),
    ).rejects.toThrow(`NEXT_REDIRECT /login?next=${encodeURIComponent(`/portal/dashboard/${team}/2026-08-17?from=2026-09-28`)}`);
  });
});

describe("an archived division on the trend grid", () => {
  it("is tagged archived while it has check-ins in range", async () => {
    vi.mocked(loadHeatmapData).mockResolvedValue({
      teams: [
        { ...node("old", "Old Division", "division", null), archived_at: "2026-09-01T00:00:00Z" },
        { ...node("od", "Old Domain", "domain", "old"), archived_at: "2026-09-01T00:00:00Z" },
      ],
      checkins: [checkin("od", "2026-09-28", [3, 3, 3])],
      config: CONFIG,
      role: "hq",
      ledTeams: [],
    });
    const html = renderToStaticMarkup(await TrendPage({ searchParams: Promise.resolve({ weeks: "4" }) } as never));
    expect(html).toMatch(/<th scope="rowgroup"[^>]*>Old Division<span[^>]*> archived<\/span><\/th>/);
  });
});
