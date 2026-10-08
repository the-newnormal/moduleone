import { describe, expect, it } from "vitest";
import type { HealthConfig } from "@/lib/health/health";
import { buildHeatmap, type CheckinRow, type TeamNode } from "./heatmap";

const RULES: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const WEEKS = ["2026-09-28", "2026-10-05"];

// Before the team tree (migration 0003): a free-text division.
const team = (id: string, name: string, division: string | null, archived = false): TeamNode => ({
  id,
  name,
  division,
  archived_at: archived ? "2026-09-01T00:00:00Z" : null,
  parent_id: null,
  kind: null,
  sort_order: null,
});

// After it: a node in the division → domain → team tree.
const node = (
  id: string,
  name: string,
  kind: "division" | "domain" | "team",
  parent_id: string | null,
  sort_order: number | null = null,
): TeamNode => ({ id, name, kind, parent_id, sort_order, archived_at: null, division: null });

const everyTeam = () => true;

const checkin = (
  team_id: string | null,
  week_start: string,
  scores: [number, number, number] | null,
): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

describe("buildHeatmap", () => {
  it("groups teams by their free-text division before the team tree, and fills every week", () => {
    const groups = buildHeatmap({
      teams: [team("g2", "Dinners", "Gather"), team("c1", "Atlas", "Culture"), team("g1", "Barbecues", "Gather")],
      checkins: [checkin("c1", "2026-10-05", [4, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.name)])).toEqual([
      ["Culture", ["Atlas"]],
      ["Gather", ["Barbecues", "Dinners"]],
    ]);
    const atlas = groups[0].rows[0];
    expect(atlas.cells.map((c) => c.week)).toEqual(WEEKS);
    expect(atlas.cells[0]).toEqual({ week: "2026-09-28", health: null, pending: 0 });
    expect(atlas.cells[1].health).toMatchObject({ band: "green", score: 12, graded: 1 });
  });

  it("averages a team's graded check-ins and counts the ones still waiting", () => {
    const [group] = buildHeatmap({
      teams: [team("t", "Atlas", "Culture")],
      checkins: [
        checkin("t", "2026-10-05", [4, 3, 3]),
        checkin("t", "2026-10-05", [3, 3, 3]),
        checkin("t", "2026-10-05", null),
      ],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(group.rows[0].cells[1]).toEqual({
      week: "2026-10-05",
      health: { band: "yellow", score: 10.5, graded: 2, bands: { green: 1, yellow: 1, red: 0 } },
      pending: 1,
    });
  });

  it("leaves out check-ins outside the weeks shown", () => {
    const [group] = buildHeatmap({
      teams: [team("t", "Atlas", "Culture")],
      checkins: [checkin("t", "2026-09-21", [1, 1, 1])],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(group.rows[0].cells.every((c) => c.health === null && c.pending === 0)).toBe(true);
  });

  it("shows an archived team only while it has check-ins in range, and marks it", () => {
    const teams = [team("a", "Old team", "Culture", true), team("b", "Atlas", "Culture")];
    const without = buildHeatmap({ teams, checkins: [], weeks: WEEKS, config: RULES, showEmpty: everyTeam });
    expect(without[0].rows.map((r) => r.name)).toEqual(["Atlas"]);

    const withHistory = buildHeatmap({
      teams,
      checkins: [checkin("a", "2026-09-28", [3, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(withHistory[0].rows.map((r) => [r.name, r.archived])).toEqual([
      ["Atlas", false],
      ["Old team", true],
    ]);
  });

  it("adds rows for check-ins with no team, or a team the viewer can't see, after the divisions", () => {
    const groups = buildHeatmap({
      teams: [team("t", "Atlas", "Culture")],
      checkins: [checkin(null, "2026-10-05", [3, 3, 3]), checkin("gone", "2026-09-28", [2, 2, 2])],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(groups.map((g) => g.label)).toEqual(["Culture", null]);
    expect(groups[1].rows.map((r) => [r.teamId, r.name])).toEqual([
      ["gone", "Earlier team"],
      [null, "No team"],
    ]);
  });

  it("puts teams without a division in the last group", () => {
    const groups = buildHeatmap({
      teams: [team("x", "Loose", null), team("t", "Atlas", "Culture")],
      checkins: [],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(groups.map((g) => g.label)).toEqual(["Culture", null]);
  });

  it("returns no groups when the viewer can see no teams or check-ins", () => {
    expect(buildHeatmap({ teams: [], checkins: [], weeks: WEEKS, config: RULES, showEmpty: everyTeam })).toEqual([]);
  });

  it("groups by the division at the root of the team tree, in org-chart order", () => {
    const teams = [
      node("hq", "HQ", "division", null, 3),
      node("ga", "Gather", "division", null, 1),
      node("ip", "IP", "domain", "ga", 2),
      node("at", "Atlas", "domain", "ga", 1),
      node("ip1", "IP.1", "team", "ip", 1),
      node("ip2", "Barbecues", "team", "ip", 2),
      node("ops", "Ops", "domain", "hq"),
    ];
    const groups = buildHeatmap({ teams, checkins: [], weeks: WEEKS, config: RULES, showEmpty: everyTeam });
    expect(groups.map((g) => [g.label, g.rows.map((r) => [r.name, r.depth])])).toEqual([
      [
        "Gather",
        [
          ["Atlas", 0],
          ["IP", 0],
          ["IP.1", 1],
          ["Barbecues", 1],
        ],
      ],
      ["HQ", [["Ops", 0]]],
    ]);
  });

  it("never gives a division an empty row, but shows check-ins filed against one", () => {
    const teams = [node("ga", "Gather", "division", null), node("ip", "IP", "domain", "ga")];
    const empty = buildHeatmap({ teams, checkins: [], weeks: WEEKS, config: RULES, showEmpty: everyTeam });
    expect(empty[0].rows.map((r) => r.name)).toEqual(["IP"]);

    const filed = buildHeatmap({
      teams,
      checkins: [checkin("ga", "2026-10-05", [3, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(filed[0].rows.map((r) => r.name)).toEqual(["Gather", "IP"]);
  });

  it("puts a team whose division the viewer can't see under Other", () => {
    // A leader sees their own domain, not necessarily the division above it.
    const groups = buildHeatmap({
      teams: [node("ip", "IP", "domain", "ga"), node("ip1", "IP.1", "team", "ip")],
      checkins: [],
      weeks: WEEKS,
      config: RULES,
      showEmpty: everyTeam,
    });
    expect(groups.map((g) => [g.label, g.rows.map((r) => [r.name, r.depth])])).toEqual([
      [
        null,
        [
          ["IP", 0],
          ["IP.1", 1],
        ],
      ],
    ]);
  });

  it("lists only the teams showEmpty allows, plus any team with check-ins", () => {
    // An admin who isn't hq sees every team, but only their own team's check-ins.
    const groups = buildHeatmap({
      teams: [team("mine", "Atlas", "Culture"), team("other", "Barbecues", "Culture"), team("busy", "Dinners", "Gather")],
      checkins: [checkin("busy", "2026-10-05", [3, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      showEmpty: (id) => id === "mine",
    });
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.name)])).toEqual([
      ["Culture", ["Atlas"]],
      ["Gather", ["Dinners"]],
    ]);
  });
});
