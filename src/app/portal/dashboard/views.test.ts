import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHeatmapData, loadLedTeams, loadRole, loadScoringConfig, loadTeamWeek } from "@/lib/dashboard/load";
import type { CheckinRow } from "@/lib/dashboard/org";
import type { TeamNode } from "@/lib/dashboard/tree";
import type { HealthConfig } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import TeamWeekPage from "./[teamId]/[week]/page";
import DashboardPage from "./page";

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

function heatmapData(role: "hq" | "leader", ledTeams: string[] = []) {
  vi.mocked(loadHeatmapData).mockResolvedValue({
    teams: TEAMS,
    checkins: [checkin("ip1", THIS_WEEK, [4, 4, 3]), checkin("ip1", "2026-09-28", [2, 2, 3])],
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
    expect(html).toContain("IP Lab");
    expect(html).toContain("Gather");
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
