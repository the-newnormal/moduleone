import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadHeatmapData } from "@/lib/dashboard/load";
import type { CheckinRow, OrgNode } from "@/lib/dashboard/org";
import type { TeamNode } from "@/lib/dashboard/tree";
import type { HealthConfig } from "@/lib/health/health";
import { loadTeamHealthGlance } from "./team-health";

// The portal's Team health tile: last week beside this week so far, for the topmost boxes the viewer
// covers, coloured by the scoring settings. Only leaders and hq see it; a member's rows are their own
// grades, so the loader hides them even if it's called for a member by mistake. It never throws.

vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadHeatmapData: vi.fn(),
}));

const supabase = {} as never;

const LAST = "2026-09-28";
const THIS = "2026-10-05";

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

const CHECKINS = [
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

// A box as [name, last week's band, this week's band], for comparing colours at a glance.
const bands = (n: OrgNode | null) => n && [n.name, ...n.cells.map((c) => c.health?.band ?? null)];

let log: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.mocked(loadHeatmapData).mockReset();
  heatmap();
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

describe("loadTeamHealthGlance", () => {
  it.each([
    [THIS, [LAST, THIS]],
    // Across a year end: last week is still seven days back.
    ["2026-01-05", ["2025-12-29", "2026-01-05"]],
  ])("reads only last week and this week, oldest first, for the week of %s", async (thisWeek, weeks) => {
    const health = await loadTeamHealthGlance(supabase, thisWeek);
    expect(loadHeatmapData).toHaveBeenCalledTimes(1);
    expect(loadHeatmapData).toHaveBeenCalledWith(supabase, weeks);
    expect(health).toMatchObject({ status: "ok", weeks });
  });

  // RLS gives a member their own graded check-ins: hide them, with nothing graded alongside.
  it.each(["member", null] as const)("is hidden for role %s, even with graded rows loaded", async (role) => {
    heatmap({ role });
    expect(await loadTeamHealthGlance(supabase, THIS)).toEqual({ status: "hidden" });
  });

  it("says it failed, and logs only the code and status, when the heat-map can't load", async () => {
    vi.mocked(loadHeatmapData).mockRejectedValue(
      Object.assign(new Error("Couldn't load check-ins: Ada Lovelace"), { code: "PGRST000" }),
    );
    expect(await loadTeamHealthGlance(supabase, THIS)).toEqual({ status: "failed" });
    expect(log).toHaveBeenCalledWith("portal team health failed", { code: "PGRST000", status: undefined });
    expect(JSON.stringify(log.mock.calls)).not.toContain("Ada");
  });

  // The whole computation is inside the guard, not just the load: a row the grader could never have
  // written fails the tile rather than the portal.
  it("says it failed when a loaded row can't be scored", async () => {
    heatmap({ checkins: [checkin("ip1", THIS, [9, 3, 3])] });
    expect(await loadTeamHealthGlance(supabase, THIS)).toEqual({ status: "failed" });
    expect(log).toHaveBeenCalledWith("portal team health failed", expect.anything());
  });

  it("gives hq the organisation, the divisions under it and the unplaced domains, with both weeks' counts", async () => {
    const health = await loadTeamHealthGlance(supabase, THIS);
    if (health.status !== "ok") throw new Error(`expected ok, got ${health.status}`);

    expect(health).toMatchObject({ role: "hq", config: RULES, weeks: [LAST, THIS] });
    // The organisation takes in everything placed under it; Loose Ends and the no-team row don't count.
    expect(health.glance.summary?.cells).toEqual([
      { week: LAST, health: { band: "green", score: 12, graded: 1, bands: { green: 1, yellow: 0, red: 0 } }, pending: 0 },
      { week: THIS, health: { band: "yellow", score: 6.5, graded: 2, bands: { green: 0, yellow: 1, red: 1 } }, pending: 1 },
    ]);
    expect(bands(health.glance.summary)).toEqual(["The New Normal", "green", "yellow"]);
    expect(health.glance.rows.map(bands)).toEqual([
      ["Gather", "green", "red"],
      ["Culture", null, "yellow"],
    ]);
    expect(health.glance.other.map(bands)).toEqual([["Loose Ends", "red", null]]);
    expect(health.glance.more).toBe(0);
    // Counted row by row: hq covers every team, and check-ins made with no team.
    expect(health.tally).toEqual({
      lastWeek: { checkins: 2, pending: 0 },
      thisWeek: { checkins: 4, pending: 1 },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("gives a leader the teams they lead, without their own check-ins elsewhere", async () => {
    heatmap({
      role: "leader",
      ledTeams: ["ip", "ip1"],
      // What RLS returns a leader of IP Lab: its check-ins, plus their own in Atlas and with no team.
      checkins: [
        checkin("ip1", LAST, [4, 3, 3]),
        checkin("ip1", THIS, [2, 2, 3]),
        checkin("ip1", THIS, null),
        checkin("at", THIS, [5, 5, 5]),
        checkin(null, LAST, [5, 5, 5]),
      ],
    });
    const health = await loadTeamHealthGlance(supabase, THIS);
    if (health.status !== "ok") throw new Error(`expected ok, got ${health.status}`);

    expect(health.role).toBe("leader");
    // One box above everything they cover: it heads the glance, with what's directly under it below.
    expect(bands(health.glance.summary)).toEqual(["IP Lab", "green", "red"]);
    expect(health.glance.rows.map(bands)).toEqual([["IP Lab 1", "green", "red"]]);
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
      ["The New Normal", "green", "green"],
      [
        ["Gather", "green", "green"],
        ["Culture", null, "green"],
      ],
      [["Loose Ends", "green", null]],
    ],
    [
      "higher",
      { green: 13, yellow: 10 },
      ["The New Normal", "yellow", "red"],
      [
        ["Gather", "yellow", "red"],
        ["Culture", null, "red"],
      ],
      [["Loose Ends", "red", null]],
    ],
  ])("colours the glance by the settings' thresholds (%s)", async (_, thresholds, summary, rows, other) => {
    const config: HealthConfig = { ...RULES, thresholds };
    heatmap({ config });
    const health = await loadTeamHealthGlance(supabase, THIS);
    if (health.status !== "ok") throw new Error(`expected ok, got ${health.status}`);

    expect(health.config).toBe(config);
    expect(bands(health.glance.summary)).toEqual(summary);
    expect(health.glance.rows.map(bands)).toEqual(rows);
    expect(health.glance.other.map(bands)).toEqual(other);
    expect(health.glance.summary?.cells[1].health?.score).toBe(6.5);
  });
});
